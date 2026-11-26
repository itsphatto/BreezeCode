// Source-text checks: the first-run tips are loaded by the page, styled in the stylesheet and offered by each screen
// (the renderer files are page scripts that need a browser to run).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const css = read('src/renderer/breeze.css');
const page = read('src/renderer/breeze.html');
const r = name => read(`src/renderer/breeze/${name}.ts`);

test('page loads the tip scripts in order', () => {
  assert.ok(page.indexOf('breeze/tipscore.js') > page.indexOf('breeze/statuscore.js'));
  assert.ok(page.includes('breeze/tips.js'));
  assert.ok(page.indexOf('breeze/tips.js') < page.indexOf('breeze/whatsnew.js'));
});

test('bubble is blue, readable, and styled in the stylesheet', () => {
  assert.match(css, /\.tip-bubble\s*\{[^}]*background:\s*var\(--blue\)/);
  assert.match(css, /\.tip-bubble\s*\{[^}]*color:\s*var\(--on-blue\)/);
  assert.match(css, /\.tip-act\s*\{[^}]*border:[^;]*dashed/);
});

test('tips respect seen-state, motion and the power saver', () => {
  const t = r('tips');
  assert.match(t, /store\.get[^\n]*'breeze\.tipsSeen'/);
  assert.match(t, /motionReduced\(\)/);
  assert.match(t, /dataset\.power/);
  assert.doesNotMatch(t, /setAttribute\('style'/);
});

// A function's body: from its declaration to the first line that is just "}".
const fnBody = (src, fn) => { const s = src.slice(src.indexOf(`function ${fn}(`)); return s.slice(0, s.indexOf('\n}\n')); };

test('each screen offers its tip when it opens', () => {
  for (const [file, fn, id] of [['setup', 'showIde', 'editor'], ['setup', 'openAgentPicker', 'agents'], ['prs', 'openScmPage', 'scm'], ['board', 'openBoard', 'board'], ['debugview', 'openDebugView', 'debug']]) {
    assert.ok(fnBody(r(file), fn).includes(`offerTip('${id}'`), `${fn} → ${id}`);
  }
});

test('Settings can bring the tips back', () => {
  const s = r('settings');
  assert.match(s, /id="sTipsReset"/);
  assert.match(s, /on\('sTipsReset'[^\n]*resetTips\(\)/);
});

test('opening the agents panel offers the editor tip, once the panel has slid open', () => {
  const c = r('commands');
  const toggle = c.slice(c.indexOf("'view.toggleAgents'"), c.indexOf("'view.togglePreview'"));
  assert.match(toggle, /if \(layout\.agentsOpen\) setTimeout\(\(\) => offerTip\('editor'/);
});

test('the bubble defers to dialogs, settling screens and other Escape users', () => {
  const t = r('tips');
  assert.match(t, /tipSceneAction\(/);
  assert.match(t, /tipTakesEscape\(/);
  assert.match(t, /screen-prep/);
  assert.match(t, /screen-out/);
  assert.match(t, /topScrim\(\)/);
  assert.match(css, /\.tip-bubble\.tip-wait\s*\{[^}]*visibility:\s*hidden/);
});
