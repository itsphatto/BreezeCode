const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  AntigravityAgentService,
  AntigravityAgentError,
  AntigravityAuthError,
  AntigravityTimeoutError,
  AntigravityProcessError,
} = require('../src/main/antigravityAgentService.js');

test('AntigravityAgentService exports and static discovery methods', () => {
  assert.equal(typeof AntigravityAgentService, 'function');
  assert.equal(typeof AntigravityAgentService.findExecutable, 'function');
  assert.equal(typeof AntigravityAgentService.isAvailable, 'function');
});

// Only machines with Antigravity installed can check discovery; everywhere else this is skipped.
test('AntigravityAgentService.isAvailable agrees with findExecutable', t => {
  const execPath = AntigravityAgentService.findExecutable();
  if (!execPath) return t.skip('Antigravity is not installed');
  assert.equal(AntigravityAgentService.isAvailable(), true);
});

test('Stream Isolation: non-fatal stderr telemetry and debug logs do not crash the session', () => {
  const service = new AntigravityAgentService();
  const debugLogs = [];
  const warningLogs = [];
  const errors = [];

  service.on('debug', (log) => debugLogs.push(log));
  service.on('warning', (warn) => warningLogs.push(warn));
  service.on('error', (err) => errors.push(err));

  // Access private stream handler directly to test stderr parsing and isolation
  const handleStderr = service['handleStderrChunk'].bind(service);

  // Send various OpenTelemetry and debug messages
  handleStderr('[otel] trace_id=4bf92f3577b34da6a3ce929d0e0e4736 span_id=00f067aa0ba902b7\n');
  handleStderr('level=debug msg="resolving configuration"\n');
  handleStderr('[INFO] Starting telemetry exporter\n');
  handleStderr('(node:12345) ExperimentalWarning: Custom warning\n');
  handleStderr('GRPC_GO_LOG: transport: loas keepalive ping\n');

  // Stderr telemetry should be filtered into debug events, NOT errors or process crashes
  assert.equal(errors.length, 0, 'No errors should be triggered by telemetry logs');
  assert.ok(debugLogs.length >= 4, `Expected at least 4 debug logs, got ${debugLogs.length}`);
  assert.ok(debugLogs.some((l) => l.includes('trace_id=')), 'Trace ID should be logged as debug');
  assert.ok(debugLogs.some((l) => l.includes('ExperimentalWarning')), 'Warning should be captured as debug');

  // Verify recent stderr ring buffer captures these
  const recent = service.getRecentStderr(10);
  assert.ok(recent.length >= 4);
});

test('Stream Isolation & Parsing: stdout safely parses line-delimited JSON and raw strings', () => {
  const service = new AntigravityAgentService();
  const textEvents = [];
  const outputEvents = [];
  const jsonRpcEvents = [];

  service.on('text', (t) => textEvents.push(t));
  service.on('output', (ev) => outputEvents.push(ev));
  service.on('jsonrpc', (rpc) => jsonRpcEvents.push(rpc));

  const handleStdout = service['handleStdoutChunk'].bind(service);

  // 1. Raw string chunks
  handleStdout('Hello from Antigravity agent!\n');
  assert.equal(textEvents.length, 1);
  assert.equal(textEvents[0], 'Hello from Antigravity agent!');

  // 2. Line-delimited Breeze Agent Event
  handleStdout('{"t":"plan","text":"1. Update styles\\n2. Build project"}\n');
  assert.ok(outputEvents.some((ev) => ev.type === 'plan' && ev.text.includes('Update styles')));

  // 3. Structured JSON-RPC message
  handleStdout('{"jsonrpc":"2.0","method":"agent/ready","params":{"status":"ok"}}\n');
  assert.equal(jsonRpcEvents.length, 1);
  assert.equal(jsonRpcEvents[0].method, 'agent/ready');
});

