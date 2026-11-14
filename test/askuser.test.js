const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { normalizeQuestion, replyText, QuestionDesk, NO_ANSWER } = require('../src/main/askuser');
const { BreezeMcpServer, BREEZE_TOOLS, handleRpc } = require('../src/main/breezemcp');
const { claudeMcpConfig, normalizeServer, builtInServers } = require('../src/main/mcp');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('normalizeQuestion tidies a question and its options', () => {
  const q = normalizeQuestion({ question: '  Which  database? ', options: [{ label: ' SQLite ', description: 'One file,\nno server' }, 'Postgres', { label: 'sqlite' }], multiSelect: true });
  assert.deepEqual(q, {
    question: 'Which  database?',
    options: [{ label: 'SQLite', description: 'One file, no server' }, { label: 'Postgres', description: '' }],
    multiSelect: true,
  });
  assert.equal(normalizeQuestion({ question: 'Name?', multi_select: true }).multiSelect, false); // nothing to pick several of
  assert.equal(normalizeQuestion({ question: 'x'.repeat(5000) }).question.length, 600);
});

test('normalizeQuestion tells the agent what to fix', () => {
  assert.throws(() => normalizeQuestion({}), /question is empty/);
  assert.throws(() => normalizeQuestion(null), /question is empty/);
  assert.throws(() => normalizeQuestion({ question: 'Q', options: 'yes or no' }), /must be a list/);
  assert.throws(() => normalizeQuestion({ question: 'Q', options: [{ description: 'no label' }] }), /needs a label/);
  assert.throws(() => normalizeQuestion({ question: 'Q', options: ['1', '2', '3', '4', '5', '6', '7'] }), /at most 6/);
});

test('replyText only counts options the question offered', () => {
  const one = normalizeQuestion({ question: 'Q', options: ['Red', 'Blue'] });
  assert.equal(replyText(one, { picked: ['Blue'] }), 'The user chose: "Blue".');
  assert.equal(replyText(one, { picked: ['Red', 'Blue'] }), 'The user chose: "Red".'); // one choice allowed
  assert.equal(replyText(one, { picked: ['Green'], other: ' teal ' }), 'The user answered: "teal"');
  assert.equal(replyText(one, { picked: ['Green'] }), NO_ANSWER);
  assert.equal(replyText(one, null), NO_ANSWER);
  assert.equal(replyText(one, 'Blue'), NO_ANSWER);
  const many = normalizeQuestion({ question: 'Q', options: ['Red', 'Blue'], multiSelect: true });
  assert.equal(replyText(many, { picked: ['Blue', 'Red'], other: 'and green' }), 'The user chose: "Red", "Blue". They also wrote: "and green"');
});

test('a question round trip: the card event goes out, the answer comes back', async () => {
  const desk = new QuestionDesk(() => 'q1');
  const events = [];
  const q = normalizeQuestion({ question: 'Dark or light?', options: ['Dark', 'Light'] });
  const waiting = desk.ask(7, q, ev => events.push(ev));
  assert.deepEqual(events, [{ t: 'question', id: 'q1', question: 'Dark or light?', options: [{ label: 'Dark', description: '' }, { label: 'Light', description: '' }], multiSelect: false }]);
  assert.equal(desk.size, 1);
  assert.equal(desk.answer('nope', { picked: ['Dark'] }), false);
  assert.equal(desk.answer('q1', { picked: ['Light'] }), true);
  assert.equal(await waiting, 'The user chose: "Light".');
  assert.equal(desk.answer('q1', { picked: ['Dark'] }), false); // answered once
  assert.equal(desk.size, 0);
  assert.equal(events.length, 1); // an answered card needs no end event
});

test('stopping the run cancels its questions and closes their cards', async () => {
  let n = 0;
  const desk = new QuestionDesk(() => `q${++n}`);
  const events = [];
  const q = normalizeQuestion({ question: 'Q' });
  const abort = new AbortController();
  const a = desk.ask(1, q, ev => events.push(ev), abort.signal);
  const b = desk.ask(1, q, ev => events.push(ev));
  const other = desk.ask(2, q, ev => events.push(ev));
  abort.abort();
  assert.equal(await a, NO_ANSWER);
  desk.cancelRun(1);
  assert.equal(await b, NO_ANSWER);
  assert.deepEqual(events.filter(e => e.t === 'question-end').map(e => e.id), ['q1', 'q2']);
  assert.equal(desk.size, 1); // another run's question still waits
  desk.answer('q3', { other: 'fine' });
  assert.equal(await other, 'The user answered: "fine"');
  // A run already stopped never shows a card.
  assert.equal(await desk.ask(1, q, () => assert.fail('no card'), abort.signal), NO_ANSWER);
});

