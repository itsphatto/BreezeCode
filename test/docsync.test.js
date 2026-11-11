// docsync.ts, the per-buffer engine wiring, against a fake engine (no exe needed). editcore, doccore and docsync load
// into one context, as breeze.html loads them; the globals docsync names (api, buffers, toast, ...) are stubs here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const src = f => stripTypeScriptTypes(fs.readFileSync(require.resolve('../src/renderer/' + f), 'utf8'));
const FILES = ['editcore.ts', 'doccore.ts', 'breeze/docsync.ts'].map(f => [f, src(f)]);
const tick = () => new Promise(r => setImmediate(r));
const wait = ms => new Promise(r => setTimeout(r, ms));

// A fake engine: documents hold their text as the page shows it (`\n` breaks, no BOM). Like engine/src/doc.rs `edit`,
// it drops every `\r` in edit text. `disk` is the files; save writes a document's text there.
function harness({ editDelay = 0, eol = '\n' } = {}) {
  const disk = new Map(), docs = new Map(), calls = [], toasts = [], writes = [];
  let nextId = 1, down = null;
  const hooks = { open: null, edit: null, lines: null };
  const doc = id => { const d = docs.get(id); if (!d || d.dead) throw new Error('The engine stopped'); return d; };
  const state = d => ({ rev: 0, lines: hooks.lines ? hooks.lines(d) : d.text.split('\n').length, dirty: true });
  const at = (text, p) => {
    const lines = text.split('\n');
    const line = Math.min(p.line, lines.length - 1);
    let off = 0;
    for (let i = 0; i < line; i++) off += lines[i].length + 1;
    return off + (p.line > line ? lines[line].length : Math.min(p.col, lines[line].length));
  };
  const api = {
    doc: {
      async open(path) {
        calls.push(['open', path]);
        if (hooks.open) await hooks.open(path);
        if (!disk.has(path)) throw new Error('not found');
        const id = nextId++, text = disk.get(path);
        docs.set(id, { path, text, dead: false, closed: false });
        return { doc: id, ...state(docs.get(id)), bytes: Buffer.byteLength(text), eol, readOnly: false, recovered: false };
      },
      async text(id) { const d = doc(id); return { ...state(d), text: d.text }; },
      async edit(id, start, end, text, kind) {
        calls.push(['edit', id, start, end, text, kind]);
        if (editDelay) await wait(editDelay);
        if (hooks.edit) await hooks.edit(id, start, end, text);
        const d = doc(id);
        const a = at(d.text, start), z = at(d.text, end);
        d.text = d.text.slice(0, a) + text.replaceAll('\r', '') + d.text.slice(z);
        return { ...state(d), caret: start };
      },
      async save(id) { const d = doc(id); calls.push(['save', id, d.text]); disk.set(d.path, d.text); return { ...state(d), bytes: d.text.length }; },
      async close(id) { calls.push(['close', id]); const d = docs.get(id); if (d) d.closed = true; },
      onDown(cb) { down = cb; },
    },
    fs: { async writeFile(path, text) { writes.push([path, text]); disk.set(path, text); } },
  };
  const buffers = new Map();
  const ctx = vm.createContext({
    api, buffers,
    toast: m => toasts.push(m),
    errMsg: e => (e && e.message) || String(e),
    baseName: p => p.split('/').pop(),
  });
  for (const [f, code] of FILES) vm.runInContext(code, ctx, { filename: f });
  const g = name => vm.runInContext(name, ctx);
  // A text buffer as readBuffer makes it, in `buffers` and on disk.
  const buffer = (path, text, extra = {}) => {
    const b = { path, size: text.length, kind: 'text', eol: '\n', text, saved: text, ta: null, undo: [], redo: [], lastEdit: null, ...extra };
    disk.set(path, text);
    buffers.set(path, b);
    return b;
  };
  return { api, buffers, disk, docs, calls, toasts, writes, hooks, g, buffer, fireDown: () => { for (const d of docs.values()) d.dead = true; down(); } };
}
// Changes the buffer's text the way a writer does: b.text first, then docSync.
const change = (h, b, text) => { const before = b.text; b.text = text; h.g('docSync')(b, before, b.text); };
const wholes = h => h.calls.filter(c => c[0] === 'edit' && c[2].line === 0 && c[2].col === 0 && c[3].line === 2147483647);

