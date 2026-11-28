const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const ctx = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(fs.readFileSync(require.resolve('../src/renderer/breeze/mdcore.ts'), 'utf8')), ctx);
const { splitFences, codeSpans, emphasis } = vm.runInContext('({ splitFences, codeSpans, emphasis })', ctx);
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

/* ----- Edit Manually in a Markdown file's preview: the page's text change written into the Markdown ----- */
const { applyMdEdit, mdSourceLine } = vm.runInContext('({ applyMdEdit, mdSourceLine })', ctx);

test('a word changed in the preview is changed in the Markdown, formatting kept', () => {
  assert.equal(applyMdEdit('# Title\n\nHello **world** again.\n', [{ from: 'world', to: 'there', nth: 0 }]), '# Title\n\nHello **there** again.\n');
});

test('the nth time the text shows in the page picks which copy in the source', () => {
  const src = '- apple\n- apple\n- apple\n';
  assert.equal(applyMdEdit(src, [{ from: 'apple', to: 'pear', nth: 1 }]), '- apple\n- pear\n- apple\n');
});

test('several text nodes of one element change together', () => {
  assert.equal(applyMdEdit('Hello **big** world\n', [{ from: 'Hello ', to: 'Hi ', nth: 0 }, { from: ' world', to: ' moon', nth: 0 }]), 'Hi **big** moon\n');
});

test('new Markdown characters typed in the preview are escaped, old ones left as written', () => {
  assert.equal(applyMdEdit('use snake_case here\n', [{ from: 'use snake_case here', to: 'use snake_case *here*', nth: 0 }]), 'use snake_case \\*here\\*\n');
});

test('text the source holds escaped is still found', () => {
  assert.equal(applyMdEdit('2 \\* 3\n', [{ from: '2 * 3', to: '2 * 4', nth: 0 }]), '2 \\* 4\n');
});

test('text that is not in the source is refused', () => {
  assert.equal(applyMdEdit('Hello\n', [{ from: 'Bye', to: 'Ciao', nth: 0 }]), null);
});

test('a copy the source does not have that many of is refused unless there is only one', () => {
  assert.equal(applyMdEdit('one apple\n', [{ from: 'apple', to: 'pear', nth: 2 }]), 'one pear\n');
  assert.equal(applyMdEdit('apple apple\n', [{ from: 'apple', to: 'pear', nth: 5 }]), null);
});

test('Show in Source finds the line an element\'s text starts on', () => {
  assert.equal(mdSourceLine('# Title\n\nSome **bold** text here.\n', 'Some bold text here.'), 2);
  assert.equal(mdSourceLine('# Title\n', 'Nowhere'), null);
});

test('artifactKind: a whole page or an SVG shows live, a snippet stays code', () => {
  const { artifactKind } = vm.runInContext('({ artifactKind })', ctx);
  assert.equal(artifactKind('html', 'chart.html', '<!DOCTYPE html>\n<html><body>hi</body></html>'), 'html');
  assert.equal(artifactKind('', 'page.html', '<body><p>x</p></body>'), 'html');
  assert.equal(artifactKind('html', 'snippet.html', '<button class="x">Go</button>'), '');
  assert.equal(artifactKind('js', 'snippet.js', 'document.write("<html>")'), '');
  assert.equal(artifactKind('svg', 'logo.svg', '<svg viewBox="0 0 10 10"></svg>'), 'svg');
  assert.equal(artifactKind('xml', 'snippet.xml', '<?xml version="1.0"?>\n<!-- logo -->\n<svg></svg>'), 'svg');
  assert.equal(artifactKind('xml', 'snippet.xml', '<note></note>'), '');
  assert.equal(artifactKind('mermaid', 'snippet.mmd', 'flowchart TD\n  A --> B'), 'mermaid');
  assert.equal(artifactKind('mermaid', 'snippet.mmd', '  '), '');
});

test('emphasis: bold, italic and struck text', () => {
  assert.equal(emphasis('**a** __b__ *c* _d_ ~~e~~'), '<b>a</b> <b>b</b> <i>c</i> <i>d</i> <s>e</s>');
  assert.equal(emphasis('*a **b** c*'), '<i>a <b>b</b> c</i>');
});

test('emphasis leaves math, list bullets, snake_case and code alone', () => {
  for (const s of ['2 * 3 * 4', '* item', 'snake_case_name', '** not bold **', 'a*b']) assert.equal(emphasis(s), s);
  assert.equal(emphasis('<code>*x*</code> *y*'), '<code>*x*</code> <i>y</i>');
});

test('emphasis with keep holds every character (the prompt layer lines up with the textarea)', () => {
  const s = 'say **hi** to _you_ and ~~not~~ *me* <code>*k*</code>';
  const html = emphasis(s, true);
  assert.equal(html.replace(/<[^>]+>/g, ''), s.replace(/<[^>]+>/g, ''));
  assert.match(html, /<span class="md-b"><span class="md-mk">\*\*<\/span><span class="md-t">hi<\/span><span class="md-mk">\*\*<\/span><\/span>/);
});
