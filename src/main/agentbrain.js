// The local LLM agent's working memory: what goes into each request, and the text formats of its file tools.
// Plain functions with no Electron, so test/agentbrain.test.js can cover them.
const path = require('node:path');

// A rough token count (about 3.5 characters per token for code and English). Good enough to budget with.
const tokensOf = text => Math.ceil(String(text ?? '').length / 3.5);
function messageTokens(m) {
  let n = 4 + tokensOf(m.content);
  for (const c of m.tool_calls || []) n += 4 + tokensOf(c.function?.name) + tokensOf(c.function?.arguments);
  return n;
}
const historyTokens = messages => messages.reduce((n, m) => n + messageTokens(m), 0);

/* ----- Project map: one line per folder, shallow folders first, cut to fit ----- */
function projectMap(relFiles, maxChars = 2400) {
  const dirs = new Map();
  for (const f of relFiles) {
    const d = path.posix.dirname(f);
    if (!dirs.has(d)) dirs.set(d, []);
    dirs.get(d).push(path.posix.basename(f));
  }
  const depth = d => (d === '.' ? 0 : d.split('/').length);
  const keys = [...dirs.keys()].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  const lines = [];
  let used = 0;
  for (const d of keys) {
    const names = dirs.get(d).sort();
    const list = names.length > 12 ? `${names.slice(0, 12).join(', ')}, … (+${names.length - 12} more)` : names.join(', ');
    const line = `${d === '.' ? './' : `${d}/`}: ${list}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length < keys.length) lines.push(`… and ${keys.length - lines.length} more folders (use list_files)`);
  return lines.join('\n');
}

/* ----- read_file: numbered lines, a window at a time ----- */
const READ_LINES = 120;      // lines returned when no end_line is given
const READ_MAX_LINES = 400;  // most lines one call may return
const LINE_MAX = 400;        // longer lines (minified code) are cut
function readRange(text, rel, start, end) {
  const lines = String(text).split(/\r?\n/);
  const total = lines.length;
  const from = Math.min(Math.max(1, Math.floor(Number(start) || 1)), total);
  const asked = Math.floor(Number(end) || 0);
  const to = Math.min(total, from + READ_MAX_LINES - 1, asked >= from ? asked : from + READ_LINES - 1);
  const body = lines.slice(from - 1, to).map((l, i) => `${from + i}| ${l.length > LINE_MAX ? `${l.slice(0, LINE_MAX)}…` : l}`);
  const more = to < total ? ` (more: read_file with start_line=${to + 1})` : '';
  return `${rel} lines ${from}-${to} of ${total}${more}\n${body.join('\n')}`;
}

/* ----- edit_file: replace one exact snippet ----- */
// Small models often paste the "12| " prefixes from read_file back in; those are removed when every line has one.
function stripLineNumbers(s) {
  const lines = String(s).split('\n');
  const numbered = /^\s*\d+\| ?/;
  return lines.filter(l => l.trim()).every(l => numbered.test(l)) ? lines.map(l => l.replace(numbered, '')).join('\n') : String(s);
}
// Returns the new text and the line the change starts on; throws with advice the model can act on.
function applyEdit(text, oldText, newText) {
  const src = String(text);
  const crlf = src.includes('\r\n');
  const body = src.replace(/\r\n/g, '\n');
  const find = stripLineNumbers(String(oldText ?? '').replace(/\r\n/g, '\n'));
  const repl = stripLineNumbers(String(newText ?? '').replace(/\r\n/g, '\n'));
  if (!find) throw new Error('old_text is empty. To create a file use write_file.');
  const at = body.indexOf(find);
  if (at === -1) throw new Error('old_text was not found. read_file the lines again and copy them exactly (without the line numbers).');
  const count = body.split(find).length - 1;
  if (count > 1) throw new Error(`old_text matches ${count} places. Add a few surrounding lines so it matches only one.`);
  const out = body.slice(0, at) + repl + body.slice(at + find.length);
  return { text: crlf ? out.replace(/\n/g, '\r\n') : out, line: body.slice(0, at).split('\n').length };
}

/* ----- search_files: hits grouped by file ----- */
function formatHits(hits, max = 40) {
  if (!hits.length) return 'No matches.';
  const byFile = new Map();
  for (const h of hits.slice(0, max)) {
    if (!byFile.has(h.path)) byFile.set(h.path, []);
    const t = h.text.trim();
    byFile.get(h.path).push(`  ${h.line + 1}: ${t.length > 160 ? `${t.slice(0, 160)}…` : t}`);
  }
  const out = [...byFile].map(([f, lines]) => `${f}\n${lines.join('\n')}`);
  if (hits.length > max) out.push(`… ${hits.length - max} more matches. Search for something more specific.`);
  return out.join('\n');
}

// Where search_files looks: a folder or file ("src/main"), a file name pattern ("*.css") anywhere, or a
// pattern on the whole path ("src/**/*.ts"). Returns a test on project-relative paths with forward slashes.
function pathFilter(pattern) {
  const p = String(pattern ?? '').trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!p || p === '.') return () => true;
  if (!/[*?]/.test(p)) {
    const want = p.toLowerCase();
    return rel => { const r = rel.toLowerCase(); return r === want || r.startsWith(`${want}/`); };
  }
  const glob = p.split(/(\*\*\/|\*\*|\*|\?)/).map(part => ({ '**/': '(?:.*/)?', '**': '.*', '*': '[^/]*', '?': '[^/]' })[part]
    ?? part.replace(/[.+^${}()|[\]\\]/g, String.raw`\$&`)).join('');
  const re = new RegExp(`^${glob}$`, 'i');
  return p.includes('/') ? rel => re.test(rel) : rel => re.test(rel.slice(rel.lastIndexOf('/') + 1));
}
// What search_files looks for: a function from a line to the column of the first match, or -1.
function lineMatcher(query, { regex = false, caseSensitive = false } = {}) {
  const q = String(query ?? '');
  if (!q) throw new Error('query is empty.');
  if (regex) {
    let re;
    try { re = new RegExp(q, caseSensitive ? '' : 'i'); } catch (err) { throw new Error(`That regex doesn't work (${err.message}). Fix it, or search for plain text.`); }
    return line => re.exec(line)?.index ?? -1;
  }
  const needle = caseSensitive ? q : q.toLowerCase();
  return line => (caseSensitive ? line : line.toLowerCase()).indexOf(needle);
}

