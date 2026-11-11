const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { Engine } = require('../src/main/engine.js');

const ctx = vm.createContext({});
// doccore uses lineStartsOf and textEdit from editcore, so both load into one context, editcore first.
for (const f of ['editcore.ts', 'doccore.ts']) vm.runInContext(stripTypeScriptTypes(fs.readFileSync(require.resolve('../src/renderer/' + f), 'utf8')), ctx);
const { docEditsFor, stripBom } = vm.runInContext('({ docEditsFor, stripBom })', ctx);

const exe = path.join(__dirname, '..', 'runtime', process.platform === 'win32' ? 'breeze-engine.exe' : 'breeze-engine');
const skip = fs.existsSync(exe) ? false : 'engine not built: run npm run build:engine';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-docsync-'));

// Writes `fileText`, opens it in the engine, applies the edits docEditsFor gives for `after` (the page text),
// saves, and checks the file's bytes and the engine's line count.
async function roundTrip(fileText, after, expected, textEdits = null) {
  const dir = tmp(), file = path.join(dir, 'f.txt');
  fs.writeFileSync(file, fileText);
  const e = new Engine({ exe, journalDir: path.join(dir, 'j') });
  try {
    const { doc } = await e.request('open', { path: file });
    const before = stripBom(fileText).replaceAll('\r\n', '\n');   // what readBuffer shows the page
    const edits = docEditsFor(before, after, textEdits);
    assert.ok(edits.length > 0, 'the change produced edits');
    let last;
    for (const ed of edits) last = await e.request('edit', { doc, start: ed.start, end: ed.end, text: ed.text, kind: 'other' });
    assert.equal(last.lines, after.split('\n').length);
    await e.request('save', { doc });
    assert.deepEqual(fs.readFileSync(file), Buffer.from(expected, 'utf8'));
  } finally { e.stop(); }
}

test('lf', { skip }, () => roundTrip('a\nb', 'a\nXb', 'a\nXb'));
test('crlf: a new line gets CRLF', { skip }, () => roundTrip('a\r\nb', 'a\nnew\nb', 'a\r\nnew\r\nb'));
test('mixed endings stay mixed', { skip }, () => roundTrip('a\r\nb\nc', 'a\nb\ncZ', 'a\r\nb\ncZ'));
test('bom', { skip }, () => roundTrip('﻿ab', 'aXb', '﻿aXb'));
test('emoji', { skip }, () => roundTrip('😀a', '😀Xa', '😀Xa'));
test('lone-cr untouched', { skip }, () => roundTrip('a\rb\nc', 'a\rb\ncZ', 'a\rb\ncZ'));
test('several edits in one change', { skip }, () =>
  roundTrip('a\nb\nc', 'xa\nxb\nxc', 'xa\nxb\nxc', [{ start: 0, end: 0, text: 'x' }, { start: 2, end: 2, text: 'x' }, { start: 4, end: 4, text: 'x' }]));
