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

test('agent chips can be dragged (the global -webkit-user-drag: none is undone for them)', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/breeze.css'), 'utf8');
  assert.match(css, /\.board-chip\[draggable="true"\]\s*\{\s*-webkit-user-drag: element;/);
});

test('clicking an empty box opens the agent picker', () => {
  const board = fs.readFileSync(path.join(__dirname, '../src/renderer/breeze/board.ts'), 'utf8');
  assert.match(board, /boardGrid\.addEventListener\('click'[\s\S]{0,160}pickAgentFor\(/);
});

test("a board box's prompt is the Agents tab's: its text layer, model chips, Full access, and the same code", () => {
  const board = fs.readFileSync(path.join(__dirname, '../src/renderer/breeze/board.ts'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/breeze.html'), 'utf8');
  // The textarea's own text is transparent (breeze.css): without the layer, what you type can't be seen.
  for (const part of ['<div class="prompt-hl"', '<span class="prompt-models"', 'data-full-access']) {
    assert.ok(html.includes(part), `Agents tab has ${part}`);
    assert.ok(board.includes(part), `board box has ${part}`);
  }
  assert.match(board, /wirePromptKit\(kit\)/);
  assert.match(board, /addEventListener\('input', \(\) => syncPromptHl\(kit\)\)/);
});

test("a board box's header shows its agent's model", () => {
  const board = fs.readFileSync(path.join(__dirname, '../src/renderer/breeze/board.ts'), 'utf8');
  const setup = fs.readFileSync(path.join(__dirname, '../src/renderer/breeze/setup.ts'), 'utf8');
  assert.match(board, /function paintBoxModel\(box: BoardBox\)/);
  assert.match(setup, /renderBoardModels\(\)/); // a model change elsewhere repaints the boxes
});

test('a finished run leaves a board box its own placeholder', () => {
  const teams = fs.readFileSync(path.join(__dirname, '../src/renderer/breeze/teams.ts'), 'utf8');
  for (const l of teams.split('\n').filter(x => x.includes("s.prompt.placeholder = s.name === 'box'"))) {
    assert.match(l, /if \(!isBoardSurface\(s\.name\)\)/, l.trim());
  }
});

test('Enter on a roster chip does not type a newline into the new box', () => {
  const board = fs.readFileSync(path.join(__dirname, '../src/renderer/breeze/board.ts'), 'utf8');
  assert.match(board, /e\.key !== 'Enter'\) return;\s*e\.preventDefault\(\);/);
  assert.match(board, /<textarea rows="1" data-no-grow/);
});

test("the folder watcher and every agent's shell commands reach the board", () => {
  assert.match(main, /board\?\.diskChanged\(rel\)/);
  assert.match(main, /c\.name === 'Bash' && c\.id\)[\s\S]{0,120}shellEvent\(runId, c\.id,/);
  assert.match(main, /d\.type === 'item\.started' && d\.item\?\.type === 'command_execution'[\s\S]{0,80}shellEvent\(/);
  assert.match(main, /const shellId = `sh_\$\{\+\+shellSeq\}`;\s*shellEvent\(ctx\.runId, shellId, command\);/);
});

test("a board run's model and effort reach every agent's launch, over the saved ones", () => {
  assert.match(main, /handle\('board:run'[\s\S]{0,900}pick: boardPick\(o, agent\.id\)/);
  assert.match(main, /const model = pick\?\.model \?\? st\.claudeModel;/);
  assert.match(main, /const effort = effortArg\(pick\?\.effort \?\? st\.claudeEffort\);/);
  assert.match(main, /const model = pick\?\.model \?\? st\.codexModel;/);
  assert.match(main, /const effort = effortArg\(pick\?\.effort \?\? st\.codexEffort\);/);
  assert.match(main, /const model = run\.pick\?\.model \|\| st\.antigravityModel/);
  assert.match(main, /run\.pick\?\.model && cfg\.models\?\.includes\(run\.pick\.model\)/);
});

test("a box's own model is saved, picked on its chip and header, and sent with its runs", () => {
  const board = fs.readFileSync(path.join(__dirname, '../src/renderer/breeze/board.ts'), 'utf8');
  const teams = fs.readFileSync(path.join(__dirname, '../src/renderer/breeze/teams.ts'), 'utf8');
  assert.match(board, /model: b\.model, effort: b\.effort/); // saved with the board
  assert.match(board, /target: \(\) => boxModelTarget\(box\)/); // the prompt chip
  assert.match(board, /modelPickerItems\(ag, false, boxModelTarget\(box\)\)/); // the header
  assert.match(teams, /api\.board\.run\(\{[^}]*\.\.\.boardPickOf\(/);
});

test('the board lays its boxes out for how many there are, and morphs between layouts', () => {
  const board = fs.readFileSync(path.join(__dirname, '../src/renderer/breeze/board.ts'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/breeze.css'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/breeze.html'), 'utf8');
  assert.ok(html.indexOf('breeze/boardlayout.js') > 0 && html.indexOf('breeze/boardlayout.js') < html.indexOf('breeze/board.js'));
  assert.match(board, /const lay = boardLayout\(els\.length, boardGrid\.clientWidth\)/);
  assert.match(board, /document\.startViewTransition\(\(\) => \{ change\(\); name\(\); \}\)/);
  for (const fn of ['function dropAgent', 'async function emptyBox', 'function toggleMaxBox']) {
    const body = board.slice(board.indexOf(fn), board.indexOf('\n}', board.indexOf(fn)));
    assert.match(body, /morphBoard\(/, fn);
  }
  assert.match(css, /:root\.board-morph::view-transition \{\s*pointer-events: none;/); // a drag goes on through it
});

test('a roster chip click and the header split button add an agent in a box of its own', () => {
  const board = fs.readFileSync(path.join(__dirname, '../src/renderer/breeze/board.ts'), 'utf8');
  assert.match(board, /\$\('#boardRoster'\)\.addEventListener\('click'[\s\S]{0,160}addAgent\(chip\.dataset\.agent!\)/);
  assert.match(board, /\$\('\.board-box-split', el\)\.onclick[\s\S]{0,300}addAgent\(a\.id\)/);
});
