// Source-text checks: the Agent board page is in the app (the renderer needs a browser to run).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const src = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('the page, its button and its script are in breeze.html', () => {
  const html = src('src/renderer/breeze.html');
  assert.match(html, /id="boardBtn"/);
  assert.match(html, /id="board"/);
  assert.match(html, /<script src="breeze\/board\.js" defer><\/script>/);
  assert.ok(html.indexOf('breeze/teams.js') < html.indexOf('breeze/board.js'), 'after teams.js');
  assert.ok(html.indexOf('breeze/board.js') < html.indexOf('breeze/views.js'), 'before views.js');
});

test('board.ts is compiled', () => {
  assert.ok(JSON.parse(src('tsconfig.json')).files.includes('src/renderer/breeze/board.ts'));
});

test('swapScreen knows the board page', () => {
  assert.match(src('src/renderer/breeze/setup.ts'), /\['#onboard', '#ide', '#box', '#debug', '#board'\]/);
});

test('agents drag into boxes and Ctrl+Shift+B opens the board', () => {
  const b = src('src/renderer/breeze/board.ts');
  for (const ev of ["'dragstart'", "'dragover'", "'drop'"]) assert.ok(b.includes(ev), ev);
  assert.match(src('src/renderer/breeze/commands.ts'), /act: 'view\.board', key: 'Ctrl\+Shift\+B'/);
});
