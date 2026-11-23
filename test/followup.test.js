const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const ctx = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(fs.readFileSync(require.resolve('../src/renderer/breeze/followup.ts'), 'utf8')), ctx);
const findFollowUp = text => {
  const r = vm.runInContext('findFollowUp', ctx)(text);
  return r && JSON.parse(JSON.stringify(r));
};

test('a question followed by a list offers the list', () => {
  const text = 'Breeze\'s language support is mapped. Nothing has been changed.\n\nWhich language gap should I close first?\n\n- **Go debugging** — add a debug adapter\n- **JSX/TSX run fix**: make them runnable';
  assert.deepEqual(findFollowUp(text), { question: 'Which language gap should I close first?', options: ['Go debugging', 'JSX/TSX run fix'] });
});

test('a list right under the question, in the same block', () => {
  assert.deepEqual(findFollowUp('Done.\n\nWhat next?\n1. Write tests\n2. Ship it'), { question: 'What next?', options: ['Write tests', 'Ship it'] });
});

test('a list above a closing "which" question', () => {
  assert.deepEqual(findFollowUp('Two ways:\n\n- Cache it\n- Index it\n\nWhich one do you prefer?'), { question: 'Which one do you prefer?', options: ['Cache it', 'Index it'] });
});

test('"A, or B?" in the question itself', () => {
  assert.deepEqual(findFollowUp('Tests pass. Want me to fix the lint warnings, or ship it as is?').options, ['Fix the lint warnings', 'Ship it as is']);
});

test('a go-ahead question gets Yes and No', () => {
  assert.deepEqual(findFollowUp('Step 3 of 5 done. Run the backfill script?'), { question: 'Run the backfill script?', options: ['Yes', 'No'] });
  assert.equal(findFollowUp('Any preference on the name?'), null);
  assert.deepEqual(findFollowUp('Schema updated.\n\nWant me to run the backfill script?'), { question: 'Want me to run the backfill script?', options: ['Yes', 'No'] });
  assert.equal(findFollowUp('Done. Should I commit this?').question, 'Should I commit this?');
});

test('no card for an open question, a statement, or a question inside code', () => {
  assert.equal(findFollowUp('What should the new file be called?'), null);
  assert.equal(findFollowUp('All tests pass.'), null);
  assert.equal(findFollowUp('Here:\n\n```js\nconst ok = a ? b : c; // ok?\n```'), null);
  assert.equal(findFollowUp('Half a reply\n```js\nfoo?'), null);
  assert.equal(findFollowUp(''), null);
});

test('a list too long or with duplicate labels is not offered', () => {
  assert.equal(findFollowUp('Which first?\n\n- a\n- b\n- c\n- d\n- e'), null);
  assert.equal(findFollowUp('Which first?\n\n- Same\n- Same'), null);
});

test('long items are cut to a short label', () => {
  const r = findFollowUp('Which should I do?\n\n- Rewrite the whole parser so that it handles every single edge case we have ever seen in production\n- Leave it');
  assert.ok(r.options[0].length <= 61 && r.options[0].endsWith('…'));
});
