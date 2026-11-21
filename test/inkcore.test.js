const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const ctx = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(fs.readFileSync(require.resolve('../src/renderer/breeze/inkcore.ts'), 'utf8')), ctx);
const { inkParse, inkLum, inkRatio, inkFor, inkMix } = vm.runInContext('({ inkParse, inkLum, inkRatio, inkFor, inkMix })', ctx);

test('reads the colours the theme writes', () => {
  assert.deepEqual([...inkParse('#9a9a9f')], [154, 154, 159]);
  assert.deepEqual([...inkParse(' #abc')], [170, 187, 204]);
  assert.deepEqual([...inkParse('rgb(10, 20, 30)')], [10, 20, 30]);
  assert.deepEqual([...inkParse('rgba(10 20 30 / .5)')], [10, 20, 30]);
  assert.equal(inkParse('var(--x)'), null);
});

test('contrast matches WCAG', () => {
  assert.equal(Math.round(inkRatio(inkLum([255, 255, 255]), inkLum([0, 0, 0]))), 21);
  assert.ok(Math.abs(inkRatio(inkLum([118, 118, 118]), inkLum([255, 255, 255])) - 4.54) < .02); // #767676 on white
});

test('a colour that already reads is left alone', () => {
  const ink = [154, 154, 159];
  assert.deepEqual([...inkFor(ink, inkLum([29, 29, 31]))], ink);
});

test('light text over a brighter backdrop moves toward white only as far as it must', () => {
  const bg = inkLum([110, 75, 55]); // a warm picture showing through a bar
  const ink = [154, 154, 159];
  const out = inkFor(ink, bg);
  assert.ok(inkRatio(inkLum(out), bg) >= 4.5);
  assert.ok(out.every((c, i) => c > ink[i]), 'lighter');
  assert.ok(inkRatio(inkLum(out), bg) < 4.7, 'no further than needed');
});

test('dark ink over a darker backdrop moves toward black', () => {
  const bg = inkLum([150, 140, 130]);
  const out = inkFor([87, 81, 74], bg);
  assert.ok(inkRatio(inkLum(out), bg) >= 4.5);
  assert.ok(out[0] < 87);
});

test('white when nothing short of it reads', () => {
  assert.deepEqual([...inkFor([170, 170, 170], inkLum([140, 140, 140]))], [255, 255, 255]);
});

test('says how far a colour must move: none, part of the way, or more than all of it', () => {
  assert.equal(inkMix([245, 245, 247], inkLum([29, 29, 31])), 0);
  const t = inkMix([34, 197, 94], inkLum([90, 90, 90])); // green on a mid grey
  assert.ok(t > 0 && t < 1);
  assert.equal(inkMix([170, 170, 170], inkLum([140, 140, 140])), Infinity);
});
