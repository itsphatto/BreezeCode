//! Quick structural checks (the red error lines): brackets, strings, comments, tags, JSON, CSS
//! declarations and Python blocks. A port of the checks in the page's `languages.ts`, which stays
//! as the fallback for a file the engine doesn't hold; `test/lintengine.test.js` keeps the two in step.
//!
//! The checks read the text as UTF-16 code units with `\n` line ends, exactly as the page holds it,
//! so every offset, column and length is the page's own.

mod code;
mod css;
mod json;
mod markup;
mod python;
mod rust;

use ropey::Rope;

/// Texts longer than this many UTF-16 units are not checked (the page's `LINT_MAX`).
pub const LINT_MAX: usize = 400_000;

/// A problem at a unit offset into the text.
#[derive(Clone, Debug, PartialEq)]
pub struct RawDiag { pub at: usize, pub len: usize, pub msg: String }

/// A problem by line and column (UTF-16 units), as the page draws it.
#[derive(Debug, PartialEq, serde::Serialize)]
pub struct Diag { pub line: usize, pub col: usize, pub len: usize, pub msg: String }

/// Which check runs. The page picks it from the file's name.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind { Json, Jsonc, Css, Scss, Less, Html, Xml, Py, Java, Rs, Js, Jsx }

impl Kind {
    pub fn parse(s: &str) -> Option<Kind> {
        Some(match s {
            "json" => Kind::Json, "jsonc" => Kind::Jsonc, "css" => Kind::Css, "scss" => Kind::Scss, "less" => Kind::Less,
            "html" => Kind::Html, "xml" => Kind::Xml, "py" => Kind::Py, "java" => Kind::Java, "rs" => Kind::Rs,
            "js" => Kind::Js, "jsx" => Kind::Jsx,
            _ => return None,
        })
    }
}

/// The problems in `t`, sorted by line then column.
pub fn lint(t: &[u16], kind: Kind) -> Vec<Diag> {
    let raw = match kind {
        Kind::Json => json::check(t, false),
        Kind::Jsonc => json::check(t, true),
        Kind::Css => css::lint(t, true),
        Kind::Scss | Kind::Less => css::lint(t, false),
        Kind::Html => markup::check(t, false),
        Kind::Xml => markup::check(t, true),
        Kind::Py => python::lint(t),
        Kind::Java => code::scan(t, code::JAVA).diags,
        Kind::Rs => rust::lint(t),
        Kind::Js => code::scan(t, code::JS).diags,
        Kind::Jsx => code::scan(t, code::ScanOpts { jsx: true, ..code::JS }).diags,
    };
    to_diags(t, raw)
}

/// The rope's text as the page holds it: UTF-16 units, each `\r\n` as `\n`. None when it is longer
/// than `LINT_MAX` units, decided before anything is built.
pub fn page_units(rope: &Rope) -> Option<Vec<u16>> {
    // Each \r\n loses one unit, and there are fewer of those than lines.
    if rope.len_utf16_cu() > LINT_MAX + rope.len_lines() { return None; }
    let mut out = Vec::with_capacity(rope.len_utf16_cu());
    let mut chars = rope.chars().peekable();
    let mut buf = [0u16; 2];
    while let Some(c) = chars.next() {
        if c == '\r' && chars.peek() == Some(&'\n') { continue; }
        out.extend_from_slice(c.encode_utf16(&mut buf));
    }
    if out.len() > LINT_MAX { None } else { Some(out) }
}

/// Offsets to lines and columns, sorted (stably) by line then column, like the page's `toDiags`.
fn to_diags(t: &[u16], raw: Vec<RawDiag>) -> Vec<Diag> {
    let mut starts = vec![0usize];
    starts.extend(t.iter().enumerate().filter(|(_, &c)| c == NL).map(|(k, _)| k + 1));
    let mut out: Vec<Diag> = raw.into_iter().map(|d| {
        let line = starts.partition_point(|&s| s <= d.at).saturating_sub(1);
        Diag { line, col: d.at - starts[line], len: d.len, msg: d.msg }
    }).collect();
    out.sort_by(|a, b| (a.line, a.col).cmp(&(b.line, b.col)));
    out
}

// ---- Helpers on UTF-16 units, shared by the checks ----

pub(crate) const NL: u16 = b'\n' as u16;

/// The unit at `i`, if there is one (JavaScript's `t[i]`, with `undefined` as None).
pub(crate) fn at(t: &[u16], i: usize) -> Option<u16> { t.get(i).copied() }

/// Whether the unit at `i` is the ASCII char `c`.
pub(crate) fn is(t: &[u16], i: usize, c: u8) -> bool { at(t, i) == Some(c as u16) }

