const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const ctx = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(fs.readFileSync(require.resolve('../src/renderer/editcore.ts'), 'utf8')), ctx);
const { lineStarts, colAtVisual, wordLeft, wordRight, wordAt, moveCaret, deleteSpan, openTagAt, fuzzyScore, emmetAbbrBefore, emmetInsert, EMMET_WORDS,
  normalizeSels, applyEdits, moveSels, nextOccurrence, allOccurrences, splitPaste, columnSels } =
  vm.runInContext('({ lineStarts, colAtVisual, wordLeft, wordRight, wordAt, moveCaret, deleteSpan, openTagAt, fuzzyScore, emmetAbbrBefore, emmetInsert, EMMET_WORDS, normalizeSels, applyEdits, moveSels, nextOccurrence, allOccurrences, splitPaste, columnSels })', ctx);

const T = 'ab cd\n  ef\n\nxyz';           // lines start at 0, 6, 11, 12; length 15
const S = lineStarts(T);
const mv = (off, key, o = {}) => moveCaret(T, S, o.sel ?? { anchor: off, head: off }, key,
  { shift: !!o.shift, ctrl: !!o.ctrl }, o.page ?? 10, o.goal ?? null);
const plain = (v) => JSON.parse(JSON.stringify(v));

test('lineStarts finds every line start', () => {
  assert.deepEqual(plain(lineStarts(T)), [0, 6, 11, 12]);
});

test('textEdit finds the one changed span, and applyEdit replays it', () => {
  const [textEdit, applyEdit] = vm.runInContext('[textEdit, applyEdit]', ctx);
  const big = 'x'.repeat(70000) + 'MID' + 'y'.repeat(70000);
  const pairs = [['', ''], ['', 'abc'], ['abc', ''], ['abc', 'abc'], ['abc', 'abXc'], ['aaaa', 'aaa'], ['hello world', 'hello brave world'],
    [big, big.replace('MID', 'M')], [big, big + '!'], ['!' + big, big]];
  for (const [a, b] of pairs) {
    const e = textEdit(a, b);
    assert.equal(applyEdit(a, e), b);
    assert.ok(e.text.length <= Math.max(0, b.length - Math.min(a.length, b.length)) + 3, `small edit for ${a.length}→${b.length}`);
  }
  assert.deepEqual(plain(textEdit('hello world', 'hello brave world')), { start: 6, end: 6, text: 'brave ' });
});

test('shiftLineStarts matches a full rescan after any edit', () => {
  const shift = vm.runInContext('shiftLineStarts', ctx);
  const texts = ['', '\n', 'a\nb', T, '\n\nx\n', 'abc\n\ndef\nghi\n'];
  const inserts = ['', 'q', '\n', 'x\ny', '\n\n', 'end\n'];
  for (const t of texts) for (const ins of inserts) for (let s = 0; s <= t.length; s++) for (let e = s; e <= t.length; e++) {
    const after = t.slice(0, s) + ins + t.slice(e);
    assert.deepEqual(plain(shift(lineStarts(t), s, e, ins)), plain(lineStarts(after)), JSON.stringify({ t, s, e, ins }));
  }
});

test('arrow keys move, extend and collapse selections', () => {
  assert.deepEqual(plain(mv(0, 'ArrowRight').sel), { anchor: 1, head: 1 });
  assert.deepEqual(plain(mv(0, 'ArrowRight', { shift: true }).sel), { anchor: 0, head: 1 });
  assert.deepEqual(plain(mv(0, 'ArrowLeft', { sel: { anchor: 1, head: 4 } }).sel), { anchor: 1, head: 1 });
  assert.deepEqual(plain(mv(0, 'ArrowRight', { sel: { anchor: 4, head: 1 } }).sel), { anchor: 4, head: 4 });
});

test('vertical moves keep a goal column', () => {
  const a = mv(4, 'ArrowDown');
  assert.equal(a.sel.head, 10);
  assert.equal(a.goal, 4);
  const b = mv(10, 'ArrowDown', { goal: 4 });
  assert.equal(b.sel.head, 11);
  assert.equal(b.goal, 4);
  assert.equal(mv(11, 'ArrowDown', { goal: 4 }).sel.head, 15);
});