test('Stream Isolation & Parsing: stdout handles chunked LSP Content-Length framing across split buffers', () => {
  const service = new AntigravityAgentService();
  const jsonRpcEvents = [];

  service.on('jsonrpc', (rpc) => jsonRpcEvents.push(rpc));

  const handleStdout = service['handleStdoutChunk'].bind(service);

  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 101,
    result: { answer: 'Antigravity execution completed' },
  });
  const header = `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n`;
  const fullMessage = header + payload;

  // Split into 3 arbitrary chunks to simulate network/stream chunking
  const chunk1 = fullMessage.slice(0, 15);
  const chunk2 = fullMessage.slice(15, 35);
  const chunk3 = fullMessage.slice(35);

  handleStdout(chunk1);
  assert.equal(jsonRpcEvents.length, 0, 'Should not parse partial header/body');

  handleStdout(chunk2);
  assert.equal(jsonRpcEvents.length, 0, 'Should not parse partial body');

  handleStdout(chunk3);
  assert.equal(jsonRpcEvents.length, 1, 'Should parse full message once chunks complete');
  assert.equal(jsonRpcEvents[0].id, 101);
  assert.deepEqual(jsonRpcEvents[0].result, { answer: 'Antigravity execution completed' });
});

test('Auth Failure Detection: detects auth_expired, 401 and emits typed auth-required event', () => {
  const service = new AntigravityAgentService();
  const authEvents = [];

  service.on('auth-required', (ev) => authEvents.push(ev));

  const handleStdout = service['handleStdoutChunk'].bind(service);
  const handleStderr = service['handleStderrChunk'].bind(service);

  // 1. Detect auth_expired with Google OAuth URL in stdout
  const oauthUrl = 'https://accounts.google.com/o/oauth2/auth?client_id=123&response_type=code';
  handleStdout(`Error: auth_expired. Please open ${oauthUrl} to sign in.\n`);

  assert.equal(authEvents.length, 1);
  assert.equal(authEvents[0].type, 'auth-required');
  assert.equal(authEvents[0].reason, 'auth_expired');
  assert.equal(authEvents[0].url, oauthUrl);
  assert.ok(authEvents[0].command);

  // 2. Detect UNAUTHENTICATED on stderr
  handleStderr('rpc error: code = Unauthenticated desc = token has expired. Run "agy login" to authenticate.\n');
  assert.equal(authEvents.length, 2);
  assert.equal(authEvents[1].reason, 'unauthenticated');
  assert.equal(authEvents[1].command, 'agy login');

  // Verify service remembers last auth event
  assert.equal(service.getLastAuthEvent(), authEvents[1]);
});

test('triggerExternalAuth: safely handles missing or custom URLs without throwing', async () => {
  const service = new AntigravityAgentService();

  // No URL and no captured auth event -> should gracefully return false without throwing
  const res1 = await service.triggerExternalAuth();
  assert.equal(res1, false);
  // Calling it with a real URL opens the user's browser, so the test stops here.
});

test('Session Lifecycle: custom error classes behave correctly', () => {
  const baseErr = new AntigravityAgentError('Test error', 'TEST_CODE', { foo: 'bar' });
  assert.equal(baseErr.name, 'AntigravityAgentError');
  assert.equal(baseErr.code, 'TEST_CODE');
  assert.deepEqual(baseErr.details, { foo: 'bar' });

  const authEv = {
    type: 'auth-required',
    reason: 'auth_expired',
    url: 'https://example.com',
    command: 'agy login',
    rawText: 'auth_expired',
    timestamp: Date.now(),
  };
  const authErr = new AntigravityAuthError(authEv);
  assert.equal(authErr.name, 'AntigravityAuthError');
  assert.equal(authErr.code, 'AUTH_REQUIRED');
  assert.equal(authErr.authEvent, authEv);

  const timeoutErr = new AntigravityTimeoutError('Timed out', 5000, 'startup');
  assert.equal(timeoutErr.name, 'AntigravityTimeoutError');
  assert.equal(timeoutErr.timeoutMs, 5000);
  assert.equal(timeoutErr.operation, 'startup');

  const procErr = new AntigravityProcessError('Crashed', 1, 'SIGKILL', 'error line');
  assert.equal(procErr.name, 'AntigravityProcessError');
  assert.equal(procErr.exitCode, 1);
  assert.equal(procErr.signal, 'SIGKILL');
  assert.equal(procErr.stderrSummary, 'error line');
});

test('Session Lifecycle: stop on idle or stopped session resolves cleanly', async () => {
  const service = new AntigravityAgentService();
  assert.equal(service.getStatus(), 'idle');

  await service.stop();
  assert.equal(service.getStatus(), 'idle');

  await service.dispose();
  assert.equal(service.getStatus(), 'idle');
});

