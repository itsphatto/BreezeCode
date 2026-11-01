const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const vm = require('node:vm');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { CdpClient, fileUrl, urlRegexFor, cdpCondition, checkExpr, checkBp, valueOf, framesOf } = require('../src/main/cdp');

// An open socket stand-in: what the client sends lands in `sent`; `receive` plays a frame from the inspector.
class FakeSocket extends EventTarget {
  constructor() { super(); this.sent = []; this.closed = false; }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; this.dispatchEvent(new Event('close')); }
  receive(data) { this.dispatchEvent(Object.assign(new Event('message'), { data })); }
  reply(msg) { this.receive(JSON.stringify(msg)); }
}
const tick = () => new Promise(r => setImmediate(r));

// ---- fileUrl / urlRegexFor ----

const WIN = 'C:\\Users\\me\\Breeze Code\\a.js';
const WIN_URL = 'file:///C:/Users/me/Breeze%20Code/a.js';
const onWin = process.platform === 'win32' ? test : test.skip;

onWin('fileUrl encodes spaces and uses forward slashes', () => {
  assert.equal(fileUrl(WIN), WIN_URL);
  assert.equal(fileUrl(WIN), pathToFileURL(WIN).href);
});

onWin('urlRegexFor matches the URL Node reports, case-insensitively, as V8 compiles it (no flags)', () => {
  const re = new RegExp(urlRegexFor(WIN)); // V8 applies urlRegex case-sensitively: the source must carry the folding
  assert.ok(re.test(WIN_URL));
  assert.ok(re.test('file:///c:/Users/me/Breeze%20Code/a.js'), 'lower-case drive');
  assert.ok(re.test('file:///C:/users/ME/breeze%20code/A.JS'), 'path case');
  assert.ok(new RegExp(urlRegexFor(WIN), 'i').test(WIN_URL));
  assert.ok(re.test(WIN), 'raw path');
  assert.ok(re.test('file:///C:/Users/me/Breeze Code/a.js'), 'unencoded space');
  assert.ok(!re.test('file:///C:/Users/me/Breeze%20Code/a.js.map'));
  assert.ok(!re.test('file:///C:/Users/me/Breeze%20Code/xa.js'));
  assert.ok(!re.test('file:///C:/Users/me/Breeze%20Code/b.js'));
});

onWin('urlRegexFor escapes regex metacharacters in the path', () => {
  const p = 'C:\\proj\\a+b (copy)\\x.test.js';
  const re = new RegExp(urlRegexFor(p));
  assert.ok(re.test(pathToFileURL(p).href));
  assert.ok(!re.test('file:///C:/proj/aab%20(copy)/x.test.js'), '+ is literal');
  assert.ok(!re.test(pathToFileURL('C:\\proj\\a+b (copy)\\xXtestXjs').href), '. is literal');
});

// ---- cdpCondition ----

// Runs the generated expression against a context; each call may set variables first.
function runner(bp, id = 1) {
  const logs = [];
  const ctx = vm.createContext({ console: { log: (...a) => logs.push(a.join(' ')) } });
  const expr = cdpCondition(bp, id);
  return { expr, logs, ctx, hit: (vars = {}) => { Object.assign(ctx, vars); return vm.runInContext(expr, ctx); } };
}

test('cdpCondition: plain breakpoint has no condition', () => {
  assert.equal(cdpCondition({ line: 1, enabled: true }, 1), '');
});

test('cdpCondition: a condition is parenthesised', () => {
  const r = runner({ line: 1, enabled: true, condition: 'x > 1' });
  assert.equal(r.hit({ x: 0 }), false);
  assert.equal(r.hit({ x: 2 }), true);
});

test('cdpCondition: a trailing // comment or ; in a condition cannot break it', () => {
  const c = runner({ line: 1, enabled: true, condition: 'i > 1 // c' });
  assert.equal(c.hit({ i: 0 }), false);
  assert.equal(c.hit({ i: 2 }), true);
  const s = runner({ line: 1, enabled: true, condition: 'i > 1;' });
  assert.equal(s.hit({ i: 0 }), false);
  assert.equal(s.hit({ i: 2 }), true);
  const both = runner({ line: 1, enabled: true, condition: 'i > 1; ', hitCondition: '2' });
  assert.equal(both.hit({ i: 5 }), false);
  assert.equal(both.hit({ i: 5 }), true);
});

test('cdpCondition: a comma expression stays one condition', () => {
  const r = runner({ line: 1, enabled: true, condition: 'a = 1, a > 0' });
  assert.equal(r.hit(), true);
});

