//! Python: brackets, strings and comments first; with none of those wrong, block statements end in
//! ':' and indentation has to line up (the page's `PythonChecker`).

use super::code;
use super::{diag, is_space, is_word, trim, RawDiag, NL};

pub fn lint(t: &[u16]) -> Vec<RawDiag> {
    let r = code::scan(t, code::PY);
    if !r.diags.is_empty() { return r.diags; }
    let mut checker = Checker { out: Vec::new(), indents: vec![0], opener: None };
    for line in logical_lines(&r.masked) { checker.line(&r.masked, line); }
    checker.out
}

/// A line as Python reads it: lines continued inside brackets or after a backslash are one.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Logical { at: usize, end: usize }

fn bracket_delta(ln: &[u16]) -> isize {
    ln.iter().map(|&c| match c as u32 { 0x28 | 0x5B | 0x7B => 1, 0x29 | 0x5D | 0x7D => -1, _ => 0 }).sum()
}

fn logical_lines(masked: &[u16]) -> Vec<Logical> {
    let mut lines = Vec::new();
    let mut cur: Option<usize> = None;   // where the logical line being joined starts
    let mut depth = 0isize;
    let mut off = 0;
    for ln in masked.split(|&c| c == NL) {
        let at = off;
        off += ln.len() + 1;
        let (s, e) = trim(ln);
        if cur.is_none() && s == e { continue; }
        let start = *cur.get_or_insert(at);
        depth = (depth + bracket_delta(ln)).max(0);
        // a trailing backslash (spaces after it allowed) continues the line
        let continued = e > s && ln[e - 1] == b'\\' as u16;
        if depth == 0 && !continued { lines.push(Logical { at: start, end: at + ln.len() }); cur = None; }
    }
    if let Some(start) = cur { lines.push(Logical { at: start, end: masked.len() }); }
    lines
}

const BLOCK_WORDS: [&str; 11] = ["if", "elif", "else", "for", "while", "def", "class", "try", "except", "finally", "with"];

/// `^(?:async\s+)?(if|elif|…|with)\b`: the block keyword `body` starts with.
fn block_word(body: &[u16]) -> Option<&'static str> {
    let word_at = |from: usize| BLOCK_WORDS.into_iter().find(|w| {
        super::starts_with(body, from, w) && !body.get(from + w.len()).is_some_and(|&c| is_word(c))
    });
    if super::starts_with(body, 0, "async") {
        let mut j = 5;
        while j < body.len() && is_space(body[j]) { j += 1; }
        if j > 5 { if let Some(w) = word_at(j) { return Some(w); } }
    }
    word_at(0)
}

/// The block's ':' sits outside any brackets (and isn't a := walrus).
fn has_block_colon(body: &[u16]) -> bool {
    let mut d = 0isize;
    for (k, &c) in body.iter().enumerate() {
        match c as u32 {
            0x28 | 0x5B | 0x7B => d += 1,
            0x29 | 0x5D | 0x7D => d -= 1,
            0x3A if d == 0 && body.get(k + 1) != Some(&(b'=' as u16)) => return true,
            _ => {}
        }
    }
    false
}

struct Checker {
    out: Vec<RawDiag>,
    indents: Vec<usize>,
    /// The keyword of the previous line, if it ended with ':' ("" for a line that isn't a block statement).
    opener: Option<&'static str>,
}

impl Checker {
    fn line(&mut self, masked: &[u16], l: Logical) {
        let text = &masked[l.at..l.end];
        let lead = text.iter().take_while(|&&c| c == b' ' as u16 || c == b'\t' as u16).count();
        let (s, e) = trim(text);
        let body = &text[s..e];
        self.indent(l, text, lead);
        let kw = block_word(body);
        if let Some(kw) = kw {
            if !has_block_colon(body) {
                self.out.push(diag(l.at + e, 1, format!("Expected ':' after the '{kw}' line")));
            }
        }
        self.opener = if body.last() == Some(&(b':' as u16)) { Some(kw.unwrap_or("")) } else { None };
    }

    fn indent(&mut self, l: Logical, text: &[u16], lead: usize) {
        let tabs = text[..lead].iter().filter(|&&c| c == b'\t' as u16).count();
        let ind = lead + 7 * tabs;   // a tab counts as eight spaces
        let top = *self.indents.last().unwrap_or(&0);
        let span = lead.max(1);
        if self.opener.is_some() && ind <= top {
            let after = match self.opener { Some(w) if !w.is_empty() => format!(" after the '{w}' line"), _ => String::new() };
            self.out.push(diag(l.at + lead, 1, format!("Expected an indented block{after}")));
        } else if ind > top {
            if self.opener.is_none() { self.out.push(diag(l.at, span, "Unexpected indent")); } else { self.indents.push(ind); }
        } else if ind < top {
            while self.indents.len() > 1 && *self.indents.last().unwrap_or(&0) > ind { self.indents.pop(); }
            if self.indents.last() != Some(&ind) { self.out.push(diag(l.at, span, "This indent does not match any outer block")); }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lint::units;

    fn msgs(s: &str) -> Vec<(usize, usize, String)> { lint(&units(s)).into_iter().map(|d| (d.at, d.len, d.msg)).collect() }

    #[test] fn good_python() {
        assert_eq!(msgs("def f(a,\n      b):\n    if a:\n        return b\n    return (\n  1)\nx = 1 \\\n  + 2\n"), vec![]);
        assert_eq!(msgs("async  def f():\n    pass\n"), vec![]);
        assert_eq!(msgs("s = \"\"\"\n  odd\n\"\"\"\n"), vec![]);
    }
    #[test] fn block_mistakes() {
        // without the ':' the next line's indent is unexpected too
        assert_eq!(msgs("if x\n    y"), vec![(4, 1, "Expected ':' after the 'if' line".into()), (5, 4, "Unexpected indent".into())]);
        assert_eq!(msgs("if (a := 1)\n    y"), vec![(11, 1, "Expected ':' after the 'if' line".into()), (12, 4, "Unexpected indent".into())]);
        assert_eq!(msgs("for x in y:\nz"), vec![(12, 1, "Expected an indented block after the 'for' line".into())]);
        assert_eq!(msgs("x = {1:\n2}:\ny"), vec![(12, 1, "Expected an indented block".into())]);
        assert_eq!(msgs("x\n  y"), vec![(2, 2, "Unexpected indent".into())]);
        assert_eq!(msgs("if a:\n    b\n  c"), vec![(12, 2, "This indent does not match any outer block".into())]);
        assert_eq!(msgs("if a:\n\tb\n        c"), vec![]);   // a tab is eight spaces
        assert_eq!(msgs("iffy = 1"), vec![]);
    }
    #[test] fn strings_first() {
        assert_eq!(msgs("x = 'a\nif y"), vec![(4, 2, "String is never closed (missing ')".into())]);
    }
}