test('handleRpc speaks enough MCP for a client to list and call tools', async () => {
  const call = async (name, args) => ({ text: `${name}:${args.question}` });
  const init = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, BREEZE_TOOLS, call);
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal((await handleRpc({ id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, BREEZE_TOOLS, call)).result.protocolVersion, '2025-06-18');
  assert.equal(await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, BREEZE_TOOLS, call), null);
  const list = await handleRpc({ id: 2, method: 'tools/list' }, BREEZE_TOOLS, call);
  assert.ok(list.result.tools.some(t => t.name === 'ask_user' && t.inputSchema.required.includes('question')));
  const done = await handleRpc({ id: 3, method: 'tools/call', params: { name: 'ask_user', arguments: { question: 'Hi' } } }, BREEZE_TOOLS, call);
  assert.deepEqual(done.result, { content: [{ type: 'text', text: 'ask_user:Hi' }], isError: false });
  const failed = await handleRpc({ id: 4, method: 'tools/call', params: { name: 'ask_user' } }, BREEZE_TOOLS, async () => { throw new Error('question is empty.'); });
  assert.deepEqual(failed.result, { content: [{ type: 'text', text: 'question is empty.' }], isError: true });
  assert.equal((await handleRpc({ id: 5, method: 'tools/call', params: { name: 'rm_rf' } }, BREEZE_TOOLS, call)).error.code, -32602);
  assert.equal((await handleRpc({ id: 6, method: 'resources/list' }, BREEZE_TOOLS, call)).error.code, -32601);
  assert.equal((await handleRpc('hello', BREEZE_TOOLS, call)).error.code, -32600);
});

// One request to the server; resolves with the status, content type and body.
function post(url, body, { method = 'POST', host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: { 'Content-Type': 'application/json', ...(host ? { Host: host } : {}) } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', d => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', text }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('the MCP server answers one run at its own address, and only from this computer', async t => {
  const desk = new QuestionDesk(() => 'q1');
  const events = [];
  const server = new BreezeMcpServer({
    call: async (runId, name, args, signal) => ({ text: await desk.ask(runId, normalizeQuestion(args), ev => events.push([runId, ev]), signal) }),
  });
  assert.equal(server.open(5), null); // not listening yet
  await server.listen();
  t.after(() => server.stop());
  const url = server.open(5);
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f]{48}$/);

  const list = await post(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(list.status, 200);
  assert.match(list.type, /application\/json/);
  assert.equal(JSON.parse(list.text).result.tools[0].name, 'ask_user');
  assert.equal((await post(url, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);

  // The call waits for the user: the reply comes as an event stream once the card is answered.
  const calling = post(url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ask_user', arguments: { question: 'Ship it?', options: ['Yes', 'No'] } } });
  while (!events.length) await new Promise(r => setTimeout(r, 5));
  assert.equal(events[0][0], 5);
  assert.equal(events[0][1].t, 'question');
  desk.answer('q1', { picked: ['Yes'] });
  const called = await calling;
  assert.match(called.type, /text\/event-stream/);
  const data = called.text.split('\n').find(l => l.startsWith('data: '));
  assert.deepEqual(JSON.parse(data.slice(6)).result, { content: [{ type: 'text', text: 'The user chose: "Yes".' }], isError: false });

  assert.equal((await post(url.replace(/[0-9a-f]{48}$/, 'f'.repeat(48)), { id: 1, method: 'tools/list' })).status, 404);
  assert.equal((await post(url, { id: 1, method: 'tools/list' }, { host: 'evil.example:80' })).status, 403); // DNS rebinding
  assert.equal((await post(url, undefined, { method: 'GET' })).status, 405);
  server.close(5);
  assert.equal((await post(url, { id: 1, method: 'tools/list' })).status, 404); // the run ended
});

test('Claude Code gets the built-in server beside the connected ones, and its name is reserved', () => {
  const cfg = claudeMcpConfig([{ name: 'github', type: 'stdio', command: 'npx', args: [] }], 'http://127.0.0.1:5000/mcp/abc');
  assert.deepEqual(cfg.mcpServers.breeze, { type: 'http', url: 'http://127.0.0.1:5000/mcp/abc' });
  assert.ok(cfg.mcpServers.github);
  assert.equal(claudeMcpConfig([], null).mcpServers.breeze, undefined);
  assert.throws(() => normalizeServer({ name: 'Breeze', command: 'x' }), /built-in server/);
  const [row] = builtInServers(BREEZE_TOOLS);
  assert.equal(row.name, 'Breeze (built in)');
  assert.match(row.detail, /ask_user/);
  assert.match(row.detail, /Antigravity can't/); // the gap is said, not hidden
});

test('questions are wired through main, preload and the chat', () => {
  const main = read('src/main/main.ts'), preload = read('src/main/preload.ts'), teams = read('src/renderer/breeze/teams.ts');
  assert.ok(main.includes("handle('agent:reply'"));
  assert.ok(preload.includes("invoke('agent:reply'"));
  assert.match(main, /questions\.cancelRun\(runId\)/); // stopping a run closes its question
  assert.match(main, /ask_user: \(ctx, a\) => askUser\(ctx\.runId, a, ctx\.signal\)/); // the local model's tool
  assert.match(main, /mcp_servers\.\$\{BREEZE_MCP\}\.url=/); // Codex
  assert.match(main, /claudeMcpConfig\(servers, breezeUrl\)/); // Claude Code
  assert.match(main, /builtIn: mcpLib\.builtInServers\(BREEZE_TOOLS\)/); // the Skills view's list
  assert.match(teams, /question: \(r, ev, tab\) => questionCard\(r, ev, tab\)/);
  assert.match(teams, /api\.agent\.reply\(id, reply\)/);
  assert.match(read('src/renderer/breeze/board.ts'), /\.card\.question \[data-live\]/); // a box shows it is waiting
});