test('Session Lifecycle: abrupt disconnect emits error and marks session stopped', () => {
  const service = new AntigravityAgentService();
  const errors = [];
  const exits = [];

  service.on('error', (e) => errors.push(e));
  service.on('exit', (code, signal) => exits.push({ code, signal }));

  // Simulate process running state
  service['setStatus']('running');

  // Trigger process exit with non-zero code while not in stopping state
  service['handleProcessExit'](1, null);

  assert.equal(service.getStatus(), 'stopped');
  assert.equal(exits.length, 1);
  assert.equal(exits[0].code, 1);
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof AntigravityProcessError);
  assert.equal(errors[0].exitCode, 1);
});

test('AntigravityAgentService.getAvailableModels returns authentic Antigravity models', () => {
  const models = AntigravityAgentService.getAvailableModels();
  assert.ok(Array.isArray(models), 'Models must be an array');
  assert.ok(models.length >= 3, 'Should discover multiple Antigravity models');
  assert.ok(models.includes('claude-sonnet-4-6') || models.includes('gemini-3.8-flash-high'), 'Should include flagship Antigravity models');
});

test('Parsing: handles agy native stream-json events (init, step_update, result)', () => {
  const service = new AntigravityAgentService();
  const outputs = [];
  const texts = [];

  service.on('output', (ev) => outputs.push(ev));
  service.on('text', (t) => texts.push(t));

  const handleStdout = service['handleStdoutChunk'].bind(service);

  // 1. init event
  handleStdout('{"event":"init","conversation_id":"conv-123","init":{"model":"claude-sonnet-4-6"}}\n');
  assert.ok(outputs.some((ev) => ev.type === 'session' && ev.text === 'conv-123'));

  // 2. step_update agent_response delta
  handleStdout('{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"Hello "}}\n');
  handleStdout('{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"from Claude!"}}\n');
  assert.ok(texts.includes('Hello from Claude!'));

  // 3. step_update tool call
  handleStdout('{"event":"step_update","step_update":{"step_type":"tool","tool_name":"run_command","tool_info":{"parameters":{"CommandLine":"npm test"}}}}\n');
  assert.ok(outputs.some((ev) => ev.type === 'tool' && ev.label === '$ npm test'));

  // 4. result event
  handleStdout('{"event":"result","result":{"status":"SUCCESS","response":"Hello from Claude!"}}\n');
  assert.ok(outputs.some((ev) => ev.type === 'done' && ev.ok === true));
});

test('buildSpawnArgs: configures agy with requested model, effort, and headless permissions', () => {
  const service = new AntigravityAgentService({
    mode: 'build',
    model: 'claude-opus-4-6-thinking',
    effort: 'high',
    prompt: 'Implement feature',
  });

  const args = service['buildSpawnArgs']('agy.exe');
  assert.ok(args.includes('--mode'), 'Must have --mode');
  assert.ok(args.includes('auto'), 'Build mode maps to auto');
  assert.ok(!args.includes('--dangerously-skip-permissions'), 'Only Full access skips permissions');
  assert.ok(args.includes('--model'), 'Must have --model');
  assert.ok(args.includes('claude-opus-4-6-thinking'), 'Must specify chosen model');
  assert.ok(!args.includes('--effort'), 'agy rejects --effort for Claude models');
  assert.ok(args.includes('--output-format'), 'Must specify output format');
  assert.ok(args.includes('stream-json'), 'Must be stream-json');
  assert.ok(args.includes('--print'), 'Must specify print flag');
  assert.ok(args.includes('Implement feature'), 'Must specify prompt');
});

test('buildSpawnArgs: permissions are skipped only in build mode with Full access', () => {
  const skips = o => new AntigravityAgentService({ prompt: 'p', ...o })['buildSpawnArgs']('agy.exe').includes('--dangerously-skip-permissions');
  assert.equal(skips({ mode: 'build', fullAccess: true }), true);
  assert.equal(skips({ mode: 'build' }), false);
  assert.equal(skips({ mode: 'plan', fullAccess: true }), false);
  assert.equal(skips({ mode: 'ask', fullAccess: true }), false);
});