/* ----- A streamed reply (server-sent events from /chat/completions) ----- */
// push() takes the body as it arrives, in pieces of any size; end() gives the reply in the shape a reply that
// wasn't streamed has. `onDelta(text, thinking, calls)` hears the text so far, whether the model thought in a
// separate field (Ollama, LM Studio and llama.cpp send it as reasoning or reasoning_content), and the tool
// calls so far, their arguments maybe cut off mid-way.
function replyReader(onDelta = () => {}, newId = () => 'call_0') {
  const calls = [];
  let buf = '', text = '', thinking = false, usage;
  const take = data => {
    if (data === '[DONE]') return;
    let j;
    try { j = JSON.parse(data); } catch { return; }
    if (j.error) throw new Error(j.error.message || String(j.error));
    if (j.usage) usage = j.usage;
    const d = j.choices?.[0]?.delta;
    if (!d) return;
    if (d.reasoning || d.reasoning_content) thinking = true;
    for (const c of d.tool_calls || []) {
      const call = calls[c.index ?? calls.length] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (c.id) call.id = c.id;
      call.function.name ||= c.function?.name ?? '';
      call.function.arguments += c.function?.arguments ?? '';
    }
    if (d.content) text += d.content;
    onDelta(text, thinking, calls);
  };
  const line = l => { const t = l.trim(); if (t.startsWith('data:')) take(t.slice(5).trim()); };
  return {
    push(piece) {
      buf += piece;
      for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
        line(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    },
    end() {
      line(buf);
      buf = '';
      const toolCalls = calls.filter(c => c?.function.name).map(c => ({ ...c, id: c.id || newId() }));
      return { usage, choices: [{ message: { content: text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } }] };
    },
  };
}

// One string field of a tool call's arguments while they are still arriving: { text, done }, or null before
// the field starts. A half-sent escape at the end is left for the next piece.
const ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
function partialString(json, key) {
  const src = String(json ?? '');
  const m = new RegExp(String.raw`"${key}"\s*:\s*"`).exec(src);
  if (!m) return null;
  let text = '';
  for (let i = m.index + m[0].length; i < src.length;) {
    const ch = src[i];
    if (ch === '"') return { text, done: true };
    if (ch !== '\\') { text += ch; i++; continue; }
    const e = src[i + 1];
    if (e === undefined) break;
    if (e === 'u') {
      const hex = src.slice(i + 2, i + 6);
      if (!/^[0-9a-f]{4}$/i.test(hex)) break;
      text += String.fromCharCode(Number.parseInt(hex, 16));
      i += 6;
    } else {
      text += ESCAPES[e] ?? e;
      i += 2;
    }
  }
  return { text, done: false };
}

/* ----- Repeated calls ----- */
// The same tool with the same arguments, whatever the key order.
function callKey(name, args) {
  const sort = v => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v);
  return `${name}:${JSON.stringify(sort(args ?? {}))}`;
}

