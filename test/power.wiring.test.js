// Source-text checks: the power saver is wired through main, preload, the page's scripts and its styles
// (main.ts needs Electron to run, and the renderer files are page scripts).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const main = read('src/main/main.ts');
const preload = read('src/main/preload.ts');
const css = read('src/renderer/breeze.css');
const page = read('src/renderer/breeze.html');
const power = read('src/renderer/breeze/power.ts');
const r = name => read(`src/renderer/breeze/${name}.ts`);
// The stylesheet without its comments, and the power saver's own section of it.
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
const saver = rules.slice(rules.indexOf(':root[data-power="saver"]'));

test('main answers the power calls and keeps the choice', () => {
  for (const ch of ['power:get', 'power:setMode']) assert.ok(main.includes(`handle('${ch}'`), ch);
  assert.match(main, /saveState\(\{ powerMode: s\.mode \}\)/);
  assert.match(main, /new PowerService\(\{ mode: loadState\(\)\.powerMode, cpus: os\.cpus\(\)\.length, totalMem: os\.totalmem\(\) \}\)/);
});

test('main watches the battery once the app is ready and tells the page of changes', () => {
  assert.match(main, /power\.watch\(powerMonitor\)/);
  assert.ok(main.indexOf('await app.whenReady()') < main.indexOf('power.watch(powerMonitor)'));
  assert.match(main, /webContents\.send\('power:changed', s\)/);
});

test('animations are forced on only outside the power saver', () => {
  const lines = main.split('\n').filter(l => l.includes("appendSwitch('force-prefers-no-reduced-motion')"));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^if \(!power\.state\(\)\.saver && loadState\(\)\.powerSaverLast !== true\)/);
});

test('hardware acceleration stays on', () => {
  assert.ok(!main.includes('disableHardwareAcceleration'));
});

