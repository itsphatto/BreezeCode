const test = require('node:test');
const assert = require('node:assert/strict');
const { markdownBody, markdownPage } = require('../src/main/markdown');

test('markdown renders the blocks a README uses', () => {
  const html = markdownBody([
    '# Title', '', 'Some **bold**, *em*, `a<b`, ~~old~~ and [a link](https://x.dev "t").', '',
    '- one', '- [x] done', '  - nested', '', '1. first', '2. second', '',
    '> quoted', '', '---', '',
    '| A | B |', '| :- | -: |', '| `x \\| y` | 2 |', '',
    '```js', 'const a = 1 < 2;', '```', '',
    '<div align="center">', '<img src="a.png">', '</div>',
  ].join('\n'));
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>, <em>em<\/em>, <code>a&lt;b<\/code>, <del>old<\/del>/);
  assert.match(html, /<a href="https:\/\/x\.dev" title="t">a link<\/a>/);
  assert.match(html, /<ul><li>one<\/li><li class="task"><input type="checkbox" disabled checked> done<ul><li>nested<\/li><\/ul><\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<th align="left">A<\/th><th align="right">B<\/th>/);
  assert.match(html, /<td align="left"><code>x \| y<\/code><\/td>/);
  assert.match(html, /<pre><code class="language-js">const a = 1 &lt; 2;<\/code><\/pre>/);
  assert.match(html, /<div align="center">\n<img src="a.png">\n<\/div>/);
  // Only starting with an inline tag: a paragraph, so its Markdown is read.
  assert.match(markdownBody('<sub>[Why](#why) · **b**</sub>'), /<p><sub><a href="#why">Why<\/a> · <strong>b<\/strong><\/sub><\/p>/);
});

test('markdown keeps scripts and script links out', () => {
  const page = markdownPage('<script>alert(1)</script>\n\n[x](javascript:alert(1)) ![i](data:image/png;base64,AA)');
  assert.doesNotMatch(page, /alert\(1\)<\/script>/); // the file's own script is dropped; the page's toggle script stays
  assert.match(page, /md-theme/);
  assert.match(page, /<a href="#">x<\/a>/);
  assert.match(page, /<img src="data:image\/png;base64,AA"/);
});
