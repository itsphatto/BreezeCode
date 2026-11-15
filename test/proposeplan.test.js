const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizePlan, replyText, QuestionDesk, NO_APPROVAL } = require('../src/main/askuser');
const { BREEZE_TOOLS } = require('../src/main/breezemcp');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('normalizePlan keeps the plan and tells the agent what to fix', () => {
  const q = normalizePlan({ plan: '  1. Add a footer\n2. Style it  ' });
  assert.equal(q.plan, '1. Add a footer\n2. Style it'); // line breaks stay: the card shows it as Markdown
  assert.deepEqual(q.options.map(o => o.label), ['Approve']);
  assert.throws(() => normalizePlan({}), /plan is empty/);
  assert.throws(() => normalizePlan(null), /plan is empty/);
  assert.throws(() => normalizePlan({ plan: 'x'.repeat(13000) }), /too long/);
});

test('the plan card\'s answer tells the agent whether to go ahead', () => {
  const q = normalizePlan({ plan: '1. Do it' });
  assert.match(replyText(q, { picked: ['Approve'], other: '' }), /approved the plan\. Make the changes now/);
  const edit = replyText(q, { picked: [], other: ' Skip step 2 ' });
  assert.match(edit, /wants changes to the plan: "Skip step 2"/);
  assert.match(edit, /call propose_plan again/);
  assert.equal(replyText(q, null), NO_APPROVAL);
  assert.equal(replyText(q, { picked: ['Something else'] }), NO_APPROVAL);
  assert.match(NO_APPROVAL, /Don't make the changes/);
});

test('a plan waits on the question desk, and stopping the run means not approved', async () => {
  const desk = new QuestionDesk(() => 'p1');
  const events = [];
  const ac = new AbortController();
  const waiting = desk.ask(7, normalizePlan({ plan: '1. Go' }), ev => events.push(ev), ac.signal);
  assert.equal(events[0].t, 'question');
  assert.equal(events[0].plan, '1. Go');
  ac.abort();
  assert.equal(await waiting, NO_APPROVAL);
  assert.deepEqual(events[1], { t: 'question-end', id: 'p1' });
});

test('propose_plan reaches every agent type that can take a tool, and shows in the chat', () => {
  assert.ok(BREEZE_TOOLS.some(t => t.name === 'propose_plan'), 'Claude Code and Codex, through Breeze\'s MCP server');
  const main = read('src/main/main.ts');
  assert.match(main, /name: 'propose_plan'/, 'local models');
  assert.match(main, /propose_plan: \(ctx, a\) => askUser\(ctx\.runId, a, ctx\.signal, true\)/);
  assert.match(main, /propose_plan: async \(runId, args, signal\) => \(\{ text: await askUser\(runId, args, signal, true\) \}\)/);
  const teams = read('src/renderer/breeze/teams.ts');
  assert.match(teams, /if \(ev\.plan\) \{ planApprovalCard\(r, id, ev\.plan, tab\); return; \}/);
  assert.match(teams, /data-plan-ok/);
});
