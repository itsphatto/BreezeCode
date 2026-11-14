// Source-text checks: the board's IPC, preload API and folder-change stop are wired (main.ts needs Electron to run).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const main = fs.readFileSync(path.join(__dirname, '../src/main/main.ts'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, '../src/main/preload.ts'), 'utf8');

test('main handles every board call', () => {
  for (const ch of ['board:open', 'board:run', 'board:stop', 'board:stopAll', 'board:release', 'board:owners']) {
    assert.ok(main.includes(`handle('${ch}'`), ch);
  }
});

test('a folder change closes the board next to the teams', () => {
  const lines = main.split('\n').filter(l => l.includes('stopTeams();'));
  assert.equal(lines.length, 2);
  for (const l of lines) assert.ok(l.includes('stopBoard();'), l.trim());
});

test('a blocked team write also relays on a board', () => {
  assert.match(main, /coordinator\.blocked\?\.\(agentId, owner, rel\)/);
});

test('preload exposes api.board', () => {
  assert.match(preload, /board: \{/);
  for (const ch of ['board:open', 'board:run', 'board:stop', 'board:stopAll', 'board:release', 'board:owners']) {
    assert.ok(preload.includes(`invoke('${ch}'`), ch);
  }
});

test("Claude's tool results say when a write landed or was refused", () => {
  assert.match(main, /t: 'written'/);
  assert.match(main, /t: 'refused'/);
  assert.match(main, /tool_result/);
});

test('an emptied box is cleared in main', () => {
  assert.ok(main.includes("handle('board:clearBox'"));
  assert.ok(preload.includes("invoke('board:clearBox'"));
});
