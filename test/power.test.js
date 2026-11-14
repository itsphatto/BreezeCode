// The power saver's decision (src/main/power.ts): pure, with Electron's powerMonitor passed in.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PowerService, resolvePower, isLowEnd, asPowerMode, LOW_END_MEM } = require('../src/main/power.js');

const GB = 1024 ** 3;
// A stand-in for powerMonitor: flips between battery and mains on demand.
function source(onBattery = false) {
  const cbs = { 'on-battery': [], 'on-ac': [] };
  return {
    isOnBatteryPower: () => onBattery,
    on: (ev, cb) => { cbs[ev].push(cb); },
    unplug() { onBattery = true; cbs['on-battery'].forEach(cb => cb()); },
    plug() { onBattery = false; cbs['on-ac'].forEach(cb => cb()); },
  };
}
const strong = { cpus: 12, totalMem: 32 * GB };

test('low-end means four cores or fewer, or 8 GB or less', () => {
  assert.equal(isLowEnd(4, 32 * GB), true);
  assert.equal(isLowEnd(12, 8 * GB), true);
  assert.equal(isLowEnd(12, 7.8 * GB), true); // what an "8 GB" laptop reports
  assert.equal(isLowEnd(6, 16 * GB), false);
  assert.equal(LOW_END_MEM, 8 * GB);
});

test('an unknown saved mode falls back to Auto', () => {
  assert.equal(asPowerMode('on'), 'on');
  assert.equal(asPowerMode('off'), 'off');
  assert.equal(asPowerMode(undefined), 'auto');
  assert.equal(asPowerMode('turbo'), 'auto');
});

test('Auto: on for battery or low-end hardware, off otherwise', () => {
  assert.deepEqual(resolvePower('auto', false, false), { mode: 'auto', saver: false, onBattery: false, lowEnd: false, reason: null });
  assert.equal(resolvePower('auto', true, false).reason, 'battery');
  assert.equal(resolvePower('auto', false, true).reason, 'lowend');
  assert.equal(resolvePower('auto', true, true).reason, 'battery');
});

test('Always on and Off override the machine', () => {
  assert.equal(resolvePower('on', false, false).saver, true);
  assert.equal(resolvePower('on', false, false).reason, 'forced');
  assert.equal(resolvePower('off', true, true).saver, false);
  assert.equal(resolvePower('off', true, true).reason, null);
});

test('plugged in on a strong machine, Auto stays off', () => {
  const p = new PowerService({ mode: 'auto', ...strong });
  p.watch(source(false));
  assert.equal(p.state().saver, false);
});

test('unplugging and plugging back in reach the listeners live', () => {
  const p = new PowerService({ ...strong }), src = source(false), seen = [];
  p.onChange(s => seen.push([s.saver, s.reason]));
  p.watch(src);
  src.unplug();
  src.plug();
  assert.deepEqual(seen, [[true, 'battery'], [false, null]]);
});

test('starting on battery is seen as soon as the monitor is watched', () => {
  const p = new PowerService({ ...strong }), seen = [];
  p.onChange(s => seen.push(s.saver));
  assert.equal(p.state().saver, false); // not known before the app is ready
  p.watch(source(true));
  assert.deepEqual(seen, [true]);
  assert.equal(p.state().onBattery, true);
});

test('a low-end machine is in saver before the monitor is read', () => {
  const p = new PowerService({ cpus: 4, totalMem: 8 * GB });
  assert.equal(p.state().saver, true);
  assert.equal(p.state().reason, 'lowend');
  assert.equal(p.setMode('off').saver, false);
});

test('setMode tells the listeners, and only when something changed', () => {
  const p = new PowerService({ ...strong }), seen = [];
  p.onChange(s => seen.push(s.mode));
  p.setMode('on');
  p.setMode('on');
  p.setMode('nonsense'); // read as Auto
  assert.deepEqual(seen, ['on', 'auto']);
});

test('a stopped listener hears nothing more', () => {
  const p = new PowerService({ ...strong }), seen = [];
  const stop = p.onChange(s => seen.push(s.mode));
  stop();
  p.setMode('on');
  assert.deepEqual(seen, []);
});

test('a monitor that throws reads as mains', () => {
  const p = new PowerService({ ...strong });
  p.watch({ isOnBatteryPower() { throw new Error('no battery API'); }, on() { /* never fires */ } });
  assert.equal(p.state().saver, false);
});