test('cdpCondition: hitCondition >= 3 pauses from the third hit on', () => {
  const r = runner({ line: 1, enabled: true, hitCondition: '>= 3' });
  assert.deepEqual([1, 2, 3, 4].map(() => r.hit()), [false, false, true, true]);
});

test('cdpCondition: a bare number means >= n', () => {
  const r = runner({ line: 1, enabled: true, hitCondition: '2' });
  assert.deepEqual([1, 2, 3].map(() => r.hit()), [false, true, true]);
});

test('cdpCondition: > n, == n, and % n', () => {
  const gt = runner({ line: 1, enabled: true, hitCondition: '> 2' });
  assert.deepEqual([1, 2, 3, 4].map(() => gt.hit()), [false, false, true, true]);
  const eq = runner({ line: 1, enabled: true, hitCondition: '== 2' });
  assert.deepEqual([1, 2, 3].map(() => eq.hit()), [false, true, false]);
  const mod = runner({ line: 1, enabled: true, hitCondition: '% 3' });
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(() => mod.hit()), [false, false, true, false, false, true]);
});

test('cdpCondition: the hit count only counts hits where the condition held', () => {
  const r = runner({ line: 1, enabled: true, condition: 'x > 1', hitCondition: '% 2' });
  assert.equal(r.hit({ x: 0 }), false); // not counted
  assert.equal(r.hit({ x: 5 }), false); // 1st true hit
  assert.equal(r.hit({ x: 0 }), false); // not counted
  assert.equal(r.hit({ x: 5 }), true);  // 2nd true hit
  assert.equal(r.hit({ x: 5 }), false); // 3rd
  assert.equal(r.hit({ x: 5 }), true);  // 4th
});

test('cdpCondition: counters are per breakpoint id', () => {
  const ctx = vm.createContext({});
  const a = cdpCondition({ line: 1, enabled: true, hitCondition: '== 2' }, 1);
  const b = cdpCondition({ line: 9, enabled: true, hitCondition: '== 2' }, 2);
  const run = e => vm.runInContext(e, ctx);
  assert.deepEqual([run(a), run(b), run(a), run(b), run(a)], [false, false, true, true, false]);
});

test('cdpCondition: an unparseable hit condition is ignored rather than injected', () => {
  assert.equal(cdpCondition({ line: 1, enabled: true, hitCondition: '3); process.exit(' }, 1), '');
});

test('cdpCondition: a logpoint logs and never pauses', () => {
  const r = runner({ line: 1, enabled: true, logMessage: 'x is {x}' });
  assert.equal(r.hit({ x: 7 }), false);
  assert.equal(r.hit({ x: 8 }), false);
  assert.deepEqual(r.logs, ['x is 7', 'x is 8']);
});

test('cdpCondition: logMessage text is literal (backticks, ${, backslashes, quotes)', () => {
  const r = runner({ line: 1, enabled: true, logMessage: 'a`b $5 ${ c\\d "q" {1 + 2}' });
  assert.equal(r.hit(), false);
  assert.deepEqual(r.logs, ['a`b $5 ${ c\\d "q" 3']);
});

test('cdpCondition: empty or blank braces in a logMessage are literal text', () => {
  const a = runner({ line: 1, enabled: true, logMessage: 'state: {}' });
  assert.equal(a.hit(), false);
  assert.deepEqual(a.logs, ['state: {}']);
  const b = runner({ line: 1, enabled: true, logMessage: 'a { } b' });
  b.hit();
  assert.deepEqual(b.logs, ['a { } b']);
});

test('cdpCondition: a // comment inside {…} cannot swallow the closing', () => {
  const r = runner({ line: 1, enabled: true, logMessage: '{x // note}' });
  assert.equal(r.hit({ x: 5 }), false);
  assert.deepEqual(r.logs, ['5']);
});

test('cdpCondition: a throwing {expr} prints an error marker and the rest still logs', () => {
  const r = runner({ line: 1, enabled: true, logMessage: '{nope} ok {x}' });
  assert.equal(r.hit({ x: 3 }), false);
  assert.equal(r.logs.length, 1);
  assert.match(r.logs[0], /^<error: .*nope.*> ok 3$/);
});

test('cdpCondition: a logpoint honours its condition', () => {
  const r = runner({ line: 1, enabled: true, condition: 'x > 1', logMessage: 'x={x}' });
  assert.equal(r.hit({ x: 0 }), false);
  assert.equal(r.hit({ x: 2 }), false);
  assert.deepEqual(r.logs, ['x=2']);
});

// ---- checkExpr / checkBp ----