test('vertical moves clamp at the document edges', () => {
  assert.equal(mv(3, 'ArrowUp').sel.head, 0);
  assert.equal(mv(13, 'ArrowDown').sel.head, 15);
});

test('Home is smart and End/ctrl variants work', () => {
  assert.equal(mv(10, 'Home').sel.head, 8);
  assert.equal(mv(8, 'Home').sel.head, 6);
  assert.equal(mv(7, 'End').sel.head, 10);
  assert.equal(mv(7, 'Home', { ctrl: true }).sel.head, 0);
  assert.equal(mv(7, 'End', { ctrl: true }).sel.head, 15);
});

test('ctrl+arrows move by word', () => {
  assert.equal(mv(0, 'ArrowRight', { ctrl: true }).sel.head, 2);
  assert.equal(mv(2, 'ArrowRight', { ctrl: true }).sel.head, 5);
  assert.equal(mv(5, 'ArrowRight', { ctrl: true }).sel.head, 6);
  assert.equal(mv(5, 'ArrowLeft', { ctrl: true }).sel.head, 3);
  assert.equal(mv(3, 'ArrowLeft', { ctrl: true }).sel.head, 0);
});

test('PageDown moves by page lines', () => {
  assert.equal(mv(0, 'PageDown', { page: 2 }).sel.head, 11);
});

test('horizontal moves reset the goal column', () => {
  assert.equal(mv(10, 'ArrowLeft', { goal: 4 }).goal, null);
});

test('surrogate pairs are never split', () => {
  const E = 'a😀b';
  assert.equal(moveCaret(E, lineStarts(E), { anchor: 1, head: 1 }, 'ArrowRight', { shift: false, ctrl: false }, 10, null).sel.head, 3);
  assert.deepEqual(plain(deleteSpan(E, { anchor: 3, head: 3 }, 'Backspace', false)), [1, 3]);
});

test('deleteSpan covers selections, chars and words', () => {
  assert.deepEqual(plain(deleteSpan(T, { anchor: 4, head: 4 }, 'Backspace', false)), [3, 4]);
  assert.deepEqual(plain(deleteSpan(T, { anchor: 1, head: 4 }, 'Backspace', false)), [1, 4]);
  assert.deepEqual(plain(deleteSpan(T, { anchor: 5, head: 5 }, 'Backspace', true)), [3, 5]);
  assert.deepEqual(plain(deleteSpan(T, { anchor: 15, head: 15 }, 'Delete', false)), [15, 15]);
  assert.deepEqual(plain(deleteSpan(T, { anchor: 0, head: 0 }, 'Backspace', false)), [0, 0]);
  assert.deepEqual(plain(deleteSpan(T, { anchor: 0, head: 0 }, 'Delete', true)), [0, 2]);
});

test('colAtVisual maps visual columns to indices', () => {
  assert.equal(colAtVisual('\tab', 5), 2);
  assert.equal(colAtVisual('\tab', 1), 0);
  assert.equal(colAtVisual('abc', 99), 3);
});

test('wordAt returns the run around an offset', () => {
  assert.deepEqual(plain(wordAt('foo.bar baz', 5)), [4, 7]);
  assert.deepEqual(plain(wordAt('foo.bar baz', 3)), [3, 4]);
  assert.deepEqual(plain(wordAt('foo.bar baz', 7)), [4, 7]);
});

test('word jumps skip whitespace', () => {
  assert.equal(wordRight('a  b', 1), 4);
  assert.equal(wordLeft('a  b', 3), 0);
});

test('openTagAt finds the element a closing tag should close', () => {
  // `at` is where the '<' of the new closing tag sits: the end of each sample.
  const open = (t, xml = false) => openTagAt(t, t.length, xml);
  assert.equal(open('<test>hello '), 'test');
  assert.equal(open('<div class="a>b"><span>x</span>'), 'div');
  assert.equal(open('<ul>\n  <li>a</li>\n  <li>b'), 'li');
  assert.equal(open('<p>a<br><img src=x><input/>'), 'p');
  assert.equal(open('<Div>x', false), 'Div');
  assert.equal(open('<a><b>x</a>'), null);
  assert.equal(open('<a></a>'), null);
  assert.equal(open('<x><!-- <y> --> '), 'x');
  assert.equal(open('<x><!-- note '), null);
  assert.equal(open('<script>if (a < b) { s = "<div>" } '), 'script');
  assert.equal(open('<body><script>"<i>"</script> '), 'body');
  assert.equal(open('<Foo.Bar><Baz/>', true), 'Foo.Bar');
  assert.equal(open('<g><circle r="1"/><rect></rect>', true), 'g');
  assert.equal(open('plain text'), null);
});

