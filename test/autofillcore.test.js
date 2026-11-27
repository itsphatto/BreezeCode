const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const ctx = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(fs.readFileSync(require.resolve('../src/renderer/breeze/autofillcore.ts'), 'utf8')), ctx);
const { matchWord, rankWords, nearWords, textboxContext, oneEditApart } = vm.runInContext('({ matchWord, rankWords, nearWords, textboxContext, oneEditApart })', ctx);
const plain = v => JSON.parse(JSON.stringify(v)); // out of the vm's realm, so deepEqual compares values

test('a start of the word fits first, in its own case before another', () => {
  assert.deepEqual(plain(matchWord('ret', 'return')), { tier: 0, marks: [0, 1, 2] });
  assert.equal(matchWord('Ret', 'return').tier, 1);
});

test('the starts of a name\'s parts fit it', () => {
  assert.deepEqual(plain(matchWord('qsa', 'querySelectorAll')), { tier: 2, marks: [0, 5, 13] });
  assert.deepEqual(plain(matchWord('ael', 'addEventListener').marks), [0, 3, 8]);
  assert.equal(matchWord('gebi', 'getElementById').tier, 2);
  assert.equal(matchWord('gs', 'get_settings').tier, 2);
  assert.equal(matchWord('bc', 'border-color').tier, 2);
  assert.deepEqual(plain(matchWord('hel', 'HTMLElement').marks), [0, 4, 5]);
  assert.equal(matchWord('xhr', 'XMLHttpRequest').tier, 2);
});

test('a later part fits too, below the ones from the first letter', () => {
  assert.deepEqual(plain(matchWord('name', 'userName')), { tier: 3, marks: [4, 5, 6, 7] });
  assert.deepEqual(plain(matchWord('ById', 'getElementById').marks), [10, 11, 12, 13]);
});

test('letters from the middle of a part, out of order or missing do not fit', () => {
  assert.equal(matchWord('usrnm', 'userName'), null);
  assert.equal(matchWord('ab', 'cab'), null);
  assert.equal(matchWord('rn', 'return'), null);
  assert.equal(matchWord('qx', 'querySelector'), null);
});

test('ranked by tier, then weight; the typed word is left out and the last pick goes first', () => {
  const weights = new Map([['userName', 2], ['users', 5], ['useState', 9], ['us', 50], ['UserList', 1]]);
  assert.deepEqual(plain(rankWords('us', weights, 8).map(r => r.text)), ['useState', 'users', 'userName', 'UserList']);
  assert.deepEqual(plain(rankWords('us', weights, 8, 'userName').map(r => r.text)), ['userName', 'useState', 'users', 'UserList']);
  assert.deepEqual(plain(rankWords('un', weights, 8).map(r => r.text)), ['userName']);
});

test('nearer words weigh more', () => {
  const text = 'const farAway = 1;\n' + 'x'.repeat(200) + '\nconst closeBy = 2;\n';
  const near = nearWords(text, text.length, 300);
  assert.ok(near.get('closeBy') > near.get('farAway'));
  assert.equal(nearWords(text, text.length, 50).get('farAway'), undefined);
});

test('a textbox offers the word being typed, or the next one with the two words before it', () => {
  assert.deepEqual(plain(textboxContext('please fix the bu', '')), { prefix: 'bu', prev: 'the', prev2: 'fix' });
  assert.deepEqual(plain(textboxContext('can you ', '')), { prefix: '', prev: 'you', prev2: 'can' });
  assert.deepEqual(plain(textboxContext('the bu', '')), { prefix: 'bu', prev: 'the' });
  assert.deepEqual(plain(textboxContext("I don", '')), { prefix: 'don', prev: 'I' });
});

test('a textbox offers nothing mid-word, for one letter, in a mention or command, or with no word before', () => {
  assert.equal(textboxContext('fix the bu', 'g'), null);
  assert.equal(textboxContext('fix the b', ''), null);
  assert.equal(textboxContext('look at @sr', ''), null);
  assert.equal(textboxContext('/he', ''), null);
  assert.equal(textboxContext('', ''), null);
  assert.deepEqual(plain(textboxContext('@file the ', '')), { prefix: '', prev: 'the' });
});

test('one edit apart: an added, dropped, changed or swapped letter', () => {
  assert.ok(oneEditApart('teh', 'the'));
  assert.ok(oneEditApart('recieve', 'receive'));
  assert.ok(oneEditApart('helo', 'hello'));
  assert.ok(oneEditApart('helllo', 'hello'));
  assert.ok(oneEditApart('wprk', 'work'));
  assert.ok(!oneEditApart('work', 'work'));
  assert.ok(!oneEditApart('wrok', 'word'));
  assert.ok(!oneEditApart('react', 'reply'));
});