test('checkExpr: null for an expression that parses, a message for one that does not', () => {
  assert.equal(checkExpr('x > 1'), null);
  assert.equal(checkExpr('a = 1, a > 0'), null);
  assert.equal(checkExpr('x > 1 // trailing comment'), null);
  assert.equal(typeof checkExpr('x >'), 'string');
  assert.ok(checkExpr('x >').length > 0);
  assert.equal(typeof checkExpr('foo('), 'string');
  assert.equal(typeof checkExpr(''), 'string');
});

test('checkExpr: parses only, never runs the expression', () => {
  globalThis.__bzRan = false;
  assert.equal(checkExpr('(globalThis.__bzRan = true)'), null);
  assert.equal(globalThis.__bzRan, false);
  delete globalThis.__bzRan;
});

test('checkBp: a plain or valid breakpoint is fine', () => {
  assert.equal(checkBp({ line: 1, enabled: true }), null);
  assert.equal(checkBp({ line: 1, enabled: true, condition: 'i > 1;', hitCondition: '>= 3', logMessage: 'i={i} {}' }), null);
  assert.equal(checkBp({ line: 1, enabled: true, condition: '  ', hitCondition: ' ', logMessage: '' }), null);
});

test('checkBp: reports a bad condition', () => {
  assert.match(checkBp({ line: 1, enabled: true, condition: 'i >' }), /condition/i);
});

test('checkBp: reports a bad {expr} in the log message, and says which', () => {
  assert.match(checkBp({ line: 1, enabled: true, logMessage: 'ok {a} bad {b +}' }), /log message/i);
});

test('checkBp: reports a malformed hit condition', () => {
  for (const h of ['abc', '>=', '3); process.exit(', '>> 2', '1.5']) {
    assert.match(checkBp({ line: 1, enabled: true, hitCondition: h }) ?? '', /hit/i, h);
  }
  for (const h of ['3', '>= 3', '> 1', '== 2', '% 4', '=2']) assert.equal(checkBp({ line: 1, enabled: true, hitCondition: h }), null, h);
});

test('checkBp: the first problem wins (condition before log message before hit count)', () => {
  assert.match(checkBp({ line: 1, enabled: true, condition: 'x >', logMessage: '{y +}', hitCondition: 'zz' }), /condition/i);
  assert.match(checkBp({ line: 1, enabled: true, logMessage: '{y +}', hitCondition: 'zz' }), /log message/i);
});

// ---- valueOf ----

const noRef = () => { throw new Error('refFor must not be called'); };

test('valueOf: primitives', () => {
  assert.deepEqual(valueOf('n', { type: 'number', value: 42, description: '42' }, noRef), { name: 'n', value: '42', type: 'number', ref: 0 });
  assert.deepEqual(valueOf('b', { type: 'boolean', value: false }, noRef), { name: 'b', value: 'false', type: 'boolean', ref: 0 });
  assert.deepEqual(valueOf('u', { type: 'undefined' }, noRef), { name: 'u', value: 'undefined', type: 'undefined', ref: 0 });
  assert.deepEqual(valueOf('z', { type: 'object', subtype: 'null', value: null }, noRef), { name: 'z', value: 'null', type: 'null', ref: 0 });
});

test('valueOf: unserializable numbers and bigints use their text', () => {
  assert.equal(valueOf('x', { type: 'number', unserializableValue: 'NaN', description: 'NaN' }, noRef).value, 'NaN');
  assert.equal(valueOf('x', { type: 'number', unserializableValue: '-Infinity', description: '-Infinity' }, noRef).value, '-Infinity');
  assert.equal(valueOf('x', { type: 'bigint', unserializableValue: '10n', description: '10' }, noRef).value, '10n');
});

test('valueOf: strings are quoted and escaped', () => {
  assert.equal(valueOf('s', { type: 'string', value: 'hi' }, noRef).value, '"hi"');
  assert.equal(valueOf('s', { type: 'string', value: 'a"b\n' }, noRef).value, '"a\\"b\\n"');
});

test('valueOf: an object with an objectId is expandable through refFor', () => {
  const seen = [];
  const v = valueOf('o', { type: 'object', className: 'Object', description: 'Object', objectId: 'oid-1' }, id => { seen.push(id); return 7; });
  assert.deepEqual(v, { name: 'o', value: 'Object', type: 'object', ref: 7 });
  assert.deepEqual(seen, ['oid-1']);
  const arr = valueOf('a', { type: 'object', subtype: 'array', className: 'Array', description: 'Array(3)', objectId: 'oid-2' }, () => 9);
  assert.deepEqual(arr, { name: 'a', value: 'Array(3)', type: 'array', ref: 9 });
});

