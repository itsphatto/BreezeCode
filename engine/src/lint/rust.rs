//! Rust: strings may span lines and hold raw text (r#"…"#), and a lone ' starts a lifetime rather
//! than a string, so strings and chars are blanked first (comments stay for the scanner), then the
//! code scanner checks comments and brackets. The page's `lintRust`.

use super::code;
use super::{diag, index_of, is, line_end, starts_with, RawDiag, NL};

pub fn lint(t: &[u16]) -> Vec<RawDiag> {
    let mut diags = Vec::new();
    let mut blanked = t.to_vec();
    let mut i = 0;
    while i < t.len() {
        let Some(m) = literal_at(t, i) else { i += 1; continue };
        if let Some(close) = m.close {
            // An unclosed string runs to the end of the file: it is too short to hold its closer, or doesn't end with it.
            let (open, end) = (m.open - i, m.end - i);
            let closer = if close { "\"#" } else { "\"" };
            if end < open + 1 + closer.len() || !ends_with(&t[i..m.end], closer) {
                diags.push(diag(i, open + 1, format!("String is never closed (missing {closer})")));
            }
        }
        if m.blank { for k in i..m.end { if t[k] != NL { blanked[k] = b' ' as u16; } } }
        i = m.end;
    }
    diags.extend(code::scan(&blanked, code::RS).diags);
    diags
}

/// A comment, string or char literal starting at `i`.
struct Literal {
    end: usize,
    /// Strings and chars are blanked; comments are kept.
    blank: bool,
    /// For a string: where its opening quote is, and in `close` whether it ends with `"#`.
    open: usize,
    close: Option<bool>,
}

fn ends_with(t: &[u16], pat: &str) -> bool { t.len() >= pat.len() && starts_with(t, t.len() - pat.len(), pat) }

/// The first of these that matches at `i` (the page's `RS_TEXT` regex, alternative by alternative):
/// `//…`, `/*…*/`, `b?r#?"…"#?`, `b?"…"`, `b?'c'`.
fn literal_at(t: &[u16], i: usize) -> Option<Literal> {
    let comment = |end| Some(Literal { end, blank: false, open: 0, close: None });
    if starts_with(t, i, "//") { return comment(line_end(t, i)); }
    if starts_with(t, i, "/*") { return comment(index_of(t, "*/", i + 2).map_or(t.len(), |e| e + 2)); }
    // with an optional b before it, the char `c` at `i`
    let after_b = |c: u8| if is(t, i, b'b') { is(t, i + 1, c).then_some(i + 1) } else { is(t, i, c).then_some(i) };

    // r"raw" or r#"raw"#, to the first closer or the end of the file
    if let Some(r) = after_b(b'r') {
        let hashed = is(t, r + 1, b'#') && is(t, r + 2, b'"');
        if hashed || is(t, r + 1, b'"') {
            let open = if hashed { r + 2 } else { r + 1 };
            let closer = if hashed { "\"#" } else { "\"" };
            let end = index_of(t, closer, open + 1).map_or(t.len(), |e| e + closer.len());
            return Some(Literal { end, blank: true, open, close: Some(hashed) });
        }
    }
    // "string" with escapes, to its quote or the end of the file; a lone \ at the very end matches nothing
    if let Some(q) = after_b(b'"') {
        let mut j = q + 1;
        loop {
            if is(t, j, b'\\') && j + 1 < t.len() { j += 2; }
            else if j < t.len() && !is(t, j, b'"') && !is(t, j, b'\\') { j += 1; }
            else { break; }
        }
        if is(t, j, b'"') { return Some(Literal { end: j + 1, blank: true, open: q, close: Some(false) }); }
        if j == t.len() { return Some(Literal { end: j, blank: true, open: q, close: Some(false) }); }
    }
    // 'c' or '\n': one (escaped) unit between quotes, so a 'lifetime is left alone
    if let Some(s) = after_b(b'\'') {
        let end = if is(t, s + 1, b'\\') { (s + 2 < t.len() && is(t, s + 3, b'\'')).then_some(s + 4) }
            else { (s + 1 < t.len() && !is(t, s + 1, b'\'') && !is(t, s + 1, b'\n') && is(t, s + 2, b'\'')).then_some(s + 3) };
        if let Some(end) = end { return Some(Literal { end, blank: true, open: 0, close: None }); }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lint::units;

    fn msgs(s: &str) -> Vec<(usize, usize, String)> { lint(&units(s)).into_iter().map(|d| (d.at, d.len, d.msg)).collect() }

    #[test] fn good_rust() {
        assert_eq!(msgs("fn f<'a>(x: &'a str) -> char { let s = \"(\"; let r = r#\"\"{\"#; let c = '('; let q = '\"'; let e = '\\''; b'[' } fn g() -> u8 { b'\"' }"), vec![]);
        assert_eq!(msgs("// (\n/* [ */ let s = \"multi\nline (\";"), vec![]);
    }
    #[test] fn unclosed_strings_and_brackets() {
        assert_eq!(msgs("let s = \"abc"), vec![(8, 1, "String is never closed (missing \")".into())]);
        assert_eq!(msgs("let s = r#\"abc\""), vec![(8, 3, "String is never closed (missing \"#)".into())]);
        assert_eq!(msgs("fn f() {"), vec![(7, 1, "'{' is never closed".into())]);
        assert_eq!(msgs("/* x"), vec![(0, 2, "Comment is never closed (missing */)".into())]);
    }
}
