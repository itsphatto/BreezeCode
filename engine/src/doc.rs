//! The document model: a rope of text plus the facts about the file it came from.
//!
//! Only `\n` ends a line. A `\r` directly before that `\n` belongs to the terminator and is
//! never shown; any other `\r` is ordinary text. Columns count UTF-16 code units, like the page.

use std::path::{Path, PathBuf};

use ropey::{Rope, RopeSlice};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
pub struct Pos { pub line: usize, pub col: usize }

#[derive(Debug, PartialEq, serde::Serialize)]
pub struct LineItem { pub text: String, pub len: usize }

/// A line longer than this many UTF-16 units is sent cut to this length.
pub const LONG_LINE: usize = 10_000;
/// Files above this size are refused.
pub const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Why an edit was made. Undo history uses it to decide which edits merge into one step.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EditKind { Type, Delete, Paste, Other }

/// The error for an edit to a file that isn't valid UTF-8.
pub const READ_ONLY_MSG: &str = "This file isn't valid UTF-8, so it can't be edited here";

const BOM: &[u8] = b"\xEF\xBB\xBF";

// Some fields are only read by later tasks (saving, editing, undo).
#[allow(dead_code)]
pub struct Doc {
    rope: Rope,
    path: Option<PathBuf>,
    eol: &'static str,
    bom: bool,
    read_only: bool,
    bytes: u64,
    rev: u64,
    saved_rev: u64,
}

impl Doc {
    pub fn load(path: &Path) -> Result<Doc, String> {
        let meta = std::fs::metadata(path).map_err(|e| format!("Couldn't open that file: {e}"))?;
        if meta.len() > MAX_BYTES { return Err("This file is larger than 2 GB".to_string()); }
        let bytes = std::fs::read(path).map_err(|e| format!("Couldn't read that file: {e}"))?;
        let mut doc = Doc::from_bytes(bytes);
        doc.path = Some(path.to_path_buf());
        Ok(doc)
    }

    /// A document with no path, built from raw file bytes.
    pub fn from_bytes(bytes: Vec<u8>) -> Doc {
        let size = bytes.len() as u64;
        let bom = bytes.starts_with(BOM);
        let body = if bom { &bytes[BOM.len()..] } else { &bytes[..] };
        let (rope, read_only) = match std::str::from_utf8(body) {
            Ok(s) => (Rope::from_str(s), false),
            Err(_) => (Rope::from_str(&String::from_utf8_lossy(body)), true),
        };
        let eol = if has_crlf(&rope) { "\r\n" } else { "\n" };
        Doc { rope, path: None, eol, bom, read_only, bytes: size, rev: 0, saved_rev: 0 }
    }

    pub fn line_count(&self) -> usize { self.rope.len_lines() }

    /// Up to `count` lines starting at `first`, clamped to the end of the document. Lines longer
    /// than `LONG_LINE` units come back cut, with their full length in `len`.
    pub fn lines(&self, first: usize, count: usize) -> Vec<LineItem> {
        let end = first.saturating_add(count).min(self.line_count());
        (first..end).map(|i| {
            let content = self.line_content(i);
            let len = content.len_utf16_cu();
            let text = if len > LONG_LINE {
                content.slice(..content.utf16_cu_to_char(LONG_LINE)).to_string()
            } else {
                content.to_string()
            };
            LineItem { text, len }
        }).collect()
    }

    pub fn eol(&self) -> &'static str { self.eol }
    pub fn read_only(&self) -> bool { self.read_only }
    pub fn bytes(&self) -> u64 { self.bytes }
    pub fn rev(&self) -> u64 { self.rev }
    pub fn dirty(&self) -> bool { self.rev != self.saved_rev }

    /// Replaces `start..end` with `text`. Returns the caret: the position just after the inserted
    /// text. `text` uses `\n`; every `\r` is dropped and each `\n` becomes the file's line ending.
    /// An `end` before `start` is swapped; positions past the end clamp.
    pub fn edit(&mut self, start: Pos, end: Pos, text: &str, _kind: EditKind) -> Result<Pos, String> {
        if self.read_only { return Err(READ_ONLY_MSG.to_string()); }
        let (start, end) = if end < start { (end, start) } else { (start, end) };
        let (from, to) = (self.char_at(start), self.char_at(end));
        let inserted = self.normalise_eol(text);
        let inserted_chars = inserted.chars().count();
        // Task 3 records the undo step here, from the text `splice` returns.
        self.splice(from, to, &inserted);
        self.rev += 1;
        Ok(self.pos_at(from + inserted_chars))
    }