test('fuzzyScore matches subsequences and prefers word starts and runs', () => {
  assert.equal(fuzzyScore('Edit: Find in Files', 'xyz'), null);
  assert.deepEqual(plain(fuzzyScore('Edit: Find', '')), { score: 0, hits: [] });
  assert.deepEqual(plain(fuzzyScore('Edit: Find in Files', 'fif')).hits, [6, 11, 14]);
  assert.ok(fuzzyScore('View: Terminal', 'term').score > fuzzyScore('Edit: Toggle Breakpoint Menu', 'term').score);
  assert.ok(fuzzyScore('Go to File', 'GTF').score > 0); // case-insensitive
  assert.deepEqual(plain(fuzzyScore('xab Ac', 'ab')).hits, [1, 2]); // a word start with no room left for the rest is skipped
});

test('emmetAbbrBefore markup', () => {
  assert.deepEqual(plain(emmetAbbrBefore('  ul>li.item*3', 14, 'markup')), { abbr: 'ul>li.item*3', start: 2 });
  assert.deepEqual(plain(emmetAbbrBefore('div[title="a b"]', 16, 'markup')), { abbr: 'div[title="a b"]', start: 0 });
  assert.equal(emmetAbbrBefore('hello', 5, 'markup'), null);              // bare non-tag word
  assert.equal(emmetAbbrBefore('<div class', 10, 'markup'), null);        // inside a tag
  assert.deepEqual(plain(emmetAbbrBefore('text section', 12, 'markup')), { abbr: 'section', start: 5 });
  assert.deepEqual(plain(emmetAbbrBefore('<p>ul>li', 8, 'markup')), { abbr: 'ul>li', start: 3 }); // a finished tag is not part of it
  assert.deepEqual(plain(emmetAbbrBefore('<img src=x>p', 12, 'markup')), { abbr: 'p', start: 11 });
  assert.deepEqual(plain(emmetAbbrBefore('a{x > y}', 8, 'markup')), { abbr: 'a{x > y}', start: 0 });
  assert.equal(emmetAbbrBefore('  ', 2, 'markup'), null);
  assert.equal(emmetAbbrBefore('x)', 2, 'markup'), null);                 // unbalanced
  assert.ok(EMMET_WORDS.has('div') && EMMET_WORDS.has('!') && !EMMET_WORDS.has('hello'));
});
test('emmetAbbrBefore stylesheet', () => {
  assert.deepEqual(plain(emmetAbbrBefore('  m10', 5, 'stylesheet')), { abbr: 'm10', start: 2 });
  assert.deepEqual(plain(emmetAbbrBefore('a { df', 6, 'stylesheet')), { abbr: 'df', start: 4 });
  assert.deepEqual(plain(emmetAbbrBefore('a { color: red; m0', 18, 'stylesheet')), { abbr: 'm0', start: 16 });
  assert.equal(emmetAbbrBefore('  color: red', 12, 'stylesheet'), null);  // Review Focus 5
  assert.equal(emmetAbbrBefore('  margin: 0 auto', 16, 'stylesheet'), null);
  assert.equal(emmetAbbrBefore('  ', 2, 'stylesheet'), null);
});
test('emmetInsert indents and places the caret on the first field', () => {
  assert.deepEqual(plain(emmetInsert('<ul>\n\t<li>${1}</li>\n</ul>', '  ')), { text: '<ul>\n  \t<li></li>\n  </ul>', caret: 12 });
  assert.deepEqual(plain(emmetInsert('<a href="${1:http://}">${2}</a>', '')), { text: '<a href="http://"></a>', caret: 9 });
  assert.deepEqual(plain(emmetInsert('margin: 10px;', '')), { text: 'margin: 10px;', caret: 13 });
  assert.deepEqual(plain(emmetInsert('<i>${2}</i><b>${1}</b>${0}', '')), { text: '<i></i><b></b>', caret: 14 }); // ${0} is the lowest number
  assert.deepEqual(plain(emmetInsert('<p>${0}</p>', '')), { text: '<p></p>', caret: 3 });
  assert.deepEqual(plain(emmetInsert('@media ${1:screen} {\n\t${0}\n}', '')), { text: '@media screen {\n\t\n}', caret: 17 }); // the body, not the query
});

