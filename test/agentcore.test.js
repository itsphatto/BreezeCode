const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/main/agentcore');
const { AgentCore, parsePlan, parseVerdict, nextRunAt, pickRunnable, TriggerLimiter, matchTrigger, cleanSchedule, cleanTrigger } = core;

const tick = () => new Promise(r => setImmediate(r));
async function settle(n = 20) { for (let i = 0; i < n; i++) await tick(); }
const same = (a, b) => a === b;

// A fake world: `script` answers each run; asks answer from `answers` (approve by default).
function world({ script, answers = [], now = 1_000_000 } = {}) {
  const runs = [], asks = [], notes = [];
  let saved = null;
  const deps = {
    run: async (task, prompt, mode, signal) => {
      runs.push({ task: task.id, mode, prompt });
      const r = await script(task, prompt, mode, runs.length, signal);
      return r;
    },
    ask: async (task, q) => { asks.push(q); return answers.length ? answers.shift() : { approve: true }; },
    notify: (task, text) => notes.push(text),
    changed: () => {},
    save: tasks => { saved = JSON.parse(JSON.stringify(tasks)); },
    memory: () => '',
    now: () => now,
  };
  return { deps, runs, asks, notes, saved: () => saved, setNow: n => { now = n; } };
}
const PLAN = '```json\n[{"title":"Write it"},{"title":"Test it"}]\n```';

test('parsePlan reads JSON anywhere, then falls back to a list', () => {
  assert.deepEqual(parsePlan(PLAN).map(s => s.title), ['Write it', 'Test it']);
  assert.deepEqual(parsePlan('Sure: ["a", "b"] ok').map(s => s.title), ['a', 'b']);
  assert.deepEqual(parsePlan('{"steps":[{"step":"x","description":"y"}]}'.replace(/^/, '```\n') + '\n```'), [{ title: 'x', detail: 'y' }]);
  assert.deepEqual(parsePlan('1. First\n2) Second\n- Third\nnot a step').map(s => s.title), ['First', 'Second', 'Third']);
  assert.equal(parsePlan('nothing here').length, 0);
  assert.equal(parsePlan(JSON.stringify(Array.from({ length: 30 }, (_, i) => `s${i}`))).length, core.MAX_STEPS);
});

test('parseVerdict: the last marker wins, else how the run ended', () => {
  assert.deepEqual(parseVerdict('did it\nSTEP_DONE', true), { ok: true, note: '' });
  assert.deepEqual(parseVerdict('tried\nSTEP_FAILED: tests still red', true), { ok: false, note: 'tests still red' });
  assert.equal(parseVerdict('**STEP_DONE**', false).ok, true);
  assert.equal(parseVerdict('no marker', true).ok, true);
  assert.equal(parseVerdict('no marker', false).ok, false);
});

test('schedules: daily at a time and every N hours', () => {
  const from = new Date(2026, 0, 1, 8, 0).getTime();
  assert.equal(nextRunAt({ kind: 'daily', at: '09:00' }, from), new Date(2026, 0, 1, 9, 0).getTime());
  assert.equal(nextRunAt({ kind: 'daily', at: '07:30' }, from), new Date(2026, 0, 2, 7, 30).getTime());
  assert.equal(nextRunAt({ kind: 'every', hours: 3 }, from), from + 3 * 3600000);
  assert.deepEqual(cleanSchedule({ kind: 'daily', at: '25:00' }), null);
  assert.deepEqual(cleanSchedule({ kind: 'every', hours: 0 }), null);
  assert.deepEqual(cleanSchedule({ kind: 'every', hours: 2.4 }), { kind: 'every', hours: 2 });
  assert.deepEqual(cleanTrigger({ kind: 'nope' }), null);
  assert.deepEqual(cleanTrigger({ kind: 'save', match: ' *.ts ' }), { kind: 'save', match: '*.ts' });
});

test('queue: one task per project, two in all', () => {
  const t = (id, project, order, status = 'queued') => ({ id, project, order, status });
  const tasks = [t('a', 'p1', 1), t('b', 'p1', 2), t('c', 'p2', 3), t('d', 'p3', 4)];
  assert.deepEqual(pickRunnable(tasks, new Set()).map(x => x.id), ['a', 'c']);
  assert.deepEqual(pickRunnable(tasks, new Set(['a'])).map(x => x.id), ['c']);
  assert.deepEqual(pickRunnable(tasks, new Set(['a', 'c'])).map(x => x.id), []);
});

