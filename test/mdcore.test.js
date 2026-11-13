const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const ctx = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(fs.readFileSync(require.resolve('../src/renderer/breeze/mdcore.ts'), 'utf8')), ctx);
const { splitFences, codeSpans } = vm.runInContext('({ splitFences, codeSpans })', ctx);
const plain = v => JSON.parse(JSON.stringify(v));

test('a fence at the start of a line is a code block', () => {
  assert.deepEqual(plain(splitFences('Here:\n```js\nlet x = 1;\n```\nDone.')), [
    { text: 'Here:\n' },
    { info: 'js', code: 'let x = 1;' },
    { text: '\nDone.' },
  ]);
});

test('triple backticks in the middle of a sentence stay text', () => {
  const s = 'It wraps the code in a ``` fence and adds ``` after it.';
  assert.deepEqual(plain(splitFences(s)), [{ text: s }]);
});

test('a fence named with a file, and one indented up to 3 spaces', () => {
  assert.deepEqual(plain(splitFences('```html index.html\n<p>\n```')), [{ info: 'html index.html', code: '<p>' }]);
  assert.deepEqual(plain(splitFences('  ```\na\n  ```')), [{ info: '', code: 'a' }]);
});

test('an unclosed fence (a reply cut off) still shows its code', () => {
  assert.deepEqual(plain(splitFences('See\n```py\nprint(1)\n')), [{ text: 'See\n' }, { info: 'py', code: 'print(1)' }]);
});

test('a line inside the code that mentions ``` mid-line does not close it', () => {
  assert.deepEqual(plain(splitFences('```ts\nconst f = "```";\n```')), [{ info: 'ts', code: 'const f = "```";' }]);
});

test('two blocks in a row, and empty text between them is left out', () => {
  assert.deepEqual(plain(splitFences('```\na\n```\n```\nb\n```')), [{ info: '', code: 'a' }, { text: '\n' }, { info: '', code: 'b' }]);
});

test('inline code: one backtick, or a run of them closed by the same run', () => {
  assert.equal(codeSpans('call `f()` now'), 'call <code>f()</code> now');
  assert.equal(codeSpans('a ``` fence ``` b'), 'a <code>fence</code> b');
  assert.equal(codeSpans('``a`b``'), '<code>a`b</code>');
  assert.equal(codeSpans('one ` alone'), 'one ` alone');
  assert.equal(codeSpans('no\n`split`'), 'no\n<code>split</code>');
});