test('valueOf: a function shows its first line only and is expandable', () => {
  const v = valueOf('f', { type: 'function', className: 'Function', description: 'function f(a) {\n  return a;\n}', objectId: 'oid-3' }, () => 4);
  assert.equal(v.value, 'function f(a) {');
  assert.equal(v.type, 'function');
  assert.equal(v.ref, 4);
});

test('valueOf: an error shows its message line, not the stack', () => {
  const v = valueOf('e', { type: 'object', subtype: 'error', className: 'Error', description: 'Error: boom\n    at x (a.js:1:1)', objectId: 'oid-4' }, () => 5);
  assert.equal(v.value, 'Error: boom');
});

test('valueOf: an object with no description falls back to its class name', () => {
  assert.equal(valueOf('o', { type: 'object', className: 'Foo', objectId: 'o' }, () => 1).value, 'Foo');
});

// ---- framesOf ----

test('framesOf: maps locations to 1-based lines/columns, project-relative forward-slash files', () => {
  const root = path.resolve('proj');
  const url = pathToFileURL(path.join(root, 'src', 'my dir', 'a.js')).href;
  const scripts = new Map([['1', url], ['2', 'node:internal/timers']]);
  const frames = framesOf([
    { callFrameId: 'c0', functionName: 'work', location: { scriptId: '1', lineNumber: 9, columnNumber: 4 } },
    { callFrameId: 'c1', functionName: '', location: { scriptId: '1', lineNumber: 0, columnNumber: 0 } },
    { callFrameId: 'c2', functionName: 'listOnTimeout', location: { scriptId: '2', lineNumber: 5, columnNumber: 1 } },
  ], scripts, root);
  assert.deepEqual(frames, [
    { id: 0, name: 'work', file: 'src/my dir/a.js', line: 10, col: 5 },
    { id: 1, name: '(anonymous)', file: 'src/my dir/a.js', line: 1, col: 1 },
    { id: 2, name: 'listOnTimeout', file: null, line: 6, col: 2 },
  ]);
});

test('framesOf: a script outside the root, an unknown script, and a missing URL give file: null', () => {
  const root = path.resolve('proj');
  const outside = pathToFileURL(path.resolve('elsewhere', 'b.js')).href;
  const scripts = new Map([['1', outside], ['3', '']]);
  const loc = scriptId => ({ callFrameId: 'c', functionName: 'f', location: { scriptId, lineNumber: 0, columnNumber: 0 } });
  const frames = framesOf([loc('1'), loc('nope'), loc('3')], scripts, root);
  assert.deepEqual(frames.map(f => f.file), [null, null, null]);
});

test('framesOf: a sibling folder sharing the root as a name prefix is outside it', () => {
  const root = path.resolve('proj');
  const sibling = pathToFileURL(path.resolve('proj-other', 'c.js')).href;
  const [f] = framesOf([{ functionName: 'f', location: { scriptId: '1', lineNumber: 0, columnNumber: 0 } }], new Map([['1', sibling]]), root);
  assert.equal(f.file, null);
});

onWin('framesOf: matches the root case-insensitively on Windows', () => {
  const scripts = new Map([['1', 'file:///c:/users/me/breeze%20code/a.js']]);
  const [f] = framesOf([{ functionName: 'f', location: { scriptId: '1', lineNumber: 0, columnNumber: 0 } }], scripts, 'C:\\Users\\Me\\Breeze Code');
  assert.equal(f.file, 'a.js');
});

// ---- CdpClient ----

test('CdpClient.send: matches responses to requests by id and resolves the result', async () => {
  const sock = new FakeSocket();
  const c = new CdpClient(sock);
  const p1 = c.send('Runtime.evaluate', { expression: '1' });
  const p2 = c.send('Debugger.enable');
  assert.deepEqual(sock.sent.map(m => m.method), ['Runtime.evaluate', 'Debugger.enable']);
  assert.deepEqual(sock.sent[0].params, { expression: '1' });
  sock.reply({ id: sock.sent[1].id, result: { debuggerId: 'd' } });
  sock.reply({ id: sock.sent[0].id, result: { result: { type: 'number', value: 1 } } });
  assert.deepEqual(await p2, { debuggerId: 'd' });
  assert.deepEqual(await p1, { result: { type: 'number', value: 1 } });
});

test('CdpClient.send: a response with no result resolves {}', async () => {
  const sock = new FakeSocket();
  const c = new CdpClient(sock);
  const p = c.send('Debugger.resume');
  sock.reply({ id: sock.sent[0].id });
  assert.deepEqual(await p, {});
});

