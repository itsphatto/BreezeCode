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

test('a folder change stops the teams, and leaves the board working in its own folder', () => {
  assert.equal(main.split('\n').filter(l => l.includes('stopTeams();')).length, 2);
  assert.doesNotMatch(main, /stopBoard/);
  assert.match(main, /startRun: o => launchRun\(\{ \.\.\.o, taskBase: dir \}\)/); // never in whichever folder is open by then
  assert.match(main, /boards\.forRun\(typeof o\.root === 'string' \? o\.root : null, root\)/);
});

test('paths of a box working in another project never touch the open one', () => {
  const src = f => fs.readFileSync(path.join(__dirname, '../src/renderer/breeze', f), 'utf8');
  assert.match(main, /const from = runFolder\(runId\);/);
  assert.doesNotMatch(main, /relOut\([^(),]+\)/); // each call says whose run it is
  const teams = src('teams.ts');
  for (const fn of ['function onAgentFile', 'function onAgentDraft', 'function dropUnwrittenDrafts']) assert.match(fnBody(teams, fn), /if \(surfaceAway\(r\.surfaceName\)\) return;/, fn);
  assert.match(fnBody(teams, 'function finishRun'), /if \(!away\) background\(fillEditCounts/);
  assert.match(src('agents.ts'), /s\.folder \?\? rootInfo\?\.root/); // its chat is filed in its own project
  const load = fnBody(src('board.ts'), 'function loadBoard()');
  assert.doesNotMatch(load, /stopBox|parkedBoxes\.clear/);
  assert.match(load, /closeBoxes\(\[\.\.\.boardBoxes\.values\(\)\]\)/);
});

test('the renderer and main agree on how many boxes there can be', () => {
  const board = fs.readFileSync(path.join(__dirname, '../src/renderer/breeze/board.ts'), 'utf8');
  const n = Number(/BOARD_KEYS = (\d+)/.exec(board)[1]);
  const re = new RegExp(/const BOX_KEY = \/(.+?)\/;/.exec(main)[1]);
  for (let i = 1; i <= n; i++) assert.match(`box${i}`, re);
  assert.doesNotMatch('box0', re);
  assert.doesNotMatch(`box${n + 1}`, re);
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

test('side-bar chats can be dragged (the global -webkit-user-drag: none is undone for them)', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/breeze.css'), 'utf8');
  assert.match(css, /\.board-side \.box-side-chat\[draggable="true"\]\s*\{\s*-webkit-user-drag: element;/);
});

test('clicking an empty box opens the agent picker', () => {
  const board = fs.readFileSync(path.join(__dirname, '../src/renderer/breeze/board.ts'), 'utf8');
  assert.match(board, /boardGrid\.addEventListener\('click'[\s\S]{0,160}pickAgentFor\(/);
});

test("a board box's prompt is the Agents tab's: its text layer, model chips, and the same code", () => {
  const board = fs.readFileSync(path.join(__dirname, '../src/renderer/breeze/board.ts'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/breeze.html'), 'utf8');
  // The textarea's own text is transparent (breeze.css): without the layer, what you type can't be seen.
  for (const part of ['<div class="prompt-hl"', '<span class="prompt-models"']) {
    assert.ok(html.includes(part), `Agents tab has ${part}`);
    assert.ok(board.includes(part), `board box has ${part}`);
  }
  assert.match(board, /wirePromptKit\(kit\)/);
  assert.match(board, /addEventListener\('input', \(\) => syncPromptHl\(kit\)\)/);
});

test("a board box's header shows its context right away, with no menu", () => {
  const board = fs.readFileSync(path.join(__dirname, '../src/renderer/breeze/board.ts'), 'utf8');
  const setup = fs.readFileSync(path.join(__dirname, '../src/renderer/breeze/setup.ts'), 'utf8');
  assert.match(board, /function paintBoxContext\(box: BoardBox\)/);
  assert.match(board, /`\$\{pct\}% · \$\{ctxTokens\(c\.used\)\} \/ \$\{ctxTokens\(c\.window\)\}`/);
  assert.doesNotMatch(board, /\.board-box-model', el\)\.onclick/);
  assert.match(setup, /renderBoardModels\(\)/); // a model change elsewhere repaints the boxes
});

test('a finished run leaves a board box its own placeholder', () => {
  const teams = fs.readFileSync(path.join(__dirname, '../src/renderer/breeze/teams.ts'), 'utf8');
  for (const l of teams.split('\n').filter(x => x.includes("s.prompt.placeholder = s.name === 'box'"))) {
    assert.match(l, /if \(!isBoardSurface\(s\.name\)\)/, l.trim());
  }
});

test('Enter on an empty box does not type a newline into the new box', () => {
  const board = fs.readFileSync(path.join(__dirname, '../src/renderer/breeze/board.ts'), 'utf8');
  assert.match(board, /e\.key !== 'Enter'\) return;\s*e\.preventDefault\(\);/);
  assert.match(board, /<textarea rows="1" data-no-grow/);
});

test("the folder watcher and every agent's shell commands reach the board", () => {
  assert.match(main, /boards\.find\(root\)\?\.diskChanged\(rel\)/);
  assert.match(main, /CLAUDE_SHELL_TOOLS\.includes\(c\.name\) && c\.id\)[\s\S]{0,120}shellEvent\(runId, c\.id,/);
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

test("a box's own model is saved, picked on its chip, and sent with its runs", () => {
  const board = fs.readFileSync(path.join(__dirname, '../src/renderer/breeze/board.ts'), 'utf8');
  const teams = fs.readFileSync(path.join(__dirname, '../src/renderer/breeze/teams.ts'), 'utf8');
  assert.match(board, /model: b\.model, effort: b\.effort/); // saved with the board
  assert.match(board, /target: \(\) => boxModelTarget\(box\)/); // the prompt chip
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

test('New chat and a side-bar chat click take the whole board; only a drag splits it', () => {
  const board = fs.readFileSync(path.join(__dirname, '../src/renderer/breeze/board.ts'), 'utf8');
  assert.match(board, /function newBoardChat\(\)[\s\S]{0,240}freshBoard\(agent\)/);
  assert.match(board, /function freshBoard[\s\S]{0,400}closeBoxes\(\[\.\.\.boardBoxes\.values\(\)\]\)/);
  assert.match(board, /reopenInBox\(e, undefined, undefined, true\)/);
  assert.doesNotMatch(board, /board-box-split/);
});

const fnBody = (src, fn) => { const i = src.indexOf(fn); assert.ok(i >= 0, fn); return src.slice(i, src.indexOf('\n}', i)); };

test('closing a chat never stops it: a working box carries on out of sight', () => {
  const board = fs.readFileSync(path.join(__dirname, '../src/renderer/breeze/board.ts'), 'utf8');
  const close = fnBody(board, 'async function emptyBox');
  assert.doesNotMatch(close, /stopBox|board\.stop|clearBox/);
  assert.match(close, /closeBoxes\(\[box\]\)/);
  // Waiting on a teammate's answer is working too; a parked box is kept for it, and for messages still queued.
  assert.match(fnBody(board, 'function closeBoxes'), /if \(boxAtWork\(b\)\) \{ parkBox\(b\); continue; \}/);
  assert.match(fnBody(board, 'function finishParked'), /boxAtWork\(b\) \|\| b\.tab\.queue\?\.length/);
  // Its answer may never come: the box that asked closes then.
  assert.match(fnBody(board, 'function closeAsk'), /finishParked\(b\)/);
});

test('a chat closed while it works keeps its composer, so its queued messages still go out', () => {
  const cmp = fs.readFileSync(path.join(__dirname, '../src/renderer/breeze/composerui.ts'), 'utf8');
  assert.match(fnBody(cmp, 'function refreshComposers'), /!c\.box\.isConnected && !parkedTab\(composerTab\(c\)\)/);
});

test('a reopened chat shows its latest message: scrolled once its box is laid out, not a frame after the click', () => {
  const board = fs.readFileSync(path.join(__dirname, '../src/renderer/breeze/board.ts'), 'utf8');
  const render = fnBody(board, 'function renderBoard(');
  assert.ok(render.indexOf('scrollRestoredChats()') > render.indexOf('layoutBoard()'), 'after layoutBoard');
  assert.match(render, /box\.scrollPending = true/); // put (back) in the grid, it lost its scroll
});