/// Whether `t` holds the ASCII text `pat` at `i`.
pub(crate) fn starts_with(t: &[u16], i: usize, pat: &str) -> bool {
    let p = pat.as_bytes();
    i.checked_add(p.len()).is_some_and(|end| end <= t.len()) && t[i..i + p.len()].iter().zip(p).all(|(&a, &b)| a == b as u16)
}

/// The first `pat` (ASCII) at or after `from`.
pub(crate) fn index_of(t: &[u16], pat: &str, from: usize) -> Option<usize> {
    let first = *pat.as_bytes().first()? as u16;
    (from..t.len()).find(|&k| t[k] == first && starts_with(t, k, pat))
}

/// The end of the line `i` is on: the next `\n` at or after `i`, or the end of the text.
pub(crate) fn line_end(t: &[u16], i: usize) -> usize {
    t.get(i..).and_then(|rest| rest.iter().position(|&c| c == NL)).map_or(t.len(), |k| i + k)
}

/// JavaScript's `\s` (and what `trim` removes).
pub(crate) fn is_space(c: u16) -> bool {
    matches!(c, 0x09..=0x0D | 0x20 | 0xA0 | 0x1680 | 0x2000..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF)
}

/// JavaScript's `\w` without the `u` flag.
pub(crate) fn is_word(c: u16) -> bool {
    c < 128 && ((c as u8).is_ascii_alphanumeric() || c == b'_' as u16)
}

pub(crate) fn is_digit(c: Option<u16>) -> bool { c.is_some_and(|c| (b'0' as u16..=b'9' as u16).contains(&c)) }

/// `t` with JavaScript's `trim` applied: the start and end of what is left.
pub(crate) fn trim(t: &[u16]) -> (usize, usize) {
    let start = t.iter().position(|&c| !is_space(c)).unwrap_or(t.len());
    let end = t.iter().rposition(|&c| !is_space(c)).map_or(start, |k| k + 1);
    (start, end)
}

/// Units as text, for messages.
pub(crate) fn text(t: &[u16]) -> String { String::from_utf16_lossy(t) }

/// The whole char starting at `i`, for a message that names it.
pub(crate) fn char_at(t: &[u16], i: usize) -> String {
    match char::decode_utf16(t[i..].iter().copied()).next() {
        Some(Ok(c)) => c.to_string(),
        _ => char::REPLACEMENT_CHARACTER.to_string(),
    }
}

pub(crate) fn diag(at: usize, len: usize, msg: impl Into<String>) -> RawDiag { RawDiag { at, len, msg: msg.into() } }

#[cfg(test)]
pub(crate) fn units(s: &str) -> Vec<u16> { s.encode_utf16().collect() }

#[cfg(test)]
mod tests {
    use super::*;

    fn lint_str(s: &str, kind: Kind) -> Vec<(usize, usize, usize, String)> {
        lint(&units(s), kind).into_iter().map(|d| (d.line, d.col, d.len, d.msg)).collect()
    }

    #[test] fn kinds_parse() {
        for k in ["json", "jsonc", "css", "scss", "less", "html", "xml", "py", "java", "rs", "js", "jsx"] { assert!(Kind::parse(k).is_some(), "{k}"); }
        assert_eq!(Kind::parse("md"), None);
    }
    #[test] fn diags_are_lines_and_columns_sorted() {
        assert_eq!(lint_str("a\n  )\n(", Kind::Js), vec![(1, 2, 1, "Unexpected ')'".into()), (2, 0, 1, "'(' is never closed".into())]);
    }
    #[test] fn page_units_drops_crlf_only() {
        let r = Rope::from_str("a\r\nb\rc😀");
        assert_eq!(page_units(&r).unwrap(), units("a\nb\rc😀"));
        assert!(page_units(&Rope::from_str(&"x".repeat(LINT_MAX + 1))).is_none());
        assert_eq!(page_units(&Rope::from_str(&"x\r\n".repeat(LINT_MAX / 2))).map(|u| u.len()), Some(LINT_MAX));
    }
    #[test] fn helpers() {
        let t = units("ab\ncd");
        assert!(starts_with(&t, 3, "cd")); assert!(!starts_with(&t, 4, "cd")); assert!(!starts_with(&t, usize::MAX, "c"));
        assert_eq!(index_of(&t, "cd", 0), Some(3)); assert_eq!(index_of(&t, "zz", 0), None);
        assert_eq!(line_end(&t, 0), 2); assert_eq!(line_end(&t, 3), 5); assert_eq!(line_end(&t, 99), 5);
        assert_eq!(trim(&units("  x y \n")), (2, 5)); assert_eq!(trim(&units("   ")), (3, 3));
    }
}
