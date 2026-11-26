//! Unbalanced brackets and unclosed strings, comments, templates and regexes (the page's
//! `CodeScanner`). Also returns the text with comments and string contents blanked, same length, so
//! later checks don't trip over them.

use super::{at, diag, index_of, is, is_space, is_word, line_end, starts_with, RawDiag, NL};

#[derive(Clone, Copy, Debug)]
pub struct ScanOpts {
    pub line_com: Option<&'static str>,
    pub block_com: bool,
    /// The chars that open a one-line string.
    pub quotes: &'static str,
    pub template: bool,
    pub regex: bool,
    /// `"""` and `'''` strings, which may span lines (and are blanked newlines and all).
    pub triple: bool,
    /// JSX text can hold a lone apostrophe.
    pub jsx: bool,
}

const NONE: ScanOpts = ScanOpts { line_com: None, block_com: false, quotes: "", template: false, regex: false, triple: false, jsx: false };
pub const JS: ScanOpts = ScanOpts { line_com: Some("//"), block_com: true, quotes: "'\"", template: true, regex: true, ..NONE };
pub const CSS: ScanOpts = ScanOpts { block_com: true, quotes: "'\"", ..NONE };
pub const PY: ScanOpts = ScanOpts { line_com: Some("#"), quotes: "'\"", triple: true, ..NONE };
pub const JAVA: ScanOpts = ScanOpts { line_com: Some("//"), block_com: true, quotes: "'\"", triple: true, ..NONE };
/// Rust strings are blanked before the scan (`rust::lint`), so it only checks comments and brackets.
pub const RS: ScanOpts = ScanOpts { line_com: Some("//"), block_com: true, ..NONE };

pub struct Scan { pub diags: Vec<RawDiag>, pub masked: Vec<u16> }

pub fn scan(t: &[u16], o: ScanOpts) -> Scan {
    let mut s = Scanner { t, o, diags: Vec::new(), masked: t.to_vec(), stack: Vec::new(), i: 0 };
    while s.i < t.len() { s.step(); }
    for open in std::mem::take(&mut s.stack) { s.diags.push(never_closed(&open)); }
    Scan { diags: s.diags, masked: s.masked }
}

struct Opened { ch: u16, at: usize, /// set for the `{` of a template's `${`: where the template starts
    tmpl: Option<usize> }

fn never_closed(s: &Opened) -> RawDiag {
    match s.tmpl {
        None => diag(s.at, 1, format!("'{}' is never closed", s.ch as u8 as char)),
        Some(_) => diag(s.at, 1, "Template expression is never closed (missing })"),
    }
}

/// The closer of an opening bracket.
fn pair(c: u16) -> Option<u16> {
    match c as u32 { 0x28 => Some(b')' as u16), 0x5B => Some(b']' as u16), 0x7B => Some(b'}' as u16), _ => None }
}
fn is_closer(c: u16) -> bool { c == b')' as u16 || c == b']' as u16 || c == b'}' as u16 }

const REGEX_AFTER_CHARS: &[u8] = b"(,=:[!&|?{};+-*%<>~^";
const REGEX_AFTER_WORDS: [&str; 14] = ["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await", "instanceof"];

/// Whether a `/` after `w` (the 12 units before it) starts a regex rather than a division: after an
/// operator, an opening bracket or one of the keywords, then optional spaces, or after nothing but
/// spaces. The page's `REGEX_AFTER`.
fn regex_after(w: &[u16]) -> bool {
    let mut end = w.len();
    while end > 0 && is_space(w[end - 1]) { end -= 1; }
    if end == 0 { return true; }
    let last = w[end - 1];
    if last < 128 && REGEX_AFTER_CHARS.contains(&(last as u8)) { return true; }
    REGEX_AFTER_WORDS.iter().any(|kw| {
        let k = kw.len();
        end >= k && super::starts_with(w, end - k, kw) && (end == k || !is_word(w[end - k - 1]))
    })
}

