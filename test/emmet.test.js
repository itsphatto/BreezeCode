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
test('refuses a repeat count that would build a huge snippet', () => {
  const t = Date.now();
  assert.equal(expandAbbr('div*100000', 'html'), null);
  assert.ok(Date.now() - t < 200, `took ${Date.now() - t} ms`);
  assert.equal(expandAbbr('ul>li*1000>a*1000', 'html'), null);
  assert.equal(expandAbbr('p*1000000', 'html'), null);
  assert.match(expandAbbr('li*3', 'html'), /^(<li>\$\{\d\}<\/li>\n?){3}$/);
  // A zero count must not reset the product and let a huge one through after it.
  const t0 = Date.now();
  assert.equal(expandAbbr('p*0+div*100000', 'html'), null);
  assert.equal(expandAbbr('p*0>div*100000', 'html'), null);
  assert.equal(expandAbbr('lorem0+lorem9999999', 'html'), null);
  assert.ok(Date.now() - t0 < 200, `took ${Date.now() - t0} ms`);
  const t2 = Date.now();
  assert.equal(expandAbbr('lorem9999999', 'html'), null);
  assert.ok(Date.now() - t2 < 200, `took ${Date.now() - t2} ms`);
  assert.match(expandAbbr('lorem5', 'html'), /^\w+( \w+)*[.!?]$/);
});