/* ----- Multiple selections ----- */
test('normalizeSels merges overlaps and duplicate carets', () => {
  assert.deepEqual(plain(normalizeSels([{ anchor: 5, head: 5 }, { anchor: 1, head: 3 }, { anchor: 2, head: 4 }, { anchor: 5, head: 5 }], 10)),
    [{ anchor: 1, head: 4 }, { anchor: 5, head: 5 }]);
});
test('normalizeSels clamps, keeps touching ranges apart, and keeps the later direction', () => {
  assert.deepEqual(plain(normalizeSels([{ anchor: -3, head: 2 }, { anchor: 20, head: 8 }], 10)), [{ anchor: 0, head: 2 }, { anchor: 10, head: 8 }]);
  assert.deepEqual(plain(normalizeSels([{ anchor: 0, head: 2 }, { anchor: 2, head: 4 }, { anchor: 4, head: 4 }], 10)),
    [{ anchor: 0, head: 2 }, { anchor: 2, head: 4 }, { anchor: 4, head: 4 }]);
  assert.deepEqual(plain(normalizeSels([{ anchor: 1, head: 4 }, { anchor: 6, head: 3 }], 10)), [{ anchor: 6, head: 1 }]);
  assert.deepEqual(plain(normalizeSels([{ anchor: 3, head: 1 }, { anchor: 2, head: 6 }], 10)), [{ anchor: 1, head: 6 }]);
  assert.deepEqual(plain(normalizeSels([], 10)), []);
});
test('applyEdits maps carets through edits of different lengths on one line', () => {
  assert.deepEqual(plain(applyEdits('a b c', [{ start: 1, end: 1, text: 'XX' }, { start: 3, end: 3, text: 'Y' }, { start: 5, end: 5, text: '' }])),
    { text: 'aXX bY c', carets: [3, 6, 8] });
});
test('applyEdits replaces ranges and handles shrinking edits', () => {
  assert.deepEqual(plain(applyEdits('foo bar foo', [{ start: 0, end: 3, text: 'x' }, { start: 8, end: 11, text: 'yy' }])), { text: 'x bar yy', carets: [1, 8] });
  assert.deepEqual(plain(applyEdits('', [])), { text: '', carets: [] });
});
test('Backspace at colliding carets merges them', () => {
  // 'abc' with carets after a and after b: one Backspace deletes both and leaves one caret at 0.
  // (A cursor whose Backspace deletes nothing still keeps its caret: callers pass a zero-length edit, not none.)
  const t = 'abc', sels = [{ anchor: 1, head: 1 }, { anchor: 2, head: 2 }];
  const edits = sels.map(s => { const [a, b] = deleteSpan(t, s, 'Backspace', false); return { start: a, end: b, text: '' }; });
  const r = applyEdits(t, edits);
  assert.equal(r.text, 'c');
  assert.deepEqual(plain(normalizeSels(r.carets.map(c => ({ anchor: c, head: c })), r.text.length)), [{ anchor: 0, head: 0 }]);
  assert.deepEqual(plain(applyEdits('c', [{ start: 0, end: 0, text: '' }])), { text: 'c', carets: [0] });
});
test('moveSels moves every cursor and merges the ones that meet', () => {
  const p = (sels, key, shift = false) => plain(moveSels(T, S, sels, key, { shift, ctrl: false }, 10));
  assert.deepEqual(p([{ anchor: 0, head: 0 }, { anchor: 6, head: 6 }], 'ArrowRight'), [{ anchor: 1, head: 1 }, { anchor: 7, head: 7 }]);
  assert.deepEqual(p([{ anchor: 0, head: 0 }, { anchor: 3, head: 3 }], 'Home'), [{ anchor: 0, head: 0 }]);
  assert.deepEqual(p([{ anchor: 0, head: 0 }, { anchor: 1, head: 1 }], 'ArrowLeft'), [{ anchor: 0, head: 0 }]);
  assert.deepEqual(p([{ anchor: 0, head: 0 }, { anchor: 6, head: 6 }], 'ArrowRight', true), [{ anchor: 0, head: 1 }, { anchor: 6, head: 7 }]);
  assert.deepEqual(p([{ anchor: 0, head: 2 }, { anchor: 1, head: 3 }], 'ArrowRight', true), [{ anchor: 0, head: 4 }]);
});
test('nextOccurrence selects the word first, then wraps and skips selected', () => {
  const T = 'foo bar foo baz foo';
  assert.deepEqual(plain(nextOccurrence(T, [{ anchor: 1, head: 1 }])), { anchor: 0, head: 3 });
  assert.deepEqual(plain(nextOccurrence(T, [{ anchor: 0, head: 3 }])), { anchor: 8, head: 11 });
  assert.deepEqual(plain(nextOccurrence(T, [{ anchor: 8, head: 11 }, { anchor: 16, head: 19 }])), { anchor: 0, head: 3 });
  assert.equal(nextOccurrence(T, [{ anchor: 0, head: 3 }, { anchor: 8, head: 11 }, { anchor: 16, head: 19 }]), null);
});
test('nextOccurrence follows the last selection, a backward one included', () => {
  const T = 'foo bar foo baz foo';
  assert.deepEqual(plain(nextOccurrence(T, [{ anchor: 11, head: 8 }])), { anchor: 16, head: 19 });
  // the last in order given, not the rightmost
  assert.deepEqual(plain(nextOccurrence(T, [{ anchor: 8, head: 11 }, { anchor: 0, head: 3 }])), { anchor: 16, head: 19 });
  assert.equal(nextOccurrence(T, [{ anchor: 0, head: 3 }, { anchor: 8, head: 11 }, { anchor: 16, head: 19 }]), null);
  assert.equal(nextOccurrence('a   b', [{ anchor: 2, head: 2 }]), null); // between blanks there is no word
  assert.deepEqual(plain(nextOccurrence('foo\nbar', [{ anchor: 3, head: 3 }])), { anchor: 0, head: 3 }); // end of line: the word before, not the newline
  assert.equal(nextOccurrence('a\n\nb', [{ anchor: 2, head: 2 }]), null); // blank line
  assert.deepEqual(plain(nextOccurrence('foo', [{ anchor: 3, head: 3 }])), { anchor: 0, head: 3 });
  assert.deepEqual(plain(nextOccurrence('foo(x)', [{ anchor: 3, head: 3 }])), { anchor: 0, head: 3 });
  assert.equal(nextOccurrence('', [{ anchor: 0, head: 0 }]), null);
  assert.equal(nextOccurrence('foo', []), null);
});
test('allOccurrences is non-overlapping and case-sensitive', () => {
  assert.deepEqual(plain(allOccurrences('aaaa', 'aa')), [{ anchor: 0, head: 2 }, { anchor: 2, head: 4 }]);
  assert.deepEqual(plain(allOccurrences('Foo foo FOO', 'foo')), [{ anchor: 4, head: 7 }]);
  assert.deepEqual(plain(allOccurrences('abc', '')), []);
  assert.deepEqual(plain(allOccurrences('abc', 'x')), []);
});
test('allOccurrences with wholeWord skips copies inside longer words', () => {
  assert.deepEqual(plain(allOccurrences('e = de + e', 'e', true)), [{ anchor: 0, head: 1 }, { anchor: 9, head: 10 }]);
  assert.deepEqual(plain(allOccurrences('e = de + e', 'e')).length, 3);
  assert.deepEqual(plain(allOccurrences('foo(foo_1, $foo, foo)', 'foo', true)), [{ anchor: 0, head: 3 }, { anchor: 17, head: 20 }]);
  assert.deepEqual(plain(allOccurrences('aaa a', 'a', true)), [{ anchor: 4, head: 5 }]);
});
test('nextOccurrence with wholeWord skips copies inside longer words', () => {
  const T = 'e = de + e';
  assert.deepEqual(plain(nextOccurrence(T, [{ anchor: 0, head: 1 }], true)), { anchor: 9, head: 10 });
  assert.deepEqual(plain(nextOccurrence(T, [{ anchor: 0, head: 1 }])), { anchor: 5, head: 6 });
  assert.equal(nextOccurrence(T, [{ anchor: 0, head: 1 }, { anchor: 9, head: 10 }], true), null);
  assert.equal(nextOccurrence('fooBar foo', [{ anchor: 7, head: 10 }], true), null); // wrapping finds only `foo` in fooBar
  // a rejected copy doesn't hide one that overlaps it: 'aa' inside 'aaa' is no word, the next 'aa' is
  assert.deepEqual(plain(nextOccurrence('aa aaa aa', [{ anchor: 0, head: 2 }], true)), { anchor: 7, head: 9 });
});
test('splitPaste distributes one line per cursor only on an exact match', () => {
  assert.deepEqual(plain(splitPaste('a\nb\n', 2)), ['a', 'b']);
  assert.deepEqual(plain(splitPaste('a\nb', 3)), ['a\nb', 'a\nb', 'a\nb']);
  assert.deepEqual(plain(splitPaste('a\r\nb', 2)), ['a', 'b']);
  assert.deepEqual(plain(splitPaste('x', 3)), ['x', 'x', 'x']);
  assert.deepEqual(plain(splitPaste('a\n', 1)), ['a\n']); // a lone cursor pastes the clipboard whole
  assert.deepEqual(plain(splitPaste('a\n\n', 2)), ['a', '']);
});
test('columnSels clamps short lines', () => {
  const T = 'abcdef\nab\nabcdef', S = lineStarts(T);
  assert.deepEqual(plain(columnSels(T, S, 0, 1, 2, 4)), [{ anchor: 1, head: 4 }, { anchor: 8, head: 9 }, { anchor: 11, head: 14 }]);
});
test('columnSels handles upward and backward drags, and tabs by visual column', () => {
  const T = 'abcdef\nab\nabcdef', S = lineStarts(T);
  // dragging up keeps lines in document order
  assert.deepEqual(plain(columnSels(T, S, 2, 1, 0, 4)), [{ anchor: 1, head: 4 }, { anchor: 8, head: 9 }, { anchor: 11, head: 14 }]);
  // dragging left puts the anchor on the from side
  assert.deepEqual(plain(columnSels(T, S, 0, 4, 2, 1)), [{ anchor: 4, head: 1 }, { anchor: 9, head: 8 }, { anchor: 14, head: 11 }]);
  // one line, zero width: a caret
  assert.deepEqual(plain(columnSels(T, S, 2, 3, 2, 3)), [{ anchor: 13, head: 13 }]);
  const U = '\tab\nabcdefgh', V = lineStarts(U);
  assert.deepEqual(plain(columnSels(U, V, 0, 4, 1, 4)), [{ anchor: 1, head: 1 }, { anchor: 8, head: 8 }]);
});
test('mergeEdits joins overlapping and touching deletes so applyEdits can take them', () => {
  const mergeEdits = vm.runInContext('mergeEdits', ctx);
  // Ctrl+Backspace at carets 3 and 6 in one word: both reach back to 0
  const t = 'abcdefg', spans = [deleteSpan(t, { anchor: 3, head: 3 }, 'Backspace', true), deleteSpan(t, { anchor: 6, head: 6 }, 'Backspace', true)];
  const m = mergeEdits(spans.map(([start, end]) => ({ start, end, text: '' })));
  assert.deepEqual(plain(m), [{ start: 0, end: 6, text: '' }]);
  assert.deepEqual(plain(applyEdits(t, m)), { text: 'g', carets: [0] });
  // out of order, with a caret's no-op inside a range; touching deletes
  assert.deepEqual(plain(mergeEdits([{ start: 4, end: 7, text: '' }, { start: 2, end: 5, text: '' }, { start: 5, end: 5, text: '' }])), [{ start: 2, end: 7, text: '' }]);
  assert.deepEqual(plain(mergeEdits([{ start: 0, end: 3, text: '' }, { start: 3, end: 5, text: '' }])), [{ start: 0, end: 5, text: '' }]);
  // touching edits that insert stay apart: each cursor keeps its own text
  const ins = [{ start: 3, end: 3, text: 'x' }, { start: 3, end: 5, text: 'x' }, { start: 5, end: 7, text: 'y' }];
  assert.deepEqual(plain(mergeEdits(ins)), ins);
  // the input is left alone
  const orig = [{ start: 2, end: 5, text: '' }, { start: 0, end: 3, text: '' }];
  mergeEdits(orig);
  assert.deepEqual(plain(orig), [{ start: 2, end: 5, text: '' }, { start: 0, end: 3, text: '' }]);
});
test('shiftLinesByEdits moves lines by each edit on its own', () => {
  const shiftLinesByEdits = vm.runInContext('shiftLinesByEdits', ctx);
  const t = 'l0\nl1\nl2\nl3\nl4\nl5\nl6'; // lines start at 0, 3, 6, 9, 12, 15, 18
  // Backspace at the starts of lines 2 and 5: lines 3 and 4 move up one, not two, and are kept
  const joins = [{ start: 5, end: 6, text: '' }, { start: 14, end: 15, text: '' }];
  assert.deepEqual(plain(shiftLinesByEdits([3, 4], t, joins)), [2, 3]);
  assert.deepEqual(plain(shiftLinesByEdits([0, 1, 2, 3, 4, 5, 6], t, joins)), [0, 1, 2, 3, 4]); // joined lines fall onto the one above
  assert.deepEqual(plain(shiftLinesByEdits([3, 4], t, joins.slice().reverse())), [2, 3]); // order of the edits does not matter
  // lines inserted at a line's start push it down; inserted mid-line, the line stays
  assert.deepEqual(plain(shiftLinesByEdits([1, 2, 3], t, [{ start: 6, end: 6, text: 'a\nb\n' }])), [1, 4, 5]);
  assert.deepEqual(plain(shiftLinesByEdits([2, 3], t, [{ start: 7, end: 7, text: 'X\n' }])), [2, 4]);
  // a delete from mid line 2 to mid line 4: lines 3 and 4 collapse onto 2, line 5 moves up two
  assert.deepEqual(plain(shiftLinesByEdits([2, 3, 4, 5], t, [{ start: 7, end: 13, text: '' }])), [2, 3]);
  // the same span replaced with as many lines: nothing moves
  assert.deepEqual(plain(shiftLinesByEdits([3, 4, 5], t, [{ start: 7, end: 13, text: 'A\nB\nC' }])), [3, 4, 5]);
  // a two-line paste at two carets: each caret's newline counts once for the lines below it
  const paste = [{ start: 4, end: 4, text: 'p\nq' }, { start: 10, end: 10, text: 'p\nq' }];
  assert.deepEqual(plain(shiftLinesByEdits([1, 2, 3, 4], t, paste)), [1, 3, 4, 6]);
  assert.deepEqual(plain(shiftLinesByEdits([2, 9], t, [])), [2, 9]);
});
test('selIndexOf finds where a selection went after normalizing', () => {
  const selIndexOf = vm.runInContext('selIndexOf', ctx);
  const sels = normalizeSels([{ anchor: 9, head: 9 }, { anchor: 0, head: 4 }, { anchor: 2, head: 6 }, { anchor: 6, head: 6 }], 20);
  assert.deepEqual(plain(sels), [{ anchor: 0, head: 6 }, { anchor: 6, head: 6 }, { anchor: 9, head: 9 }]);
  assert.equal(selIndexOf(sels, { anchor: 9, head: 9 }), 2);
  assert.equal(selIndexOf(sels, { anchor: 4, head: 2 }), 0); // swallowed by the merged range
  assert.equal(selIndexOf(sels, { anchor: 6, head: 6 }), 1); // a caret touching a range's end is its own
  assert.equal(selIndexOf(sels, { anchor: 30, head: 30 }), 0); // nowhere: the first
});