/* ----- Context budget ----- */
const WRITE_FIELDS = ['content', 'new_text', 'old_text'];
// A tool call's arguments with the bulky text fields replaced by their size: the change is on disk already.
function slimArgs(json) {
  let a;
  try { a = JSON.parse(json || '{}'); } catch { return json; }
  let changed = false;
  for (const k of WRITE_FIELDS) {
    if (typeof a[k] === 'string' && a[k].length > 120) { a[k] = `(${a[k].length} characters, already applied)`; changed = true; }
  }
  return changed ? JSON.stringify(a) : json;
}
function toolNames(messages) {
  const names = new Map();
  for (const m of messages) for (const c of m.tool_calls || []) names.set(c.id, `${c.function?.name ?? 'tool'} ${slimArgs(c.function?.arguments)}`);
  return names;
}
function stub(m, names) {
  const first = String(m.content ?? '').split('\n', 1)[0].slice(0, 100);
  return { ...m, content: `[Trimmed to save context. It was ${names.get(m.tool_call_id) ?? 'a tool call'}, starting: ${first}. Call the tool again if you need it.]` };
}
function slim(m) {
  if (!m.tool_calls) return m;
  return { ...m, tool_calls: m.tool_calls.map(c => ({ ...c, function: { ...c.function, arguments: slimArgs(c.function?.arguments) } })) };
}
// Earlier turns keep the conversation but not the raw tool output: what the model concluded is in its replies.
function settle(messages, upTo = messages.length) {
  const names = toolNames(messages);
  return messages.map((m, i) => (i >= upTo ? m : m.role === 'tool' ? (m.content?.startsWith('[Trimmed') ? m : stub(m, names)) : slim(m)));
}
// What one request sends: the system prompt, earlier turns settled, then the current turn. While it is over
// `budget` tokens the oldest tool results of this turn are trimmed (the newest two stay), then whole early
// exchanges are dropped, and last of all the newest results are cut short.
function compactHistory(messages, budget) {
  const lastUser = messages.map(m => m.role).lastIndexOf('user');
  let out = settle(messages, Math.max(1, lastUser));
  if (historyTokens(out) <= budget) return out;
  const names = toolNames(messages);
  const toolIdx = out.map((m, i) => (i > lastUser && m.role === 'tool' ? i : -1)).filter(i => i !== -1);
  for (const i of toolIdx.slice(0, -2)) {
    if (historyTokens(out) <= budget) return out;
    out[i] = stub(out[i], names);
  }
  // Drop the oldest exchange after the system prompt, with its tool replies, until it fits or only this turn is left.
  while (historyTokens(out) > budget && out.length > 2 && out.map(m => m.role).lastIndexOf('user') > 1) {
    let n = 1;
    if (out[1].tool_calls) while (out[1 + n]?.role === 'tool') n++;
    out.splice(1, n);
  }
  // Still too big: the newest tool results get cut, newest last.
  const CUT_NOTE = '\n[… cut to fit the context. Read a smaller range.]';
  for (const i of out.map((m, k) => (m.role === 'tool' ? k : -1)).filter(k => k !== -1)) {
    const over = historyTokens(out) - budget;
    if (over <= 0) break;
    const len = String(out[i].content).length;
    const keep = Math.max(400, len - Math.ceil(over * 3.5) - CUT_NOTE.length - 8);
    if (keep < len) out[i] = { ...out[i], content: `${String(out[i].content).slice(0, keep)}${CUT_NOTE}` };
  }
  return out;
}

module.exports = {
  tokensOf, messageTokens, historyTokens, projectMap, readRange, stripLineNumbers, applyEdit, formatHits, pathFilter, lineMatcher, replyReader, partialString, callKey,
  slimArgs, settle, compactHistory, READ_LINES, READ_MAX_LINES,
};