test('triggers: debounce and the hourly cap', () => {
  const lim = new TriggerLimiter();
  let now = 0;
  assert.ok(lim.allow('t', now));
  assert.ok(!lim.allow('t', now + 1000)); // debounced
  let fired = 1;
  for (let i = 1; i < 30; i++) { now += 6000; if (lim.allow('t', now)) fired++; }
  assert.equal(fired, core.TRIGGER_CAP_PER_HOUR);
  assert.ok(lim.allow('t', now + 3600000));
  const task = { project: 'p', trigger: { kind: 'save', match: 'src/**/*.ts' } };
  assert.ok(matchTrigger(task, { kind: 'save', project: 'p', path: 'src/a/b.ts' }, same));
  assert.ok(!matchTrigger(task, { kind: 'save', project: 'p', path: 'src/a/b.js' }, same));
  assert.ok(!matchTrigger(task, { kind: 'commit', project: 'p' }, same));
  assert.ok(matchTrigger({ project: 'p', trigger: { kind: 'prComment', match: 'deploy' } }, { kind: 'prComment', project: 'p', text: 'please DEPLOY' }, same));
});

test('a task plans, gets approved, runs each step and finishes', async () => {
  const w = world({ script: async (task, prompt, mode) => (mode === 'plan' ? { ok: true, text: PLAN, session: 's1' } : { ok: true, text: 'ok\nSTEP_DONE' }) });
  const c = new AgentCore(w.deps);
  const t = c.create({ goal: 'Add a button', project: 'p', agent: 'claude', control: 'plan' });
  await settle();
  assert.equal(t.status, 'done');
  assert.deepEqual(t.steps.map(s => s.status), ['done', 'done']);
  assert.equal(w.asks.length, 1);
  assert.equal(w.asks[0].kind, 'plan');
  assert.equal(t.session, 's1');
  assert.deepEqual(w.runs.map(r => r.mode), ['plan', 'build', 'build']);
});

test('Ask asks before every step; Full auto never asks', async () => {
  const script = async (task, prompt, mode) => (mode === 'plan' ? { ok: true, text: PLAN } : { ok: true, text: 'STEP_DONE' });
  const w1 = world({ script });
  const t1 = new AgentCore(w1.deps).create({ goal: 'g', project: 'p', agent: 'a', control: 'ask' });
  await settle();
  assert.equal(t1.status, 'done');
  assert.deepEqual(w1.asks.map(a => a.kind), ['plan', 'step', 'step']);
  const w2 = world({ script });
  const t2 = new AgentCore(w2.deps).create({ goal: 'g', project: 'p', agent: 'a', control: 'full' });
  await settle();
  assert.equal(t2.status, 'done');
  assert.equal(w2.asks.length, 0);
});

test('a failing step retries twice, then asks; skipping finishes with a failure', async () => {
  let builds = 0;
  const w = world({
    script: async (task, prompt, mode) => (mode === 'plan' ? { ok: true, text: '["only step"]' } : (builds++, { ok: true, text: 'STEP_FAILED: broken' })),
    answers: [{ approve: true }, { approve: false }],
  });
  const t = new AgentCore(w.deps).create({ goal: 'g', project: 'p', agent: 'a', control: 'plan' });
  await settle(60);
  assert.equal(builds, 1 + core.MAX_RETRIES);
  assert.equal(w.asks[1].kind, 'stuck');
  assert.equal(t.steps[0].status, 'skipped');
  assert.equal(t.status, 'done'); // skipped by the user, nothing left failed
});

test('turning a plan down with changes plans again', async () => {
  const w = world({
    script: async (task, prompt, mode) => (mode === 'plan' ? { ok: true, text: /changes/.test(prompt) ? '["better"]' : '["worse"]' } : { ok: true, text: 'STEP_DONE' }),
    answers: [{ approve: false, feedback: 'smaller' }, { approve: true }],
  });
  const t = new AgentCore(w.deps).create({ goal: 'g', project: 'p', agent: 'a', control: 'plan' });
  await settle(60);
  assert.equal(t.status, 'done');
  assert.deepEqual(t.steps.map(s => s.title), ['better']);
});

test('pause stops the run; a restart picks it up again', async () => {
  let release;
  const w = world({ script: (task, prompt, mode, n, signal) => mode === 'plan' ? Promise.resolve({ ok: true, text: PLAN })
    : new Promise(r => { release = () => r({ ok: true, text: 'STEP_DONE' }); signal.addEventListener('abort', () => r({ ok: false, text: '', stopped: true })); }) });
  const c = new AgentCore(w.deps);
  const t = c.create({ goal: 'g', project: 'p', agent: 'a', control: 'full' });
  await settle();
  assert.equal(t.status, 'running');
  c.pause(t.id);
  await settle();
  assert.equal(t.status, 'paused');
  assert.equal(t.steps[0].status, 'todo');
  // A crash mid-run: the saved copy says running; a new core queues it again.
  const crashed = JSON.parse(JSON.stringify(t));
  crashed.status = 'running'; crashed.steps[0].status = 'running';
  const w2 = world({ script: async (task, p, mode) => ({ ok: true, text: mode === 'plan' ? PLAN : 'STEP_DONE' }) });
  const c2 = new AgentCore(w2.deps, [crashed]);
  assert.equal(c2.get(t.id).status, 'queued');
  c2.pump();
  await settle();
  assert.equal(c2.get(t.id).status, 'done');
  assert.equal(w2.runs.filter(r => r.mode === 'plan').length, 0); // the plan was kept
  release?.();
});

