const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const dsh = require('../src/main/dsh');

test('dshArgs: Ask and Plan are read-only, Build stays in the project unless Full Access is on', () => {
  const mode = o => { const a = dsh.dshArgs({ patch: 'p.yml', ...o }); return a[a.indexOf('--permission-mode') + 1]; };
  assert.equal(mode({ mode: 'ask' }), 'read-only');
  assert.equal(mode({ mode: 'plan', full: true }), 'read-only'); // Full Access never widens Ask or Plan
  assert.equal(mode({ mode: 'anything else', full: true }), 'read-only');
  assert.equal(mode({ mode: 'build' }), 'workspace-write');
  assert.equal(mode({ mode: 'build', full: true }), 'danger-full-access');
});

test('dshArgs: the launcher flags come before the app flags, the prompt comes from stdin', () => {
  assert.deepEqual(dsh.dshArgs({ mode: 'build', patch: 'C:/a b/p.yml', session: 'session-1' }), ['--profile', 'headless', '--patch', 'C:/a b/p.yml', '--json',
    '--approval-policy', 'never', '--permission-mode', 'workspace-write', '--session-id', 'session-1', '-']);
  assert.ok(!dsh.dshArgs({ mode: 'ask', patch: 'p' }).includes('--session-id'));
});

test('dshEnv: the saved key goes only to DeepSeek, and only when the user has set none', () => {
  assert.deepEqual(dsh.dshEnv({}, 'sk-a'), { DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: 'sk-a', DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic' });
  assert.deepEqual(dsh.dshEnv({}, null), { DSH_TELEMETRY_DISABLED: '1' });
  assert.deepEqual(dsh.dshEnv({ DEEPSEEK_API_KEY: 'sk-own' }, 'sk-a'), { DSH_TELEMETRY_DISABLED: '1' });
  assert.deepEqual(dsh.dshEnv({}, 'sk-a', 'X=1\nexport DEEPSEEK_API_KEY=sk-home\n'), { DSH_TELEMETRY_DISABLED: '1' }); // dsh's own .env
  assert.equal(dsh.dshEnv({}, 'sk-a', '# DEEPSEEK_API_KEY=old\n').DEEPSEEK_API_KEY, 'sk-a');
  assert.ok(!('DEEPSEEK_BASE_URL' in dsh.dshEnv({ DEEPSEEK_BASE_URL: 'http://mine' }, 'sk-a'))); // the user's own address stays
});

test('dshProgram: an npm shim is run through node, so paths with spaces need no shell', () => {
  const shim = path.join('C:', 'Users', 'A B', 'npm', 'dsh.cmd');
  const js = path.join('C:', 'Users', 'A B', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  assert.deepEqual(dsh.dshProgram(shim, 'node.exe', f => f === js), { command: 'node.exe', first: [js] });
  assert.equal(dsh.dshProgram(shim, 'node.exe', () => false), null);
  assert.equal(dsh.dshProgram(shim, null, () => true), null);
  assert.deepEqual(dsh.dshProgram('/usr/local/bin/dsh', null, () => false), { command: '/usr/local/bin/dsh', first: [] });
});

test('the overlay turns the session-log upload off', () => {
  assert.equal(dsh.DSH_PATCH, '- id: session-log-deepseek\n  config:\n    enabled: false\n');
});

// Lines a real dsh 0.2.2-rc.5 printed.
const feed = (lines, mode = 'build') => { const read = dsh.dshReader(p => p.replace('C:/p/', '')); return lines.flatMap(l => read(l, mode)); };
const call = (callId, tool, input) => ({ type: 'tool_call', callId, tool, input });
const result = (callId, text = 'ok', status = 'completed', error) => ({ type: 'tool_result', callId, status, result: text, ...(error ? { error } : {}) });
const finalOk = { type: 'final', sessionId: 's', reason: { kind: 'completed' }, text: 'All done.' };

test('dshReader: session, text, tokens and done', () => {
  assert.deepEqual(feed([
    { type: 'session', sessionId: 'session-1', cwd: 'x' }, { type: 'status', phase: 'turn_start', turn: 1 }, { type: 'thinking', text: 'hm' }, { type: 'text', text: 'All done.' },
    { type: 'status', phase: 'step_end', usage: { totalTokens: 17 } }, { type: 'status', phase: 'step_end', usage: { inputTokens: 3, outputTokens: 2 } }, { type: 'brand_new' }, finalOk,
  ]), [{ t: 'session', id: 'session-1' }, { t: 'text', text: 'All done.' }, { t: 'done', ok: true, tokens: 22 }]);
});

test('dshReader: plan mode ends with the plan; an answer only in final is still shown', () => {
  assert.deepEqual(feed([{ type: 'text', text: '1. x' }, { ...finalOk, text: '1. x' }], 'plan'), [{ t: 'text', text: '1. x' }, { t: 'plan', text: '1. x' }, { t: 'done', ok: true, tokens: 0 }]);
  assert.deepEqual(feed([finalOk]), [{ t: 'text', text: 'All done.' }, { t: 'done', ok: true, tokens: 0 }]);
});

test('dshReader: tools show when they finish, and a file only once it is written', () => {
  assert.deepEqual(feed([call('1', 'read', { file_path: 'a.txt' })]), []);
  assert.deepEqual(feed([
    call('1', 'read', { file_path: 'C:/p/a.txt' }), result('1'),
    call('2', 'edit', { file_path: 'a.txt' }), result('2', 'has been updated'),
    call('3', 'write', { file_path: 'b.txt' }), result('3', '<content>\nCreated file\n</content>'),
    call('4', 'pwsh', { command: 'ls' }), result('4', 'out'),
    call('5', 'bash', { command: 'ls' }), result('5', ''),
    call('6', 'todo_write', { todos: [{ content: 'one', status: 'in_progress' }] }), result('6'),
    call('7', 'web_search', { query: 'q' }), result('7'),
    call('8', 'odd', {}), result('8'),
    result('nobody asked'),
  ]), [
    { t: 'tool', kind: 'read', label: 'Read a.txt' },
    { t: 'tool', kind: 'edit', label: 'Edited a.txt' }, { t: 'file', path: 'a.txt', created: false, written: true },
    { t: 'tool', kind: 'edit', label: 'Created b.txt' }, { t: 'file', path: 'b.txt', created: true, written: true },
    { t: 'tool', kind: 'run', label: '$ ls' }, { t: 'output', text: 'out' },
    { t: 'tool', kind: 'run', label: '$ ls' },
    { t: 'todos', todos: [{ content: 'one', status: 'in_progress' }] },
    { t: 'tool', kind: 'web', label: 'Searched the web for q' },
    { t: 'tool', kind: 'tool', label: 'odd' },
  ]);
});

test('dshReader: a refused write is said, and never listed as a changed file', () => {
  assert.deepEqual(feed([
    call('1', 'edit', { file_path: 'a.txt' }), result('1', 'denied', 'error', { code: 'FS_SANDBOX_DENIED' }),
    call('2', 'pwsh', { command: 'rm x' }), result('2', 'no', 'error', { code: 'SANDBOX_ESCALATION_REJECTED' }),
    call('3', 'edit', { file_path: 'b.txt' }), result('3', 'old_string not found', 'error'),
  ]), [
    { t: 'tool', kind: 'tool', label: 'Not allowed: edit a.txt' },
    { t: 'tool', kind: 'tool', label: 'Not allowed: $ rm x' },
    { t: 'tool', kind: 'tool', label: 'Failed: edit b.txt' },
  ]);
});

test('dshReader: errors end the run with something to act on', () => {
  const fail = (code, message) => feed([{ type: 'final', reason: { kind: 'error', error: { code, message } }, text: '' }]);
  assert.match(fail('MISSING_CREDENTIAL', 'x')[0].text, /DeepSeek API key/);
  assert.match(fail('TRANSPORT', 'x')[0].text, /reach DeepSeek/);
  assert.deepEqual(fail('OTHER', 'Boom'), [{ t: 'error', text: 'Boom' }, { t: 'done', ok: false, tokens: 0 }]);
  assert.deepEqual(feed([{ type: 'final', reason: { kind: 'aborted' }, text: '' }]).at(-1), { t: 'done', ok: false, tokens: 0 });
  assert.equal(feed([{ type: 'final', reason: null, text: '' }]).at(-1).ok, false);
  assert.deepEqual(feed([{ type: 'error', message: 'session "session-x" does not exist; omit' }]), [{ t: 'lastError', text: 'session "session-x" does not exist; omit' }]);
});

test('dshFailure: the sentence, not the stack', () => {
  const err = 'file:///x/index.js:4488\n\t\tthrow new Error(`x`);\n\t\t^\n\nError: dsh: C:/p/.env sets "DEEPSEEK_BASE_URL", which only the launching environment may set\n    at readEnvLayer (x)\n    at y\n';
  assert.equal(dsh.dshFailure(err), 'C:/p/.env sets "DEEPSEEK_BASE_URL", which only the launching environment may set');
  assert.equal(dsh.dshFailure('dsh: TRANSPORT: failed\n'), 'TRANSPORT: failed');
  assert.equal(dsh.dshFailure('something odd'), null);
});