test('preload exposes api.power', () => {
  assert.match(preload, /power: \{/);
  for (const ch of ['power:get', 'power:setMode', 'power:changed']) assert.ok(preload.includes(`'${ch}'`), ch);
});

test('the page loads power.js before the scripts that ask it', () => {
  const at = name => page.indexOf(`<script src="breeze/${name}.js" defer>`);
  assert.ok(at('power') > at('platform'), 'after platform.js (api)');
  for (const name of ['greetings', 'setup', 'drop', 'editor', 'agents', 'space', 'git']) assert.ok(at(name) > at('power'), name);
  assert.ok(read('tsconfig.json').includes('"src/renderer/breeze/power.ts"'));
});

test('the page marks <html data-power="saver"> and clears it again', () => {
  assert.match(power, /document\.documentElement\.dataset\.power = 'saver'/);
  assert.match(power, /delete document\.documentElement\.dataset\.power/);
  assert.match(power, /api\.power\.onChange\(applyPower\)/);
});

test('decorative timers stop while the window is unseen, whatever the power state', () => {
  assert.match(power, /const decorUnseen = \(\): boolean => document\.hidden \|\| !pageFocused;/);
  assert.match(power, /const every = decorUnseen\(\) \? 0 : powerInfo\.saver \? saverMs \?\? 0 : ms;/);
  assert.match(power, /document\.addEventListener\('visibilitychange', decorChanged\)/);
  assert.match(power, /window\.addEventListener\('focus', focusChanged\)/);
});

test('Settings has the Performance choice', () => {
  const s = r('settings');
  assert.match(s, /settingRow\('Performance', powerNote\(\), segHtml\('sPower', \[\['auto', 'Auto'\], \['on', 'Always on'\], \['off', 'Off'\]\], powerInfo\.mode\)\)/);
  assert.match(s, /seg\('sPower', v => \{ if \(v !== powerInfo\.mode\) setPowerMode\(v as PowerMode\); \}\)/);
});

test('decorative loops go through the power gate', () => {
  assert.match(r('greetings'), /decorInterval\(tickGreeting, 10_000, 30_000\)/);
  assert.match(r('greetings'), /decorInterval\(\(\) => \{ if \(!frame && onHome\(\)\) frame = requestAnimationFrame\(step\); \}, 500\)/);
  assert.match(r('greetings'), /const onHome = \(\) => !decorResting\(\)/);
  assert.match(r('space'), /decorInterval\(kick, 500, 1000\)/);
  assert.match(r('space'), /if \(powerSaver\(\)\) \{ still = /);
  assert.match(r('space'), /if \(!frame && !powerSaver\(\) && document\.documentElement\.dataset\.theme !== 'light'\)/);
  assert.match(r('agents'), /decorInterval\(\(\) => \{\n  for \(const h of \$\$<HTMLElement>\('#boxChat \.empty h4'\)\)/);
  assert.match(r('agents'), /hoverTimer = powerSaver\(\) \? undefined : setInterval/);
  assert.match(r('setup'), /\}, DASH_REFRESH_MS, 15_000\);/);
  assert.match(r('drop'), /if \(state\.animId != null\) return;\n[^\n]*\n  if \(powerSaver\(\)\) return;/);
  // None of them is a bare setInterval any more.
  for (const name of ['greetings', 'space', 'setup']) assert.ok(!/^\s*setInterval\(/m.test(r(name)), name);
});

test('the saver shows the still logo, fetches less often and throttles the minimap', () => {
  assert.match(r('agents'), /const idleLogoFile = \(\): string => powerSaver\(\) \|\| matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches \? 'Agent\.png' : 'AgentIdle\.webp';/);
  assert.match(r('git'), /const fetchEvery = \(\): number => \(powerSaver\(\) \? 15 : 5\) \* 60_000;/);
  assert.match(r('editor'), /if \(powerSaver\(\)\) setTimeout\(draw, MM_SAVER_MS\); else draw\(\);/);
});

test('the editor draws at most once a frame', () => {
  const e = r('editor');
  assert.match(e, /function queueRender\(\): void \{\n  if \(renderQueued\) return;\n  renderQueued = true;\n  requestAnimationFrame/);
  assert.match(e, /function queueMinimap\(\): void \{\n  if \(mmQueued\) return;\n  mmQueued = true;/);
  assert.match(r('buffers'), /queueRender\(\); saveSession\(\);/); // typing queues, it doesn't draw
});

test('saver styles: blur off, glass near solid, loops stopped', () => {
  assert.match(saver, /--glass-blur: none;\s*--space-blur: none;\s*--settings-blur: none;/);
  assert.match(saver, /backdrop-filter: none !important;/);
  assert.match(saver, /animation-iteration-count: 1 !important;/);
  assert.match(saver, /--glass: rgba\(42, 42, 44, \.96\);/);
  // The caret and the spinners keep going.
  assert.match(saver, /:is\(\.spinner, \.code-caret,[^{]*\{\s*animation-iteration-count: infinite !important;/);
});

test('every power-saver rule is scoped to the attribute', () => {
  // Plugged in on an ordinary machine nothing may change: no rule in the section may apply without data-power.
  const selectors = [...saver.matchAll(/(?:^|\})\s*([^{}]+)\{/g)].map(m => m[1].trim()).filter(Boolean);
  assert.ok(selectors.length >= 10);
  for (const sel of selectors) {
    for (const part of sel.split(/,\n/)) assert.ok(part.trim().startsWith(':root[data-power="saver"]') || part.trim().startsWith('.work') , part);
  }
});

test('no body:has(): it made every DOM change restyle the whole page', () => {
  assert.ok(!/body:has\(/.test(rules));
  assert.ok(!/(^|[\s,}]):root:has\(/.test(rules));
  assert.match(rules, /body\.menu-up :focus-visible:not\(#menuRoot \*\)/);
  assert.match(rules, /body\.modal-up :is\(/);
  assert.match(power, /classList\.toggle\('menu-up', !!document\.querySelector\('#menuRoot > \.menu:not\(\.closing\)'\)\)/);
  assert.match(power, /classList\.toggle\('modal-up', !!document\.querySelector\('#modalRoot > \.scrim'\)\)/);
});
