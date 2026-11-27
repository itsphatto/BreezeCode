const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { imagePathsIn, imageRefusal, imageMime, NOT_IMAGE } = require('../src/main/agentimages');
const { BREEZE_TOOLS } = require('../src/main/breezemcp');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('imagePathsIn finds picture paths in replies and command output', () => {
  assert.deepEqual(imagePathsIn('I saved the chart to out/chart.png.'), ['out/chart.png']);
  assert.deepEqual(imagePathsIn('See `assets/logo.svg` and ![shot](./shots/home.webp)'), ['assets/logo.svg', 'shots/home.webp']);
  assert.deepEqual(imagePathsIn('Wrote "C:\\work\\app\\icon.JPG", then docs\\a.jpeg: done'), ['C:\\work\\app\\icon.JPG', 'docs\\a.jpeg']);
  assert.deepEqual(imagePathsIn('a.png a.png b.gif'), ['a.png', 'b.gif']);
});

test('imagePathsIn leaves out web addresses, patterns and look-alikes', () => {
  assert.deepEqual(imagePathsIn('From https://example.com/cat.png and //cdn.x/y.png'), []);
  assert.deepEqual(imagePathsIn('Ran glob **/*.png and src/{a,b}.png'), []);
  assert.deepEqual(imagePathsIn('backup.png.bak and pngs and file.pngx'), []);
  assert.equal(imagePathsIn(Array.from({ length: 20 }, (_, i) => `p${i}.png`).join(' ')).length, 6);
  assert.deepEqual(imagePathsIn(null), []);
});

test('imageRefusal keeps the file tools\' rules', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-img-'));
  const stash = fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-stash-'));
  try {
    assert.equal(imageRefusal(base, path.join(base, 'shots', 'a.png')), null);
    assert.equal(imageRefusal(base, path.join(base, 'notes.txt')), NOT_IMAGE);
    assert.match(imageRefusal(base, path.join(base, '..', 'other.png')), /outside|project/i);
    assert.match(imageRefusal(base, path.join(base, '.git', 'x.png')), /\.git/);
    assert.match(imageRefusal(base, path.join(base, '.env.png')), /secrets/);
    // The screenshot stash is always fine; full access lifts the project rules, but a picture is still a picture.
    assert.equal(imageRefusal(base, path.join(stash, 'abc', 'preview.png'), { extra: [stash] }), null);
    assert.equal(imageRefusal(base, path.join(base, '..', 'other.png'), { full: true }), null);
    assert.equal(imageRefusal(base, path.join(base, '..', 'other.exe'), { full: true }), NOT_IMAGE);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(stash, { recursive: true, force: true });
  }
});

test('imageMime names each picture type', () => {
  assert.equal(imageMime('a.PNG'), 'image/png');
  assert.equal(imageMime('a.jpeg'), 'image/jpeg');
  assert.equal(imageMime('a.svg'), 'image/svg+xml');
});

test('show_image reaches every agent type that can take a tool', () => {
  assert.ok(BREEZE_TOOLS.some(t => t.name === 'show_image'), 'Claude Code and Codex get it through Breeze\'s MCP server');
  const main = read('src/main/main.ts');
  assert.match(main, /name: 'show_image'/, 'local models get it as a tool');
  assert.match(main, /show_image: \(ctx, a\) =>/);
  assert.match(main, /show_image: async \(runId, args\)/);
  // Pictures in replies and command output show for every agent, Antigravity included.
  assert.match(main, /watchImages\(runId, ev\)/);
});

test('check_artifact reaches every agent type and hands back both screenshots', async () => {
  const { handleRpc } = require('../src/main/breezemcp');
  const tool = BREEZE_TOOLS.find(t => t.name === 'check_artifact');
  assert.ok(tool, 'Claude Code and Codex get it through Breeze\'s MCP server');
  assert.deepEqual(tool.inputSchema.required, ['language', 'code']);
  const main = read('src/main/main.ts');
  assert.match(main, /name: 'check_artifact'/, 'local models get it as a tool');
  assert.match(main, /check_artifact: \(ctx, a\) =>/);
  assert.match(main, /check_artifact: async \(runId, args, signal\)/);
  // Its sizes are the chat's: the frame's 16:10 at Breeze Space's width, and the dialog opened large.
  assert.match(main, /width: 760, height: 475/);
  assert.match(read('src/renderer/breeze.css'), /\.artifact-frame \{[^}]*aspect-ratio: 16 \/ 10;[^}]*max-height: 480px;/);
  // One reply carries several pictures, in order.
  const png = n => ({ data: `P${n}`, mimeType: 'image/png' });
  const out = await handleRpc({ id: 1, method: 'tools/call', params: { name: 'check_artifact', arguments: { language: 'html', code: '<!doctype html>' } } }, BREEZE_TOOLS, async () => ({ text: 'Ran it', images: [png(1), png(2)] }));
  assert.deepEqual(out.result.content, [{ type: 'text', text: 'Ran it' }, { type: 'image', data: 'P1', mimeType: 'image/png' }, { type: 'image', data: 'P2', mimeType: 'image/png' }]);
});

test('the chat draws an agent\'s picture with the attachment lightbox', () => {
  const teams = read('src/renderer/breeze/teams.ts');
  assert.match(teams, /image: \(r, ev, tab\) => agentImage\(r, ev, tab\)/);
  assert.match(teams, /class="chat-img"/);
});
