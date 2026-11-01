const test = require('node:test');
const assert = require('node:assert/strict');
const { expandAbbr } = require('../src/main/emmet');

test('expands markup', () => {
  assert.equal(expandAbbr('ul>li.item*2', 'html'), '<ul>\n\t<li class="item">${1}</li>\n\t<li class="item">${2}</li>\n</ul>');
  // emmet 2.4 emits the "http://" default as literal text before the first field, not as a placeholder.
  assert.match(expandAbbr('a:link', 'html'), /^<a href="http:\/\/\$\{1\}">\$\{2\}<\/a>$/);
});
test('returns null when emmet has nothing to expand', () => {
  assert.equal(expandAbbr('', 'html'), null);
  assert.equal(expandAbbr(42, 'html'), null);
});
test('emits placeholders as ${N:text}', () => {
  assert.equal(expandAbbr('c', 'css'), 'color: ${1:#000};');
  assert.match(expandAbbr('!', 'html'), /<title>\$\{5:Document\}<\/title>/);
});
test('expands stylesheet', () => {
  assert.equal(expandAbbr('m10', 'css'), 'margin: 10px;');
  assert.equal(expandAbbr('df', 'css'), 'display: flex;');
});
test('returns null on garbage', () => { assert.equal(expandAbbr('ul>>>', 'html'), null); });