// A .cmd shim runs through cmd.exe, which must see the prompt as text, never as its own syntax.
test('cmdLine: a .cmd shim gets every argument intact and runs nothing else', { skip: process.platform !== 'win32' }, () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breeze agy '));
  fs.writeFileSync(path.join(dir, 'cli.js'), "require('fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)))");
  // The same shape as the shim npm writes for a global package.
  fs.writeFileSync(path.join(dir, 'agy.cmd'), '@ECHO off\r\nSETLOCAL\r\nnode "%~dp0\\cli.js" %*\r\n');
  const out = path.join(dir, 'argv.json');
  const prompts = [
    'add login & echo INJECTED> INJECTED.txt & rem',
    'x > y | z < w',
    '"quoted" 100% %PATH% !PATH! ^caret (paren) ; , = * ?',
    'trail\\',
    'back\\"slash \\\\" end',
    'tab\there ünï€ode 日本',
  ];
  for (const p of prompts) {
    fs.rmSync(out, { force: true });
    const { file, args, options } = AntigravityAgentService.cmdLine(path.join(dir, 'agy.cmd'), [out, '--print', p]);
    spawnSync(file, args, { ...options, cwd: dir });
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), ['--print', p]);
  }
  // cmd.exe ends a command at a line break, so line breaks travel as spaces instead of cutting the prompt off.
  fs.rmSync(out, { force: true });
  const { file, args, options } = AntigravityAgentService.cmdLine(path.join(dir, 'agy.cmd'), [out, 'line1\nline2 & echo NL> NL.txt\r\nline3']);
  spawnSync(file, args, { ...options, cwd: dir });
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), ['line1 line2 & echo NL> NL.txt line3']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['agy.cmd', 'argv.json', 'cli.js']);
});

test('effortFlag: only passes --effort where agy accepts it', () => {
  const f = AntigravityAgentService.effortFlag;
  assert.equal(f('gemini-3.8-flash-low', 'medium'), null, 'level is baked into the id');
  assert.equal(f('gpt-oss-120b-medium', 'high'), null, 'level is baked into the id');
  assert.equal(f('claude-sonnet-4-6', 'low'), null, 'Claude models take no --effort');
  assert.equal(f('some-future-model', 'extra'), 'xhigh', 'Breeze "extra" is agy "xhigh"');
  assert.equal(f('some-future-model', 'Medium'), 'medium');
  assert.equal(f('some-future-model', 'bogus'), null);
  assert.equal(f('some-future-model', undefined), null);
});

test('Message Deduping: ignores user_input echo, suppresses intermediate deltas, and avoids raw JSON notes', () => {
  const service = new AntigravityAgentService();
  const outputs = [];

  service.on('output', (ev) => outputs.push(ev));
  const handleStdout = service['handleStdoutChunk'].bind(service);

  // 1. user_input step echo should NOT create a note or text event
  handleStdout('{"event":"step_update","step_update":{"conversation_id":"conv-123","step_index":0,"state":"DONE","step_type":"user_input"}}\n');
  assert.equal(outputs.length, 0, 'user_input should produce no output events');

  // 2. streaming deltas with state: ACTIVE should NOT emit output text bubbles prematurely
  handleStdout('{"event":"step_update","step_update":{"conversation_id":"conv-123","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"Hello! How can I h"}}\n');
  handleStdout('{"event":"step_update","step_update":{"conversation_id":"conv-123","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"elp you today?"}}\n');
  assert.equal(outputs.length, 0, 'Intermediate ACTIVE deltas should not emit output text events');

  // 3. state: DONE emits the complete text once
  handleStdout('{"event":"step_update","step_update":{"conversation_id":"conv-123","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":""}}\n');
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].type, 'text');
  assert.equal(outputs[0].text, 'Hello! How can I help you today?');

  // 4. tool in ACTIVE state should not emit duplicate event
  handleStdout('{"event":"step_update","step_update":{"step_type":"tool","state":"ACTIVE","tool_name":"run_command","tool_info":{"parameters":{"CommandLine":"git status"}}}}\n');
  assert.equal(outputs.length, 1, 'ACTIVE tool state should be skipped');

  // 5. tool in DONE state emits once
  handleStdout('{"event":"step_update","step_update":{"step_type":"tool","state":"DONE","tool_name":"run_command","tool_info":{"parameters":{"CommandLine":"git status"}}}}\n');
  assert.equal(outputs.length, 2);
  assert.equal(outputs[1].type, 'tool');
  assert.equal(outputs[1].label, '$ git status');

  // 6. result event with same response should not duplicate text event
  handleStdout('{"event":"result","result":{"status":"SUCCESS","response":"Hello! How can I help you today?"}}\n');
  assert.equal(outputs.length, 3);
  assert.equal(outputs[2].type, 'done');

  // Ensure no raw JSON note was ever emitted
  assert.ok(!outputs.some((ev) => ev.type === 'note' && ev.text && ev.text.startsWith('{')));
});