test('docOpen attaches a document and the queue follows edits', async () => {
  const h = harness();
  const b = h.buffer('a.txt', 'one\ntwo');
  await h.g('docOpen')(b, null);
  assert.equal(typeof b.doc, 'number');
  change(h, b, 'one\nTWO');
  await h.g('docFlush')(b);
  assert.equal(h.docs.get(b.doc).text, 'one\nTWO');
});

test('docSave with edits queued saves the text the engine holds then, and returns exactly it', async () => {
  const h = harness({ editDelay: 5 });
  const b = h.buffer('a.txt', 'a');
  await h.g('docOpen')(b, 'a');
  change(h, b, 'ab'); change(h, b, 'abc');
  const saving = h.g('docSave')(b);
  await tick();
  change(h, b, 'abcd'); // typed during the wait: the save waits for it too
  const t = await saving;
  const save = h.calls.find(c => c[0] === 'save');
  assert.equal(save[2], t); // the engine held exactly the returned text when save was called
  assert.equal(t, 'abcd');
  assert.equal(h.disk.get('a.txt'), 'abcd');
});

test('docSave across an engine restart (onDown swaps the queue mid-save) saves the right text', async () => {
  const h = harness({ editDelay: 5 });
  const b = h.buffer('a.txt', 'x\ny');
  await h.g('docOpen')(b, 'x\ny');
  const first = b.doc;
  change(h, b, 'x\nyz');
  const saving = h.g('docSave')(b);
  await tick();
  h.fireDown(); // the engine stopped: every document reopens and is brought to the page's text
  change(h, b, 'x\nyz!');
  const t = await saving;
  assert.notEqual(b.doc, first);
  assert.equal(t, 'x\nyz!');
  const save = h.calls.find(c => c[0] === 'save');
  assert.equal(save[1], b.doc);
  assert.equal(save[2], t);
  assert.equal(h.disk.get('a.txt'), 'x\nyz!');
});

test('the line-count backstop resyncs at most once and still saves', async () => {
  const h = harness();
  const b = h.buffer('a.txt', 'a\nb');
  await h.g('docOpen')(b, 'a\nb');
  h.hooks.lines = () => 99; // the engine's count never matches
  h.hooks.edit = () => { if (wholes(h).length > 3) throw new Error('resyncing forever'); }; // fail, don't hang
  b.text = 'a\nb\nc'; // a writer that missed docSync
  const t = await h.g('docSave')(b);
  assert.equal(wholes(h).length, 1);
  assert.equal(t, 'a\nb\nc');
  assert.equal(h.disk.get('a.txt'), 'a\nb\nc');
});