test('dragScrollX scrolls only near or past the sides, faster further out', () => {
  const dragScrollX = vm.runInContext('dragScrollX', ctx);
  assert.equal(dragScrollX(500, 100, 900), 0);
  assert.equal(dragScrollX(100, 100, 900), 0);
  assert.equal(dragScrollX(888, 100, 900), 0);
  assert.equal(dragScrollX(889, 100, 900), 1); // the screen's edge can stop the pointer before the viewport's
  assert.equal(dragScrollX(988, 100, 900), 50);
  assert.equal(dragScrollX(99, 100, 900), -1);
  assert.equal(dragScrollX(0, 100, 900), -50);
});

test('mapAxis keeps the box inside the map and pans content wider than it', () => {
  const mapAxis = vm.runInContext('mapAxis', ctx);
  // 1000 map px of content on a 100 px map, 0.5 map px per editor px, a 100 px viewport.
  const at = pos => mapAxis(pos, 100, 2000, 4, .5, 1000, 100);
  assert.equal(at(0).offset, 0);
  assert.equal(at(0).start, 0);
  assert.equal(at(0).size, 50);
  assert.equal(at(2000).offset, 900);
  assert.equal(at(2000).start, 50); // clamped to the map's end
  assert.equal(at(1000).offset, 450);
  assert.equal(at(1000).start, 48); // (1000 - 4) * .5 - 450
  assert.equal(at(1000).perPx, 40); // 2000 scroll px over the 50 px the box can travel
  assert.equal(at(1000).centreOn(50), 954); // map px 50 is editor px 1000, plus the pad, less half a view
  // Content that fits the map doesn't pan.
  const small = mapAxis(50, 100, 100, 0, .5, 70, 100);
  assert.equal(small.offset, 0);
  assert.equal(small.start, 25);
  assert.equal(small.perPx, 5); // 100 scroll px over 70 - 50 of travel
  // A viewport wider than the map: capped, and a drag still scrolls.
  const wide = mapAxis(0, 1000, 500, 0, .5, 1000, 100);
  assert.equal(wide.size, 100);
  assert.equal(wide.perPx, 2);
  // Almost the map's width: a pixel of drag must not throw the view across the whole overflow.
  assert.equal(mapAxis(0, 990, 2000, 0, .04, 200, 40).perPx, 25);
  // No overflow: the box fills the axis and nothing moves.
  const none = mapAxis(0, 100, 0, 4, .5, 30, 100);
  assert.deepEqual([none.offset, none.start, none.size, none.perPx, none.centreOn(70)], [0, 0, 100, 0, 0]);
});

