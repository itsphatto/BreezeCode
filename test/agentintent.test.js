const test = require('node:test');
const assert = require('node:assert/strict');
const { detectIntent, readWhen } = require('../src/main/agentintent');

const agentic = t => detectIntent(t).agentic;

test('questions and small asks stay a chat', () => {
  for (const t of ['What does this function do?', 'why is the build slow', 'Explain the auth flow', 'how do I add a route?',
    'Fix the typo in the header', 'Rename this variable to count', 'hello', '']) {
    assert.equal(agentic(t), false, t);
  }
});

test('sequences, lists and several jobs become a task', () => {
  for (const t of ['Update the dependencies, run the tests and fix what breaks',
    'Add a dark mode toggle and then write tests for it',
    '1. Bump the version\n2. Update the changelog\n3. Tag the release',
    'Refactor the payment module to use the new API client',
    'Migrate the database layer from callbacks to async/await',
    'Check my emails and summarize the important ones',
    'Delete the spam messages in the #general Discord channel',
    'Build the landing page and the pricing page in parallel']) {
    assert.equal(agentic(t), true, t);
  }
});

test('/task and /chat override the rules', () => {
  const t = detectIntent('/task fix the typo');
  assert.equal(t.agentic, true);
  assert.equal(t.goal, 'fix the typo');
  const c = detectIntent('/chat update the deps, run tests and fix what breaks');
  assert.equal(c.agentic, false);
  assert.equal(c.goal, 'update the deps, run tests and fix what breaks');
});

test('schedules and triggers are read and make it a task', () => {
  assert.deepEqual(readWhen('Every morning summarize yesterday’s commits').schedule, { kind: 'daily', at: '09:00' });
  assert.deepEqual(readWhen('every day at 7:30pm send me a report').schedule, { kind: 'daily', at: '19:30' });
  assert.deepEqual(readWhen('daily at 6 check the inbox').schedule, { kind: 'daily', at: '06:00' });
  assert.deepEqual(readWhen('at 12am every day back up the db').schedule, { kind: 'daily', at: '00:00' });
  assert.deepEqual(readWhen('every 3 hours check for new issues').schedule, { kind: 'every', hours: 3 });
  assert.deepEqual(readWhen('hourly sync the docs').schedule, { kind: 'every', hours: 1 });
  assert.deepEqual(readWhen('nightly run the full test suite').schedule, { kind: 'daily', at: '21:00' });
  assert.deepEqual(readWhen('when tests fail, find the cause and fix it').trigger, { kind: 'testFail' });
  assert.deepEqual(readWhen('whenever I save, run the linter').trigger, { kind: 'save' });
  assert.deepEqual(readWhen('when *.ts files are saved run tsc').trigger, { kind: 'save', match: '*.ts' });
  assert.deepEqual(readWhen('fix the bug'), { schedule: null, trigger: null });
  const i = detectIntent('Every morning, summarize what changed in git');
  assert.equal(i.agentic, true);
  assert.deepEqual(i.schedule, { kind: 'daily', at: '09:00' });
  assert.equal(detectIntent('/chat every morning is hard').schedule, null);
});

test('a bad time is ignored, not guessed', () => {
  assert.deepEqual(readWhen('every day at 25:00 do it').schedule, { kind: 'daily', at: '09:00' });
  assert.equal(readWhen('every 500 hours do it').schedule, null);
});