test('the queue runs one task per project at a time', async () => {
  const pending = [];
  const w = world({ script: (task, prompt, mode) => mode === 'plan' ? Promise.resolve({ ok: true, text: '["x"]' }) : new Promise(r => pending.push(() => r({ ok: true, text: 'STEP_DONE' }))) });
  const c = new AgentCore(w.deps);
  const a = c.create({ goal: 'a', project: 'p1', agent: 'x', control: 'full' });
  const b = c.create({ goal: 'b', project: 'p1', agent: 'x', control: 'full' });
  const d = c.create({ goal: 'd', project: 'p2', agent: 'x', control: 'full' });
  const e = c.create({ goal: 'e', project: 'p3', agent: 'x', control: 'full' });
  await settle();
  assert.equal(a.status, 'running');
  assert.equal(b.status, 'queued');
  assert.equal(d.status, 'running');
  assert.equal(e.status, 'queued'); // two running already
  pending.shift()();
  await settle();
  assert.equal(a.status, 'done');
  assert.equal(b.status, 'running');
  for (const p of pending.splice(0)) p();
  await settle(); for (const p of pending.splice(0)) p(); await settle();
  assert.equal(e.status, 'done');
});

test('schedules fire when due, and missed slots fire once', async () => {
  const w = world({ script: async (task, prompt, mode) => ({ ok: true, text: mode === 'plan' ? '["x"]' : 'STEP_DONE' }) });
  const c = new AgentCore(w.deps);
  const t = c.create({ goal: 'report', project: 'p', agent: 'x', control: 'auto', schedule: { kind: 'every', hours: 1 } });
  assert.equal(t.status, 'waiting');
  c.tick();
  await settle();
  assert.equal(w.runs.length, 0);
  w.setNow(1_000_000 + 5 * 3600000); // five hours later: one run, not five
  c.tick();
  await settle();
  assert.equal(w.runs.filter(r => r.mode === 'plan').length, 1);
  assert.equal(t.status, 'waiting');
  assert.ok(t.nextRunAt > 1_000_000 + 5 * 3600000);
});

test('triggers start a waiting task, within the cap', async () => {
  const w = world({ script: async (task, prompt, mode) => ({ ok: true, text: mode === 'plan' ? '["x"]' : 'STEP_DONE' }) });
  const c = new AgentCore(w.deps);
  const t = c.create({ goal: 'lint', project: 'p', agent: 'x', control: 'auto', trigger: { kind: 'save', match: '*.ts' } });
  assert.deepEqual(c.trigger({ kind: 'save', project: 'p', path: 'a.js' }, same), []);
  assert.deepEqual(c.trigger({ kind: 'save', project: 'p', path: 'a.ts' }, same), [t.id]);
  await settle();
  assert.equal(t.status, 'waiting');
  assert.equal(t.unattended, false);
});

test('stopAll pauses everything running', async () => {
  const w = world({ script: (task, prompt, mode, n, signal) => mode === 'plan' ? Promise.resolve({ ok: true, text: '["x"]' }) : new Promise(r => signal.addEventListener('abort', () => r({ ok: false, text: '', stopped: true }))) });
  const c = new AgentCore(w.deps);
  const a = c.create({ goal: 'a', project: 'p1', agent: 'x', control: 'full' });
  const b = c.create({ goal: 'b', project: 'p2', agent: 'x', control: 'full' });
  await settle();
  assert.equal(c.stopAll(), 2);
  await settle();
  assert.equal(a.status, 'paused');
  assert.equal(b.status, 'paused');
  assert.equal(c.running().length, 0);
});

test('create checks its input', () => {
  const c = new AgentCore(world({ script: async () => ({ ok: true, text: '' }) }).deps);
  assert.throws(() => c.create({ goal: ' ', project: 'p', agent: 'a' }), /Say what/);
  assert.throws(() => c.create({ goal: 'g', project: '', agent: 'a' }), /project/);
  const t = c.create({ goal: 'g', project: 'p', agent: 'a', control: 'bogus', device: 'yes' });
  assert.equal(t.control, 'plan');
  assert.equal(t.device, false);
});
