const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { splitCommand, normalizeServer, claudeMcpConfig, serverDetail, claudeConfigured } = require('../src/main/mcp');

test('splitCommand splits on spaces and keeps quoted words whole', () => {
  assert.deepEqual(splitCommand('npx -y @modelcontextprotocol/server-github'), ['npx', '-y', '@modelcontextprotocol/server-github']);
  assert.deepEqual(splitCommand('node "C:\\My Tools\\server.js" --port 3000'), ['node', 'C:\\My Tools\\server.js', '--port', '3000']);
  assert.deepEqual(splitCommand("run '' x"), ['run', '', 'x']);
  assert.throws(() => splitCommand('node "open'), /never closed/);
});

test('normalizeServer checks a command server and reads its env lines', () => {
  const s = normalizeServer({ name: 'github', type: 'stdio', command: 'npx -y server-github', env: 'GITHUB_TOKEN=abc\n\nDEBUG = 1' });
  assert.deepEqual(s, { name: 'github', type: 'stdio', command: 'npx', args: ['-y', 'server-github'], env: { GITHUB_TOKEN: 'abc', DEBUG: '1' } });
  assert.throws(() => normalizeServer({ name: 'my server', command: 'x' }), /letters, numbers/);
  assert.throws(() => normalizeServer({ name: 'x', command: '' }), /Enter the command/);
  assert.throws(() => normalizeServer({ name: 'x', command: 'y', env: 'not a pair' }), /NAME=value/);
  assert.throws(() => normalizeServer({ name: 'GitHub', command: 'y' }, [{ name: 'github' }]), /already/);
});

test('normalizeServer checks a URL server and its headers', () => {
  const s = normalizeServer({ name: 'docs', type: 'http', url: ' https://mcp.example.com/mcp ', headers: 'Authorization: Bearer xyz' });
  assert.deepEqual(s, { name: 'docs', type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer xyz' } });
  assert.throws(() => normalizeServer({ name: 'x', type: 'http', url: 'nope' }), /isn't valid/);
  assert.throws(() => normalizeServer({ name: 'x', type: 'http', url: 'file:///etc/passwd' }), /https:\/\//);
});

test('claudeMcpConfig writes Claude Code\'s --mcp-config shape', () => {
  const cfg = claudeMcpConfig([
    { name: 'github', type: 'stdio', command: 'npx', args: ['-y', 'gh'], env: { T: '1' } },
    { name: 'docs', type: 'http', url: 'https://x.dev/mcp', headers: {} },
  ]);
  assert.deepEqual(cfg, { mcpServers: {
    github: { type: 'stdio', command: 'npx', args: ['-y', 'gh'], env: { T: '1' } },
    docs: { type: 'http', url: 'https://x.dev/mcp' },
  } });
});

test('serverDetail shows the command or URL, never env values', () => {
  assert.equal(serverDetail({ type: 'stdio', command: 'npx', args: ['-y', 'gh'], env: { TOKEN: 'secret' } }), 'npx -y gh');
  assert.equal(serverDetail({ type: 'http', url: 'https://x.dev/mcp' }), 'https://x.dev/mcp');
});

test('claudeConfigured reads user, local and project servers', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-mcp-'));
  const root = path.join(base, 'proj');
  fs.mkdirSync(root);
  const claudeJson = path.join(base, '.claude.json');
  fs.writeFileSync(claudeJson, JSON.stringify({
    mcpServers: { github: { command: 'npx', args: ['gh'] } },
    projects: { [root]: { mcpServers: { db: { type: 'http', url: 'https://db.dev/mcp' } } } },
  }));
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { team: { command: 'team-mcp' } } }));
  assert.deepEqual(claudeConfigured({ claudeJson, root }), [
    { name: 'github', scope: 'user', type: 'stdio', detail: 'npx gh' },
    { name: 'db', scope: 'local', type: 'http', detail: 'https://db.dev/mcp' },
    { name: 'team', scope: 'project', type: 'stdio', detail: 'team-mcp' },
  ]);
  assert.deepEqual(claudeConfigured({ claudeJson: path.join(base, 'missing.json'), root: null }), []);
});