struct Scanner<'a> {
    t: &'a [u16],
    o: ScanOpts,
    diags: Vec<RawDiag>,
    masked: Vec<u16>,
    stack: Vec<Opened>,
    i: usize,
}

impl Scanner<'_> {
    /// Blanks `from..to`: every unit but `\n` becomes a space (`\n` too in a triple-quote language,
    /// which joins lines inside strings so a multi-line string reads as one logical line).
    fn mask(&mut self, from: usize, to: usize) {
        let to = to.min(self.t.len());
        for k in from.min(to)..to {
            if self.o.triple || self.t[k] != NL { self.masked[k] = b' ' as u16; }
        }
    }

    fn step(&mut self) {
        let c = self.t[self.i];
        if c == b' ' as u16 || c == NL || c == b'\t' as u16 || c == b'\r' as u16 { self.i += 1; return; }
        if self.comment(c) || self.quoted(c) || self.regex(c) { return; }
        if pair(c).is_some() { self.stack.push(Opened { ch: c, at: self.i, tmpl: None }); self.i += 1; return; }
        if is_closer(c) { self.close(c); return; }
        self.i += 1;
    }

    fn comment(&mut self, c: u16) -> bool {
        let (t, i) = (self.t, self.i);
        if let Some(lc) = self.o.line_com {
            if starts_with(t, i, lc) && (self.o.regex || i == 0 || !is(t, i - 1, b':')) {
                let e = line_end(t, i);
                self.mask(i, e); self.i = e;
                return true;
            }
        }
        if !self.o.block_com || c != b'/' as u16 || !is(t, i + 1, b'*') { return false; }
        match index_of(t, "*/", i + 2) {
            None => self.unclosed(i, 2, "Comment is never closed (missing */)"),
            Some(e) => { self.mask(i, e + 2); self.i = e + 2; }
        }
        true
    }

    /// The rest of the file was swallowed by something that never ends.
    fn unclosed(&mut self, at: usize, len: usize, msg: impl Into<String>) {
        self.diags.push(diag(at, len, msg));
        self.mask(at + len, self.t.len());
        self.i = self.t.len();
    }

    fn quoted(&mut self, c: u16) -> bool {
        let (t, i) = (self.t, self.i);
        if self.o.triple && (starts_with(t, i, "\"\"\"") || starts_with(t, i, "'''")) {
            let q = if starts_with(t, i, "\"\"\"") { "\"\"\"" } else { "'''" };
            match index_of(t, q, i + 3) {
                None => self.unclosed(i, 3, format!("String is never closed (missing {q})")),
                Some(e) => { self.mask(i + 3, e); self.i = e + 3; }
            }
            return true;
        }
        if self.o.template && c == b'`' as u16 { self.i = self.template(i + 1, i); return true; }
        if c >= 128 || !self.o.quotes.as_bytes().contains(&(c as u8)) { return false; }
        let mut j = i + 1;
        while j < t.len() && t[j] != c && t[j] != NL { j += if t[j] == b'\\' as u16 { 2 } else { 1 }; }
        if at(t, j) == Some(c) { self.mask(i + 1, j); self.i = j + 1; return true; }
        if self.o.jsx { self.i += 1; return true; }
        self.diags.push(diag(i, (j - i).max(1), format!("String is never closed (missing {})", c as u8 as char)));
        self.mask(i + 1, j); self.i = j;
        true
    }

    /// Continues a template literal from `from` (just after ` or after a ${…}); returns where code resumes.
    fn template(&mut self, from: usize, start: usize) -> usize {
        let t = self.t;
        let mut j = from;
        while j < t.len() {
            if t[j] == b'\\' as u16 { j += 1; }
            else if t[j] == b'`' as u16 { self.mask(from, j); return j + 1; }
            else if t[j] == b'$' as u16 && is(t, j + 1, b'{') {
                self.mask(from, j);
                self.stack.push(Opened { ch: b'{' as u16, at: j + 1, tmpl: Some(start) });
                return j + 2;
            }
            j += 1;
        }
        self.diags.push(diag(start, 1, "Template literal is never closed (missing `)"));
        self.mask(from, t.len());
        t.len()
    }

    fn regex(&mut self, c: u16) -> bool {
        let (t, i) = (self.t, self.i);
        if !self.o.regex || c != b'/' as u16 || !regex_after(&t[i.saturating_sub(12)..i]) { return false; }
        let (mut j, mut in_class) = (i + 1, false);
        while j < t.len() && t[j] != NL && (in_class || t[j] != b'/' as u16) {
            if t[j] == b'\\' as u16 { j += 1; }
            else if t[j] == b'[' as u16 { in_class = true; }
            else if t[j] == b']' as u16 { in_class = false; }
            j += 1;
        }
        if !is(t, j, b'/') { return false; }   // a division after all
        self.mask(i + 1, j); self.i = j + 1;
        true
    }

    fn close(&mut self, c: u16) {
        if !self.stack.iter().any(|s| pair(s.ch) == Some(c)) {
            self.diags.push(diag(self.i, 1, format!("Unexpected '{}'", c as u8 as char)));
            self.i += 1;
            return;
        }
        // Anything opened after the matching bracket was left open.
        while self.stack.last().and_then(|s| pair(s.ch)) != Some(c) {
            let s = self.stack.pop().expect("a matching bracket is open");
            self.diags.push(never_closed(&s));
        }
        let open = self.stack.pop().expect("a matching bracket is open");
        self.i = match open.tmpl { None => self.i + 1, Some(start) => self.template(self.i + 1, start) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lint::units;

    fn msgs(s: &str, o: ScanOpts) -> Vec<(usize, usize, String)> { scan(&units(s), o).diags.into_iter().map(|d| (d.at, d.len, d.msg)).collect() }

    #[test] fn brackets() {
        assert_eq!(msgs("(a[b]c)", JS), vec![]);
        assert_eq!(msgs("(a]", JS), vec![(2, 1, "Unexpected ']'".into()), (0, 1, "'(' is never closed".into())]);
        assert_eq!(msgs("{(}", JS), vec![(1, 1, "'(' is never closed".into())]);
    }
    #[test] fn strings_comments_templates() {
        assert_eq!(msgs("'a\\'b' \"x", JS), vec![(7, 2, "String is never closed (missing \")".into())]);
        assert_eq!(msgs("/* x", JS), vec![(0, 2, "Comment is never closed (missing */)".into())]);
        assert_eq!(msgs("`a ${ {b} } c` `d", JS), vec![(15, 1, "Template literal is never closed (missing `)".into())]);
        assert_eq!(msgs("`${ a", JS), vec![(2, 1, "Template expression is never closed (missing })".into())]);
        assert_eq!(msgs("x = /[)]/; y = a / b / c", JS), vec![]);
        assert_eq!(msgs("it's", ScanOpts { jsx: true, ..JS }), vec![]);
    }
    #[test] fn masks_keep_length_and_newlines() {
        let r = scan(&units("a = 'x\\ny'; // c\nb"), JS);
        assert_eq!(String::from_utf16(&r.masked).unwrap(), "a = '    ';     \nb");
        let r = scan(&units("s = \"\"\"a\nb\"\"\""), PY);
        assert_eq!(String::from_utf16(&r.masked).unwrap(), "s = \"\"\"   \"\"\"");
    }
    #[test] fn line_comment_after_a_colon_is_a_url_unless_regexes_are_on() {
        assert_eq!(msgs("http://x (", ScanOpts { regex: false, ..JS }).len(), 1);
        assert_eq!(msgs("a = http://x (", JS), vec![]);
    }
    #[test] fn regex_after_rules() {
        for w in ["", "  ", "x = ", "return ", "(", "a.do"] { assert!(regex_after(&units(w)), "{w:?}"); }
        for w in ["x ", "undo", ")", "1"] { assert!(!regex_after(&units(w)), "{w:?}"); }
    }
}