test('CdpClient.send: an error response rejects with its message', async () => {
  const sock = new FakeSocket();
  const c = new CdpClient(sock);
  const p = c.send('Debugger.setBreakpointByUrl', {});
  sock.reply({ id: sock.sent[0].id, error: { code: -32602, message: 'Invalid parameters' } });
  await assert.rejects(p, /Invalid parameters/);
});

test('CdpClient: events are emitted by method name with their params', async () => {
  const sock = new FakeSocket();
  const c = new CdpClient(sock);
  const got = [];
  c.on('Debugger.paused', p => got.push(p));
  sock.reply({ method: 'Debugger.paused', params: { reason: 'other', callFrames: [] } });
  sock.reply({ method: 'Debugger.resumed' });
  assert.deepEqual(got, [{ reason: 'other', callFrames: [] }]);
});

test('CdpClient: a malformed or non-object message warns and the next message still arrives', async () => {
  const sock = new FakeSocket();
  const c = new CdpClient(sock);
  const warns = [];
  c.on('warn', e => warns.push(e));
  const got = [];
  c.on('Debugger.resumed', () => got.push('resumed'));
  sock.receive('{not json');
  sock.receive('null');
  sock.receive('42');
  sock.receive(new Uint8Array([1, 2]));
  sock.reply({ method: 'Debugger.resumed' });
  assert.equal(warns.length, 4);
  assert.ok(warns.every(e => e instanceof Error));
  assert.deepEqual(got, ['resumed']);
});

test('CdpClient: a throwing event listener warns instead of escaping, and later messages are still handled', async () => {
  const sock = new FakeSocket();
  const c = new CdpClient(sock);
  const warns = [];
  c.on('warn', e => warns.push(e.message));
  c.on('Debugger.paused', () => { throw new Error('listener broke'); });
  const p = c.send('Debugger.enable');
  assert.doesNotThrow(() => sock.reply({ method: 'Debugger.paused', params: {} }));
  sock.reply({ id: sock.sent[0].id, result: { ok: 1 } });
  assert.deepEqual(await p, { ok: 1 });
  assert.deepEqual(warns, ['listener broke']);
});

test('CdpClient: an event whose name could collide with the client\'s own (error, close) is ignored', async () => {
  const sock = new FakeSocket();
  const c = new CdpClient(sock);
  let closes = 0;
  c.on('close', () => closes++);
  sock.reply({ method: 'close', params: {} });
  sock.reply({ method: 'error', params: {} });
  assert.equal(closes, 0);
});

test('CdpClient: unknown or stale response ids are ignored', async () => {
  const sock = new FakeSocket();
  const c = new CdpClient(sock);
  sock.reply({ id: 999, result: {} });
  const p = c.send('X.y');
  sock.reply({ id: sock.sent[0].id, result: { a: 1 } });
  sock.reply({ id: sock.sent[0].id, result: { a: 2 } });
  assert.deepEqual(await p, { a: 1 });
});

test('CdpClient.close: rejects pending sends, closes the socket, emits close once', async () => {
  const sock = new FakeSocket();
  const c = new CdpClient(sock);
  let closes = 0;
  c.on('close', () => closes++);
  const p = c.send('Debugger.enable');
  c.close();
  await assert.rejects(p, /closed/);
  assert.equal(sock.closed, true);
  c.close();
  assert.equal(closes, 1);
  await assert.rejects(c.send('Debugger.enable'), /closed/);
});

test('CdpClient: the socket closing from the other side rejects pending sends and emits close once', async () => {
  const sock = new FakeSocket();
  const c = new CdpClient(sock);
  let closes = 0;
  c.on('close', () => closes++);
  const p = c.send('Debugger.enable');
  sock.dispatchEvent(new Event('error'));
  sock.dispatchEvent(new Event('close'));
  await assert.rejects(p, /closed/);
  assert.equal(closes, 1);
});

test('CdpClient.send: params that cannot be serialized reject without leaving a pending entry', async () => {
  const sock = new FakeSocket();
  const c = new CdpClient(sock);
  await assert.rejects(c.send('X.y', { n: 1n }));
  assert.equal(c.pending.size, 0);
  assert.equal(sock.sent.length, 0);
});

test('CdpClient.send: a socket that throws on send rejects and leaves no pending entry', async () => {
  const sock = new FakeSocket();
  sock.send = () => { throw new Error('socket not open'); };
  const c = new CdpClient(sock);
  await assert.rejects(c.send('X.y'), /socket not open/);
  assert.equal(c.pending.size, 0);
});

test('CdpClient.connect: rejects when nothing is listening', async () => {
  const srv = net.createServer();
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise(r => srv.close(r));
  await assert.rejects(CdpClient.connect(`ws://127.0.0.1:${port}/none`));
  await tick();
});