test('a dropped queue makes docSave write the old way, with the line ending and BOM, and return the text written', async () => {
  const h = harness({ eol: '\r\n' });
  const b = h.buffer('a.txt', 'a\nb', { bom: true });
  await h.g('docOpen')(b, 'a\nb');
  h.hooks.edit = () => { throw new Error('boom'); }; // edits and the resync both fail
  change(h, b, 'a\nbc');
  const t = await h.g('docSave')(b);
  assert.equal(b.doc, undefined); assert.equal(b.docSkip, true);
  assert.deepEqual(h.writes, [['a.txt', '﻿a\r\nbc']]);
  assert.equal(t, 'a\nbc');
  assert.equal(h.calls.some(c => c[0] === 'save'), false);
  assert.match(h.toasts[0], /Couldn't keep a\.txt in the engine/);
});

test('a close during an open in flight leaves no document', async () => {
  const h = harness();
  const b = h.buffer('a.txt', 'a');
  let go; h.hooks.open = () => new Promise(r => { go = r; });
  const opening = h.g('docOpen')(b, null);
  await tick();
  h.g('docClose')(b);
  go();
  await opening;
  assert.equal(b.doc, undefined); assert.equal(b.docQ, undefined);
  assert.ok(h.calls.some(c => c[0] === 'close' && c[1] === 1)); // the late reply's document is closed
});

test('a move during an open in flight does not attach a document for the old path', async () => {
  const h = harness();
  const b = h.buffer('a.txt', 'a');
  let go; h.hooks.open = () => new Promise(r => { go = r; });
  const opening = h.g('docOpen')(b, null);
  await tick();
  // moveEntry: the buffer takes its new path, still the same buffer in `buffers`
  h.buffers.delete(b.path); b.path = 'b.txt'; h.buffers.set(b.path, b);
  go();
  await opening;
  assert.equal(b.doc, undefined);
  assert.ok(h.calls.some(c => c[0] === 'close' && c[1] === 1));
});

test('a buffer opened with a lone \\r gets no document and saves the old way, exactly', async () => {
  const h = harness();
  const b = h.buffer('a.txt', 'a\rb\nc');
  assert.equal(await h.g('docOpenFirst')(b, 6), null);
  assert.equal(b.doc, undefined); assert.equal(b.docSkip, true);
  assert.ok(h.calls.some(c => c[0] === 'close' && c[1] === 1));
  change(h, b, 'b\nc'); change(h, b, 'a\rb\nc'); // delete line 1, undo
  const t = await h.g('docSave')(b);
  assert.deepEqual(h.writes, [['a.txt', 'a\rb\nc']]);
  assert.equal(t, 'a\rb\nc');
});

test('a draft with a lone \\r opened at its first save gets no document either', async () => {
  const h = harness();
  const b = h.buffer('a.txt', 'x\ry');
  h.disk.set('a.txt', ''); // fs:createFile made it empty
  await h.g('docOpen')(b, null);
  assert.equal(b.doc, undefined); assert.equal(b.docSkip, true);
  assert.equal(h.calls.filter(c => c[0] === 'edit').length, 0);
});

test('a docSync whose edit holds a \\r drops the document, and the next save writes the exact text the old way', async () => {
  const h = harness();
  const b = h.buffer('a.txt', 'a\nb');
  await h.g('docOpen')(b, 'a\nb');
  const id = b.doc;
  change(h, b, 'a\rX\nb');
  assert.equal(b.doc, undefined); assert.equal(b.docSkip, true);
  assert.ok(h.calls.some(c => c[0] === 'close' && c[1] === id));
  assert.equal(h.calls.some(c => c[0] === 'edit' && c[4].includes('\r')), false);
  const t = await h.g('docSave')(b);
  assert.deepEqual(h.writes, [['a.txt', 'a\rX\nb']]);
  assert.equal(t, 'a\rX\nb');
});

test('the save backstop never sends a \\r: the document is dropped and the text written the old way', async () => {
  const h = harness();
  const b = h.buffer('a.txt', 'a\nb');
  await h.g('docOpen')(b, 'a\nb');
  b.text = 'a\r\nb\nc'; // a writer that missed docSync put a \r in
  const t = await h.g('docSave')(b);
  assert.equal(h.calls.some(c => c[0] === 'edit' && c[4].includes('\r')), false);
  assert.equal(b.docSkip, true);
  assert.deepEqual(h.writes, [['a.txt', 'a\r\nb\nc']]);
  assert.equal(t, 'a\r\nb\nc');
});

test('a resync never sends a \\r', async () => {
  const h = harness();
  const b = h.buffer('a.txt', 'a\nb');
  await h.g('docOpen')(b, 'a\nb');
  let fail = true;
  h.hooks.edit = () => { if (fail) { fail = false; throw new Error('boom'); } }; // the edit fails: the queue resyncs b.text
  change(h, b, 'a\nbc');
  b.text = 'a\rq\nbc'; // a writer that missed docSync, before the resync reads b.text
  await h.g('docFlush')(b);
  assert.equal(h.calls.some(c => c[0] === 'edit' && c[4].includes('\r')), false);
  assert.equal(b.doc, undefined); assert.equal(b.docSkip, true);
});
