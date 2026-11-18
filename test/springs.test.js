// Source-text checks: the spring curves are written out three times (breeze.css, launch.css for the splash window,
// core.ts for el.animate()), so they must stay the same, and every var(--spring…) used must exist.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = f => fs.readFileSync(path.join(__dirname, '../src/renderer', f), 'utf8');
const css = read('breeze.css'), launch = read('launch.css'), core = read('breeze/core.ts');
const token = (src, name) => new RegExp(`--${name}: (linear\\([^)]*\\));`).exec(src)?.[1];

test('the springs match in breeze.css, launch.css and core.ts', () => {
  const spring = token(css, 'spring'), bounce = token(css, 'spring-bounce');
  assert.ok(spring && bounce);
  assert.equal(token(launch, 'spring'), spring);
  assert.ok(core.includes(`const SPRING = '${spring}';`));
  assert.ok(core.includes(`const SPRING_BOUNCE = '${bounce}';`));
});

test('each spring starts at 0, settles at 1 and overshoots on the way', () => {
  for (const name of ['spring', 'spring-bounce']) {
    const v = token(css, name).slice(7, -1).split(',').map(Number);
    assert.equal(v[0], 0);
    assert.equal(v.at(-1), 1);
    assert.ok(Math.max(...v) > 1, name);
  }
});

test('launch.css only uses the spring it defines', () => {
  assert.ok(!launch.includes('var(--spring-bounce)'));
});
