//! CSS, SCSS and Less: brackets, strings and comments, then (plain CSS with none of those wrong)
//! every declaration inside a rule needs "property: value", and a ';' before the next one.

use super::code::{self, ScanOpts};
use super::{diag, is_space, is_word, trim, RawDiag, NL};

/// `plain`: a .css file (no // comments, and declarations are checked).
pub fn lint(t: &[u16], plain: bool) -> Vec<RawDiag> {
    let r = code::scan(t, if plain { code::CSS } else { ScanOpts { line_com: Some("//"), ..code::CSS } });
    if plain && r.diags.is_empty() { decls(&r.masked) } else { r.diags }
}

fn decls(masked: &[u16]) -> Vec<RawDiag> {
    let mut out = Vec::new();
    let (mut depth, mut seg) = (0usize, 0usize);
    for (i, &c) in masked.iter().enumerate() {
        let (open, close) = (c == b'{' as u16, c == b'}' as u16);
        if !open && !close && c != b';' as u16 { continue; }
        let text = &masked[seg..i];
        let (s, e) = trim(text);
        if depth > 0 && !open && s < e && text[s] != b'@' as u16 {
            if let Some(m) = decl_mistake(&text[s..e], seg + s) { out.push(m); }
        }
        depth = (depth + usize::from(open)).saturating_sub(usize::from(close));
        seg = i + 1;
    }
    out
}

/// One declaration's mistake: no ':' at all, or a line with one followed by a line that starts a
/// new `property:` (the ';' between them is missing).
fn decl_mistake(text: &[u16], at: usize) -> Option<RawDiag> {
    let colon = b':' as u16;
    if !text.contains(&colon) { return Some(diag(at, text.len(), "Expected ':' between the property and its value")); }
    let rows: Vec<&[u16]> = text.split(|&c| c == NL).collect();
    let k = (0..rows.len().saturating_sub(1)).find(|&n| rows[n].contains(&colon) && starts_property(rows[n + 1]))?;
    let end: usize = rows[..=k].iter().map(|r| r.len()).sum::<usize>() + k;
    Some(diag(at + end, 1, "Missing ';' at the end of this line"))
}

/// `^\s*[-\w]+\s*:`
fn starts_property(row: &[u16]) -> bool {
    let mut j = 0;
    while j < row.len() && is_space(row[j]) { j += 1; }
    let name = j;
    while j < row.len() && (is_word(row[j]) || row[j] == b'-' as u16) { j += 1; }
    if j == name { return false; }
    while j < row.len() && is_space(row[j]) { j += 1; }
    j < row.len() && row[j] == b':' as u16
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lint::units;

    fn msgs(s: &str, plain: bool) -> Vec<(usize, usize, String)> { lint(&units(s), plain).into_iter().map(|d| (d.at, d.len, d.msg)).collect() }

    #[test] fn declarations() {
        assert_eq!(msgs("a { color: red; b: c }", true), vec![]);
        assert_eq!(msgs("a { color red; }", true), vec![(4, 9, "Expected ':' between the property and its value".into())]);
        assert_eq!(msgs("a {\n  color: red\n  margin: 0;\n}", true), vec![(16, 1, "Missing ';' at the end of this line".into())]);
        assert_eq!(msgs("@media x { a { b: c } }", true), vec![]);
        assert_eq!(msgs("a:hover { x: 'a;b' /* c;d */ }", true), vec![]);
    }
    #[test] fn scss_has_line_comments_and_skips_declarations() {
        assert_eq!(msgs("a { // b (\n color red; }", false), vec![]);
        assert_eq!(msgs("a { (", false), vec![(2, 1, "'{' is never closed".into()), (4, 1, "'(' is never closed".into())]);
    }
}