    /// The same replacement by rope char index, with no history entry. Returns the removed text.
    pub(crate) fn splice(&mut self, from: usize, to: usize, text: &str) -> String {
        let removed = self.rope.slice(from..to).to_string();
        if to > from { self.rope.remove(from..to); }
        if !text.is_empty() { self.rope.insert(from, text); }
        removed
    }

    /// The full text, line endings included. For tests.
    #[cfg(test)]
    pub fn whole(&self) -> String { self.rope.to_string() }

    /// `text` with every `\r` removed and each `\n` replaced by the file's line ending.
    fn normalise_eol(&self, text: &str) -> String {
        let mut out = String::with_capacity(text.len());
        for c in text.chars() {
            match c {
                '\r' => {}
                '\n' => out.push_str(self.eol),
                c => out.push(c),
            }
        }
        out
    }

    /// The rope char index for `pos`. A line past the end clamps to the end of the document, a
    /// column past the end of its line clamps to that end, and a column inside a surrogate pair
    /// rounds down to the pair's start.
    pub(crate) fn char_at(&self, pos: Pos) -> usize {
        if pos.line >= self.line_count() { return self.rope.len_chars(); }
        let content = self.line_content(pos.line);
        let col = pos.col.min(content.len_utf16_cu());
        self.rope.line_to_char(pos.line) + content.utf16_cu_to_char(col)
    }

    pub(crate) fn pos_at(&self, char_idx: usize) -> Pos {
        let char_idx = char_idx.min(self.rope.len_chars());
        let line = self.rope.char_to_line(char_idx);
        let start = self.rope.line_to_char(line);
        let col = self.rope.char_to_utf16_cu(char_idx) - self.rope.char_to_utf16_cu(start);
        Pos { line, col: col.min(self.line_content(line).len_utf16_cu()) }
    }

    /// Line `i` without its terminator: a trailing `\n`, and the `\r` before it.
    fn line_content(&self, i: usize) -> RopeSlice<'_> {
        let line = self.rope.line(i);
        let mut end = line.len_chars();
        if end > 0 && line.char(end - 1) == '\n' {
            end -= 1;
            if end > 0 && line.char(end - 1) == '\r' { end -= 1; }
        }
        line.slice(..end)
    }
}

