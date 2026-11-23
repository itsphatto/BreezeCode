// Go debugging: Delve (`dlv dap`) behind the DebugManager, finding dlv, and running a Go module's package.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { DebugManager, debugKind, launchArgs, relOf } = require('../src/main/debug');
const { GoBackend, dlvArgs, goLaunchArgs, DLV_INSTALL } = require('../src/main/debugGo');
const { DapReader, frame } = require('../src/main/dap');
const { findTools, runPlan, installCmd, installHint } = require('../src/main/toolchains');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

async function waitUntil(cond, ms) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms`);
    await new Promise(r => setTimeout(r, 10));
  }
}
const freePort = () => new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

// ---- pure helpers ----

test('debugKind: .go files are Go', () => {
  assert.equal(debugKind('main.go'), 'go');
  assert.equal(debugKind('C:\\x\\CMD\\MAIN.GO'), 'go');
  assert.equal(debugKind('main.go.bak'), null);
});

test('dlv dap listens on the picked port; launch builds the file, or the package in a module', () => {
  assert.deepEqual(dlvArgs(4711), ['dap', '--listen=127.0.0.1:4711']);
  assert.deepEqual(launchArgs('go', 'C:\\p\\main.go', { args: dlvArgs(4711) }), { args: ['dap', '--listen=127.0.0.1:4711'] });
  const file = path.join('/', 'p', 'cmd', 'main.go');
  assert.deepEqual(goLaunchArgs(file, null, '/tmp/out'),
    { request: 'launch', mode: 'debug', program: file, cwd: path.dirname(file), output: '/tmp/out', stopOnEntry: false });
  assert.equal(goLaunchArgs(file, path.join('/', 'p', 'go.mod'), '/tmp/out').program, path.dirname(file));
  assert.equal(DLV_INSTALL, 'go install github.com/go-delve/delve/cmd/dlv@latest');
});

// ---- GoBackend against a stand-in Delve ----

// A tiny DAP adapter shaped like `dlv dap`: 'initialized' follows the launch response, the program's stops come after
// configurationDone, and it records every request it gets.
function fakeDelve(root, { buildError } = {}) {
  const got = [];
  const socks = new Set();
  const server = net.createServer(sock => {
    socks.add(sock);
    const reader = new DapReader();
    let seq = 1;
    const send = m => sock.write(frame({ seq: seq++, ...m }));
    const reply = (req, body = {}) => send({ type: 'response', request_seq: req.seq, command: req.command, success: true, body });
    sock.on('data', c => {
      for (const req of reader.push(c)) {
        got.push(req);
        const a = req.arguments || {};
        switch (req.command) {
          case 'initialize': reply(req, { supportsConfigurationDoneRequest: true, supportsConditionalBreakpoints: true, supportsLogPoints: true }); break;
          case 'launch':
            if (buildError) { send({ type: 'response', request_seq: req.seq, command: 'launch', success: false, message: 'Failed to launch: Build error: ./main.go:3:2: undefined: x' }); break; }
            reply(req);
            send({ type: 'event', event: 'initialized' });
            break;
          case 'setBreakpoints':
            reply(req, { breakpoints: a.breakpoints.map((b, i) => ({ id: i + 1, verified: b.line !== 99, line: b.line })) });
            break;
          case 'setFunctionBreakpoints': reply(req, { breakpoints: a.breakpoints.map((b, i) => ({ id: 50 + i, verified: true })) }); break;
          case 'configurationDone':
            reply(req);
            if (got.some(r => r.command === 'setFunctionBreakpoints')) send({ type: 'event', event: 'stopped', body: { reason: 'function breakpoint', threadId: 1, hitBreakpointIds: [50] } });
            else send({ type: 'event', event: 'stopped', body: { reason: 'breakpoint', threadId: 1 } });
            break;
          case 'stackTrace':
            reply(req, { stackFrames: [
              { id: 1000, name: 'main.main', source: { path: path.join(root, 'main.go') }, line: 7, column: 0 },
              { id: 1001, name: 'runtime.main', source: { path: 'C:/Go/src/runtime/proc.go' }, line: 283, column: 0 },
            ] });
            break;
          case 'scopes': reply(req, { scopes: [{ name: 'Locals', variablesReference: 5 }, { name: 'Registers', variablesReference: 6 }] }); break;
          case 'variables': reply(req, { variables: [{ name: 'n', value: '3', type: 'int', variablesReference: 0 }, { name: 'xs', value: '[]int len: 2, cap: 2, [1,2]', type: '[]int', variablesReference: 9 }] }); break;
          case 'evaluate': reply(req, { result: '6', type: 'int', variablesReference: 0 }); break;
          case 'exceptionInfo': reply(req, { exceptionId: 'panic', description: 'runtime error: index out of range [5] with length 2' }); break;
          case 'continue':
            reply(req, { allThreadsContinued: true });
            if (got.filter(r => r.command === 'continue').length === 2) {
              send({ type: 'event', event: 'stopped', body: { reason: 'exception', threadId: 1 } });
            } else if (got.filter(r => r.command === 'continue').length === 3) {
              send({ type: 'event', event: 'output', body: { category: 'stdout', output: 'logpoint n=3\n' } });
              send({ type: 'event', event: 'exited', body: { exitCode: 2 } });
              send({ type: 'event', event: 'terminated', body: {} });
            }
            break;
          default: reply(req);
        }
      }
    });
    sock.on('error', () => {});
  });
  const close = () => { for (const s of socks) s.destroy(); server.close(); };
  return { server, got, close };
}

function hostFor(root, file, events, states, { stopOnEntry = false, bps } = {}) {
  return {
    root, file, stopOnEntry,
    pid: () => 1,
    bps: () => new Map([[file, bps ?? [
      { line: 7, enabled: true, hitCondition: '2' },
      { line: 8, enabled: true, condition: 'n > 1', logMessage: 'n={n}' },
      { line: 9, enabled: false },
      { line: 99, enabled: true },
    ]]]),
    exceptions: () => 'uncaught',
    emit: e => events.push(e),
    setState: s => states.push(s),
    output: (stream, text) => events.push({ type: 'output', stream, text }),
    alive: () => true,
    warn: e => { throw e; },
    within: p => p,
    rel: abs => relOf(abs, root),
  };
}

test('GoBackend: launches through Delve, stops on entry at main.main, maps stops, values and the exit', { timeout: 15000 }, async t => {
  const root = path.join(__dirname, 'fixtures', 'go root');
  const file = path.join(root, 'main.go');
  const port = await freePort();
  const { server, got, close } = fakeDelve(root);
  let b;
  t.after(() => { b?.close(); close(); });
  const events = [], states = [];
  b = new GoBackend(hostFor(root, file, events, states, { stopOnEntry: true }), { dlv: 'dlv', go: 'go', goMod: path.join(root, 'go.mod') });
  b.port = port;
  setTimeout(() => server.listen(port, '127.0.0.1'), 300); // Delve takes a moment to listen
  await b.connect();

  assert.deepEqual(got.map(r => r.command).slice(0, 5), ['initialize', 'launch', 'setBreakpoints', 'setFunctionBreakpoints', 'configurationDone']);
  const launch = got.find(r => r.command === 'launch').arguments;
  assert.equal(launch.mode, 'debug');
  assert.equal(launch.program, root, 'a module debugs the file\'s package');
  assert.equal(launch.output, b.output);
  assert.deepEqual(got.find(r => r.command === 'setBreakpoints').arguments.breakpoints, [
    { line: 7, hitCondition: '>= 2' }, // a bare count means "from the 2nd hit on", as in the other backends
    { line: 8, condition: 'n > 1', logMessage: 'n={n}' },
    { line: 99 },
  ]);
  assert.deepEqual(got.find(r => r.command === 'setFunctionBreakpoints').arguments, { breakpoints: [{ name: 'main.main' }] });
  assert.ok(!got.some(r => r.command === 'setExceptionBreakpoints'), 'Delve has no exception filters');

  await waitUntil(() => events.some(e => e.type === 'paused'), 5000);
  const p = events.find(e => e.type === 'paused');
  assert.equal(p.reason, 'entry');
  assert.deepEqual(p.frames, [
    { id: 1000, name: 'main.main', file: 'main.go', line: 7, col: 0 },
    { id: 1001, name: 'runtime.main', file: null, line: 283, col: 0 },
  ]);
  assert.deepEqual(events.find(e => e.type === 'breakpoints'), { type: 'breakpoints', file: 'main.go', lines: [7, 8] });
  await waitUntil(() => got.filter(r => r.command === 'setFunctionBreakpoints').length === 2, 2000);
  assert.deepEqual(got.filter(r => r.command === 'setFunctionBreakpoints')[1].arguments, { breakpoints: [] }, 'the entry stop is one-off');

  assert.deepEqual(await b.scopes(1000), [{ name: 'Locals', value: '', type: 'scope', ref: 5 }]);
  assert.deepEqual((await b.children(5))[0], { name: 'n', value: '3', type: 'int', ref: 0 });
  assert.deepEqual(await b.evaluate('n * 2', 1000, 'watch'), { name: 'n * 2', value: '6', type: 'int', ref: 0 });
  assert.equal(got.find(r => r.command === 'evaluate').arguments.context, 'watch');

  await b.step('into');
  assert.equal(got.at(-1).command, 'stepIn');
  assert.equal(got.at(-1).arguments.threadId, 1);
  assert.equal(states.at(-1), 'running');

  // A panic stops as an exception with Delve's description.
  await b.resume();
  await b.resume();
  await waitUntil(() => events.filter(e => e.type === 'paused').length === 2, 5000);
  const panic = events.filter(e => e.type === 'paused')[1];
  assert.equal(panic.reason, 'exception');
  assert.equal(panic.exception, 'panic: runtime error: index out of range [5] with length 2');

  // The program ends: Delve's messages go to the console, its exit code is the program's, and Delve is let go.
  await b.resume();
  await waitUntil(() => got.some(r => r.command === 'disconnect'), 5000);
  assert.ok(events.some(e => e.type === 'output' && e.stream === 'console' && e.text === 'logpoint n=3\n'));
  assert.ok(events.some(e => e.type === 'output' && e.stream === 'console' && e.text.startsWith('> dlv dap: building the package')));
  assert.equal(b.exitCode(), 2);
  assert.deepEqual(got.find(r => r.command === 'disconnect').arguments, { terminateDebuggee: true });
});

test('GoBackend: a build error shows in the Output and fails as build-failed', { timeout: 15000 }, async t => {
  const root = path.join(__dirname, 'fixtures', 'go root');
  const file = path.join(root, 'main.go');
  const port = await freePort();
  const { server, close } = fakeDelve(root, { buildError: true });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const events = [];
  const b = new GoBackend(hostFor(root, file, events, []), { dlv: 'dlv', go: 'go' });
  t.after(() => { b.close(); close(); });
  b.port = port;
  await assert.rejects(b.connect(), e => e.hint === 'build-failed');
  assert.ok(events.some(e => e.type === 'output' && e.stream === 'stderr' && /undefined: x/.test(e.text)));
});

test("GoBackend: Delve's listening line is not the program's output", () => {
  const b = new GoBackend(hostFor('/r', '/r/main.go', [], []), { dlv: 'dlv', go: 'go' });
  assert.equal(b.stdout('DAP server listening at: 127.0.0.1:50123\n'), '');
  assert.equal(b.stdout('DAP server listening at: 127.0.0.1:50123\n'), 'DAP server listening at: 127.0.0.1:50123\n', 'only once');
  const c = new GoBackend(hostFor('/r', '/r/main.go', [], []), { dlv: 'dlv', go: 'go' });
  assert.equal(c.stdout('DAP server listening at: 127.0.0.1:1\nhello\n'), 'hello\n');
});

// ---- the manager ----

async function startFails(opts) {
  const m = new DebugManager();
  const events = [];
  m.on('event', e => events.push(e));
  await m.start({ root: __dirname, file: path.join(__dirname, 'fixtures', 'go root', 'main.go'), ...opts });
  await waitUntil(() => events.some(e => e.type === 'state' && e.state === 'stopped'), 15000);
  return events.find(e => e.type === 'error');
}

test('DebugManager: no Delve says how to install it', { timeout: 20000 }, async () => {
  const err = await startFails({ dlv: path.join(__dirname, 'no-such-dlv.exe'), go: process.execPath });
  assert.equal(err.hint, 'install-dlv');
  assert.match(err.message, /go install github\.com\/go-delve\/delve\/cmd\/dlv@latest/);
});

test('DebugManager: no Go says where to get it', { timeout: 20000 }, async () => {
  const err = await startFails({ dlv: 'dlv', go: null });
  assert.equal(err.hint, 'install-go');
});

// ---- toolchains ----

const T = (p, name, version = '1.0') => ({ path: p, name, version });

test('runPlan runs a Go module\'s package with `go run .`, and a lone file with `go run file`', () => {
  const tools = { go: T('C:\\go\\go.exe', 'go'), binDirs: [] };
  assert.deepEqual(runPlan('C:\\p\\cmd\\app\\main.go', tools, 'win32', 'h', { goMod: 'C:\\p\\go.mod' }).steps,
    [{ display: 'go run .', file: 'C:\\go\\go.exe', args: ['run', '.'], cwd: 'C:\\p\\cmd\\app' }]);
  assert.deepEqual(runPlan('C:\\p\\main.go', tools, 'win32', 'h').steps,
    [{ display: 'go run "main.go"', file: 'C:\\go\\go.exe', args: ['run', 'C:\\p\\main.go'], cwd: 'C:\\p' }]);
  assert.match(runPlan('C:\\p\\main.go', { binDirs: [] }, 'win32', 'h', { goMod: 'C:\\p\\go.mod' }).error, /^Go wasn't found/);
});

test('findTools finds dlv in GOPATH\\bin off the PATH, asking go for GOPATH', async () => {
  const ok = {
    'C:\\Program Files\\Go\\bin\\go.exe': 'go version go1.24.0 windows/amd64',
    'D:\\gopath\\bin\\dlv.exe': 'Delve Debugger\nVersion: 1.25.0',
  };
  const calls = [];
  const r = await findTools({
    platform: 'win32', pathValue: 'C:\\Windows', env: { USERPROFILE: 'C:\\Users\\me' },
    exists: p => p in ok, glob: () => [],
    run: async (file, args) => {
      calls.push([file, ...args]);
      if (file.endsWith('go.exe') && args[0] === 'env') return { code: 0, stdout: 'D:\\gopath\n' };
      return file in ok ? { code: 0, stdout: ok[file] } : { code: 1, stdout: '' };
    },
  });
  assert.deepEqual(r.dlv, { path: 'D:\\gopath\\bin\\dlv.exe', name: 'dlv', version: 'Delve Debugger' });
  assert.ok(calls.some(c => c[0] === 'D:\\gopath\\bin\\dlv.exe' && c[1] === 'version'));
});

test('findTools finds dlv in ~/go/bin without go, and reports none when it is missing', async () => {
  const machine = ok => ({
    platform: 'linux', pathValue: '/usr/bin', env: { HOME: '/home/me' }, exists: p => p in ok, glob: () => [],
    run: async file => (file in ok ? { code: 0, stdout: ok[file] } : { code: 1, stdout: '' }),
  });
  assert.equal((await findTools(machine({ '/home/me/go/bin/dlv': 'Delve Debugger' }))).dlv.path, '/home/me/go/bin/dlv');
  assert.equal((await findTools(machine({}))).dlv, null);
});

test('Delve has an install command on every platform', () => {
  for (const p of ['win32', 'darwin', 'linux']) {
    assert.equal(installCmd('dlv', p), 'go install github.com/go-delve/delve/cmd/dlv@latest');
    assert.equal(installHint('dlv', p), 'go install github.com/go-delve/delve/cmd/dlv@latest');
  }
});

// ---- wiring (source text: main.ts needs Electron, the renderer files are page scripts) ----

test('main passes Delve, go and the go.mod to the debugger, lists Delve and allows its install', () => {
  const main = read('src/main/main.ts');
  assert.match(main, /dlv: tools\.dlv\?\.path \|\| 'dlv'/);
  assert.match(main, /goMod: \/\\\.go\$\/i\.test\(file\) \? nearestProject\(file, n => n === 'go\.mod'\) : null/);
  assert.match(main, /goMod: \/\\\.go\$\/i\.test\(abs\) \? nearestProject\(abs, n => n === 'go\.mod'\) : null/);
  assert.match(main, /\['dlv', 'Delve \(Go debugger\)', found\.dlv \?\? null, 'dlv'\]/);
  assert.match(main, /'sql', 'dlv', \.\.\.LANG_KINDS\]\.map\(kind => installCmd/);
});

test('the debug page debugs .go files and offers to install Delve', () => {
  const dbg = read('src/renderer/breeze/debug.ts');
  assert.match(dbg, /if \(\/\\\.go\$\/i\.test\(path\)\) return 'go';/);
  assert.match(dbg, /Rust, Go or Java/);
  const view = read('src/renderer/breeze/debugview.ts');
  assert.match(view, /e\.hint === 'install-dlv'/);
  assert.match(view, /const INSTALL_DLV = 'go install github\.com\/go-delve\/delve\/cmd\/dlv@latest';/);
  assert.match(view, /what === 'install-dlv'\) installDebugpy\(INSTALL_DLV, 'Delve'\)/);
});
