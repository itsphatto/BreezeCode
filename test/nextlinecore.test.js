const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const ctx = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(fs.readFileSync(require.resolve('../src/renderer/breeze/nextlinecore.ts'), 'utf8')), ctx);
const { nextLineGuess } = vm.runInContext('({ nextLineGuess })', ctx);

test('one markup line: the next one counts its number on', () => {
  assert.equal(nextLineGuess('<a class="example1">Some text here...</a>', null), '<a class="example2">Some text here...</a>');
});

test('one markup line: every copy of the last number counts on, other numbers stay', () => {
  assert.equal(nextLineGuess('<li data-i="1" style="width: 10px">Item 1</li>', null), '<li data-i="2" style="width: 10px">Item 2</li>');
});

test('heading tags, hex colours and decimals are not counted', () => {
  assert.equal(nextLineGuess('<h2 class="part3" style="color: #ff0033; opacity: 0.5">Part 3</h2>', null),
    '<h2 class="part4" style="color: #ff0033; opacity: 0.5">Part 4</h2>');
  assert.equal(nextLineGuess('<h1>Title</h1>', null), null);
});

test('the indentation of the line above is kept', () => {
  assert.equal(nextLineGuess('    <option value="7">7</option>', null), '    <option value="8">8</option>');
});

test('two lines in the same shape: each number goes on by its own step', () => {
  assert.equal(nextLineGuess('<a class="example3">x</a>', '<a class="example1">x</a>'), '<a class="example5">x</a>');
  assert.equal(nextLineGuess('const item2 = list[20];', 'const item1 = list[10];'), 'const item3 = list[30];');
  // A number that stayed the same stays the same.
  assert.equal(nextLineGuess('<h2 id="s2">Step 2</h2>', '<h2 id="s1">Step 1</h2>'), '<h2 id="s3">Step 3</h2>');
});

test('zero padding is kept', () => {
  assert.equal(nextLineGuess('<img src="frame09.png">', null), '<img src="frame10.png">');
  assert.equal(nextLineGuess('<img src="frame007.png">', null), '<img src="frame008.png">');
});

test('a single code line is not a pattern: two in the same shape are needed', () => {
  assert.equal(nextLineGuess('const a = 1;', null), null);
  assert.equal(nextLineGuess('for (let i = 0; i < 10; i++) {', null), null);
  assert.equal(nextLineGuess('const b = 7;', 'let total = 0;'), null); // different shapes
});

test('nothing for blank lines, lines with no numbers, identical lines or a count below zero', () => {
  assert.equal(nextLineGuess('   ', null), null);
  assert.equal(nextLineGuess('<p>Hello</p>', null), null);
  assert.equal(nextLineGuess('<a class="x1">x</a>', '<a class="x1">x</a>'), null);
  assert.equal(nextLineGuess('<a class="x0">x</a>', '<a class="x1">x</a>'), null);
});

test('very long lines get no guess', () => {
  assert.equal(nextLineGuess(`<a class="x1">${'y'.repeat(500)}</a>`, null), null);
});