/// Whether the text holds `\r\n` anywhere, including across a chunk boundary.
fn has_crlf(rope: &Rope) -> bool {
    let finder = memchr::memmem::Finder::new(b"\r\n");
    let mut prev_ends_cr = false;
    for chunk in rope.chunks() {
        let b = chunk.as_bytes();
        if (prev_ends_cr && b.first() == Some(&b'\n')) || finder.find(b).is_some() { return true; }
        prev_ends_cr = b.last() == Some(&b'\r');
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(s: &str) -> Doc { Doc::from_bytes(s.as_bytes().to_vec()) }
    fn texts(d: &Doc, first: usize, count: usize) -> Vec<String> { d.lines(first, count).into_iter().map(|l| l.text).collect() }

    #[test] fn empty_file_has_one_line() { let d = doc(""); assert_eq!(d.line_count(), 1); assert_eq!(texts(&d, 0, 5), [""]); }
    #[test] fn trailing_newline_gives_final_empty_line() { let d = doc("a\nb\n"); assert_eq!(d.line_count(), 3); assert_eq!(texts(&d, 0, 9), ["a", "b", ""]); }
    #[test] fn no_trailing_newline() { let d = doc("a\nb"); assert_eq!(d.line_count(), 2); }
    #[test] fn crlf_and_lone_cr() {
        let d = doc("a\r\nb\rc\n");
        assert_eq!(d.line_count(), 3);                    // lone \r does not end a line
        assert_eq!(texts(&d, 0, 9), ["a", "b\rc", ""]);  // trailing \r stripped, inner \r kept
        assert_eq!(d.eol(), "\r\n");
    }
    #[test] fn cr_at_end_of_file_without_lf_is_text() { let d = doc("a\r"); assert_eq!(texts(&d, 0, 1), ["a\r"]); assert_eq!(d.eol(), "\n"); }
    #[test] fn lf_file_reports_lf() { assert_eq!(doc("a\nb").eol(), "\n"); }
    #[test] fn bom_is_hidden() { let d = Doc::from_bytes(b"\xEF\xBB\xBFhi\n".to_vec()); assert_eq!(texts(&d, 0, 1), ["hi"]); }
    #[test] fn window_clamps_to_end() { let d = doc("a\nb\nc"); assert_eq!(texts(&d, 2, 50), ["c"]); assert!(d.lines(9, 5).is_empty()); }
    #[test] fn long_line_is_cut() {
        let d = doc(&"x".repeat(25_000));
        let l = &d.lines(0, 1)[0];
        assert_eq!(l.text.len(), LONG_LINE); assert_eq!(l.len, 25_000);
    }
    #[test] fn cut_never_splits_a_surrogate_pair() {
        let d = doc(&format!("{}😀", "x".repeat(LONG_LINE - 1)));   // the emoji straddles unit 10,000
        let l = &d.lines(0, 1)[0];
        assert_eq!(l.text.encode_utf16().count(), LONG_LINE - 1); assert_eq!(l.len, LONG_LINE + 1);
    }
    #[test] fn len_counts_utf16_units() { assert_eq!(doc("a😀é").lines(0, 1)[0].len, 4); }
    #[test] fn invalid_utf8_is_read_only() { let d = Doc::from_bytes(vec![b'a', 0xFF, b'\n']); assert!(d.read_only()); assert_eq!(d.line_count(), 2); }
    #[test] fn positions_clamp() {
        let d = doc("ab\n😀c");
        assert_eq!(d.pos_at(d.char_at(Pos { line: 0, col: 99 })), Pos { line: 0, col: 2 });
        assert_eq!(d.pos_at(d.char_at(Pos { line: 99, col: 0 })), Pos { line: 1, col: 3 });
        assert_eq!(d.pos_at(d.char_at(Pos { line: 1, col: 1 })), Pos { line: 1, col: 0 });   // inside the pair: back to its start
    }
    #[test] fn load_refuses_missing_file() { assert!(Doc::load(std::path::Path::new("no/such/file")).is_err()); }

    fn p(line: usize, col: usize) -> Pos { Pos { line, col } }
    #[test] fn insert_and_caret() { let mut d = doc("ab\ncd"); assert_eq!(d.edit(p(0,1), p(0,1), "X", EditKind::Type).unwrap(), p(0,2)); assert_eq!(d.whole(), "aXb\ncd"); assert!(d.dirty()); assert_eq!(d.rev(), 1); }
    #[test] fn replace_across_lines() { let mut d = doc("ab\ncd\nef"); d.edit(p(0,1), p(2,1), "-", EditKind::Other).unwrap(); assert_eq!(d.whole(), "a-f"); assert_eq!(d.line_count(), 1); }
    #[test] fn newline_uses_file_ending() { let mut d = doc("a\r\nb"); assert_eq!(d.edit(p(0,1), p(0,1), "\nx", EditKind::Type).unwrap(), p(1,1)); assert_eq!(d.whole(), "a\r\nx\r\nb"); }
    #[test] fn pasted_crlf_into_lf_file_is_normalised() { let mut d = doc("a"); d.edit(p(0,1), p(0,1), "\r\nb", EditKind::Paste).unwrap(); assert_eq!(d.whole(), "a\nb"); }
    #[test] fn utf16_columns() { let mut d = doc("😀b"); d.edit(p(0,2), p(0,3), "", EditKind::Delete).unwrap(); assert_eq!(d.whole(), "😀"); }
    #[test] fn backspace_at_line_start_joins_crlf_lines() { let mut d = doc("a\r\nb"); d.edit(p(0,1), p(1,0), "", EditKind::Delete).unwrap(); assert_eq!(d.whole(), "ab"); }
    #[test] fn out_of_range_clamps() { let mut d = doc("ab"); assert_eq!(d.edit(p(9,9), p(9,9), "!", EditKind::Type).unwrap(), p(0,3)); assert_eq!(d.whole(), "ab!"); }
    #[test] fn reversed_range_is_swapped() { let mut d = doc("abc"); d.edit(p(0,2), p(0,1), "", EditKind::Delete).unwrap(); assert_eq!(d.whole(), "ac"); }
    #[test] fn read_only_refuses() { let mut d = Doc::from_bytes(vec![0xFF]); assert_eq!(d.edit(p(0,0), p(0,0), "a", EditKind::Type).unwrap_err(), READ_ONLY_MSG); }
    #[test] fn edit_inside_a_cut_line() { let mut d = doc(&"x".repeat(30_000)); d.edit(p(0,5), p(0,5), "Y", EditKind::Type).unwrap(); assert_eq!(d.lines(0,1)[0].len, 30_001); assert_eq!(&d.lines(0,1)[0].text[..7], "xxxxxYx"); }
}
