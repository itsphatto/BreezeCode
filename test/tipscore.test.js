const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const ctx = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(fs.readFileSync(require.resolve('../src/renderer/breeze/tipscore.ts'), 'utf8')), ctx);
const [TIPS, tipsState, shouldOffer, markSeen, placeTip, tipTargetVisible, tipSceneAction, tipTakesEscape] = ['TIPS', 'tipsState', 'shouldOffer', 'markSeen', 'placeTip', 'tipTargetVisible', 'tipSceneAction', 'tipTakesEscape'].map(n => vm.runInContext(n, ctx));
const plain = v => JSON.parse(JSON.stringify(v));

test('every screen has one tip with the spec wording', () => {
  assert.deepEqual(plain(TIPS.map(t => [t.id, t.target])), [['editor', '#ide .agents .composer-box'], ['scm', '#scmGenMsg'], ['board', '#boardSideNew'], ['debug', '#dbgGo'], ['agents', '#pickList']]);
  for (const t of TIPS) assert.equal((t.text.match(/\*\*/g) || []).length, 2, t.id);
});

test('tipsState repairs bad stored values', () => {
  assert.deepEqual(plain(tipsState(null)), { seen: [], skipped: false });
  assert.deepEqual(plain(tipsState({ seen: ['board', 'nope', 3], skipped: 'yes' })), { seen: ['board'], skipped: false });
});

test('shouldOffer: only after setup, once per tip, never after skip all', () => {
  const s = tipsState(null);
  assert.equal(shouldOffer(s, 'board', false), false);
  assert.equal(shouldOffer(s, 'board', true), true);
  assert.equal(shouldOffer(markSeen(s, 'board'), 'board', true), false);
  assert.equal(shouldOffer(markSeen(s, 'board'), 'debug', true), true);
  assert.equal(shouldOffer({ seen: [], skipped: true }, 'debug', true), false);
});

test('markSeen adds once and leaves the input alone', () => {
  const s = tipsState(null), a = markSeen(markSeen(s, 'scm'), 'scm');
  assert.deepEqual(plain(a.seen), ['scm']);
  assert.deepEqual(plain(s.seen), []);
});

test('placeTip: above when there is room, centred on the target', () => {
  const p = placeTip({ left: 500, top: 400, width: 40, height: 20 }, { width: 260, height: 100 }, { width: 1200, height: 800 });
  assert.deepEqual(plain(p), { left: 390, top: 290, side: 'above', arrowX: 130 });
});

test('placeTip: flips below near the top and stays inside the window', () => {
  const p = placeTip({ left: 1170, top: 10, width: 24, height: 24 }, { width: 260, height: 100 }, { width: 1200, height: 800 });
  assert.equal(p.side, 'below');
  assert.equal(p.top, 44);
  assert.equal(p.left, 1200 - 8 - 260);
  assert.equal(p.arrowX, 244); // the target's centre (1182 - 932 = 250), clamped 16px inside the bubble's edge
});

test('tipTargetVisible: a control squeezed shut or past the window edge gets no bubble', () => {
  const view = { width: 1200, height: 800 };
  assert.equal(tipTargetVisible({ left: 500, top: 400, width: 40, height: 20 }, view), true);
  assert.equal(tipTargetVisible({ left: 1201, top: 575, width: 4, height: 30 }, view), false); // a closed side panel's prompt
  assert.equal(tipTargetVisible({ left: 1196, top: 575, width: 40, height: 30 }, view), false); // mostly off the right edge
  assert.equal(tipTargetVisible({ left: 500, top: 400, width: 0, height: 20 }, view), false);
});

test('placeTip: a tall target in a short window keeps the bubble inside the bottom edge', () => {
  const p = placeTip({ left: 400, top: 60, width: 400, height: 500 }, { width: 260, height: 120 }, { width: 1200, height: 600 });
  assert.equal(p.side, 'below');
  assert.equal(p.top, 600 - 8 - 120);
});

test('tipSceneAction: a dialog over the screen or a screen still fading in hides the bubble; a screen left closes it', () => {
  const calm = { settling: false, leaving: false, dialogOver: false };
  assert.equal(tipSceneAction(calm), 'show');
  assert.equal(tipSceneAction({ ...calm, dialogOver: true }), 'wait'); // Settings opened over the editor
  assert.equal(tipSceneAction({ ...calm, settling: true }), 'wait'); // the board still laying out unseen
  assert.equal(tipSceneAction({ ...calm, leaving: true, dialogOver: true }), 'close');
});

test('tipTakesEscape: only when nothing else is waiting for that Escape', () => {
  const calm = { menuOpen: false, dialogOver: false, typing: false };
  assert.equal(tipTakesEscape(calm), true);
  assert.equal(tipTakesEscape({ ...calm, menuOpen: true }), false); // a menu closes first
  assert.equal(tipTakesEscape({ ...calm, dialogOver: true }), false); // Settings over the editor
  assert.equal(tipTakesEscape({ ...calm, typing: true }), false); // autocomplete, find bar, search box
});