test('walkToCol keeps tab stops, stops at the line end, and bounds huge lines', () => {
  const walkToCol = vm.runInContext('walkToCol', ctx);
  assert.deepEqual(plain(walkToCol('abcdef', 0, 6, 0)), { at: 0, col: 0 });
  assert.deepEqual(plain(walkToCol('abcdef', 0, 6, 3)), { at: 3, col: 3 });
  assert.deepEqual(plain(walkToCol('a\tbc', 0, 4, 4)), { at: 2, col: 4 }); // the tab ends on the stop
  assert.deepEqual(plain(walkToCol('a\tbc', 0, 4, 2)), { at: 2, col: 4 }); // a window starting inside a tab: b still draws at 4
  assert.deepEqual(plain(walkToCol('xa\tb', 1, 4, 4)), { at: 3, col: 4 }); // columns count from `at`, the line's start
  assert.ok(walkToCol('ab', 0, 2, 50).at >= 2); // short line: past its end, nothing to draw
  assert.deepEqual(plain(walkToCol('x'.repeat(1e6), 0, 1e6, 500000)), { at: 500000, col: 500000 });
  assert.deepEqual(plain(walkToCol('\t'.repeat(5000), 0, 5000, 30000)), { at: 4096 + 30000 - 4096 * 4, col: 30000 }); // only 4096 chars walked
});

test('curveFrames samples a cubic Bezier from its first point to its last', () => {
  const curveFrames = vm.runInContext('curveFrames', ctx);
  const f = plain(curveFrames({ x: -100, y: 50 }, { x: -60, y: 20 }, { x: -20, y: 0 }, { x: 0, y: 0 }, 4));
  assert.equal(f.length, 5);
  assert.deepEqual(f[0], { x: -100, y: 50 });
  assert.deepEqual(f[4], { x: 0, y: 0 });
  assert.deepEqual(f[2], { x: -42.5, y: 13.75 }); // t = 1/2: (p0 + 3 p1 + 3 p2 + p3) / 8
  for (let i = 1; i < f.length; i++) assert.ok(f[i].x > f[i - 1].x && f[i].y <= f[i - 1].y, 'always moving right and up');
});
