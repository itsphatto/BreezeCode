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

    /// The rope char index for `pos`. A line past the end clamps to the end of the document, a
    /// column past the end of its line clamps to that end, and a column inside a surrogate pair
    /// rounds down to the pair's start.
    #[allow(dead_code)] // used by the edit commands in later tasks
    pub(crate) fn char_at(&self, pos: Pos) -> usize {
        if pos.line >= self.line_count() { return self.rope.len_chars(); }
        let content = self.line_content(pos.line);
        let col = pos.col.min(content.len_utf16_cu());
        self.rope.line_to_char(pos.line) + content.utf16_cu_to_char(col)
    }

    #[allow(dead_code)] // used by the edit commands in later tasks
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
}
