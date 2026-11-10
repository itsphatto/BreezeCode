//! The document model: a rope of text plus the facts about the file it came from.
//!
//! Only `\n` ends a line. A `\r` directly before that `\n` belongs to the terminator and is
//! never shown; any other `\r` is ordinary text. Columns count UTF-16 code units, like the page.

use std::path::{Path, PathBuf};

use ropey::{Rope, RopeSlice};

use crate::disk::{self, Stamp};
use crate::history::{History, Step};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
pub struct Pos { pub line: usize, pub col: usize }

#[derive(Debug, PartialEq, serde::Serialize)]
pub struct LineItem { pub text: String, pub len: usize }

/// A line longer than this many UTF-16 units is sent cut to this length.
pub const LONG_LINE: usize = 10_000;
/// Files above this size are refused.
pub const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Refuses a file above `MAX_BYTES`.
pub fn check_size(bytes: u64) -> Result<(), String> {
    if bytes > MAX_BYTES { Err("This file is larger than 2 GB".to_string()) } else { Ok(()) }
}

/// Why an edit was made. Undo history uses it to decide which edits merge into one step.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EditKind { Type, Delete, Paste, Other }

/// The error for an edit to a file that isn't valid UTF-8.
pub const READ_ONLY_MSG: &str = "This file isn't valid UTF-8, so it can't be edited here";

const NO_PATH_MSG: &str = "This file has no path";

const BOM: &[u8] = b"\xEF\xBB\xBF";

pub struct Doc {
    rope: Rope,
    path: Option<PathBuf>,
    eol: &'static str,
    bom: bool,
    read_only: bool,
    bytes: u64,
    rev: u64,
    saved_rev: u64,
    stamp: Option<Stamp>,
    history: History,
}

impl Doc {
    pub fn load(path: &Path) -> Result<Doc, String> {
        let (bytes, stamp) = read_disk(path)?;
        let mut doc = Doc::from_bytes(bytes);
        doc.path = Some(path.to_path_buf());
        doc.stamp = stamp;
        Ok(doc)
    }

    /// A document with no path, built from raw file bytes.
    pub fn from_bytes(bytes: Vec<u8>) -> Doc {
        let content = Content::parse(bytes);
        Doc {
            rope: content.rope, path: None, eol: content.eol, bom: content.bom, read_only: content.read_only,
            bytes: content.bytes, rev: 0, saved_rev: 0, stamp: None, history: History::default(),
        }
    }

    pub fn path(&self) -> Option<&Path> { self.path.as_deref() }

    /// The file's stamp as of the last load, reload or save.
    pub fn stamp(&self) -> Option<Stamp> { self.stamp }

    /// Whether the file's stamp differs from ours, or the file is gone. A document with no path
    /// never changes on disk.
    pub fn changed_on_disk(&self) -> bool {
        match &self.path {
            None => false,
            Some(path) => disk::stamp(path).ok() != self.stamp,
        }
    }

    /// Writes the document over its file. A failed save leaves the file, the text and the dirty
    /// state untouched. Returns the bytes written.
    pub fn save(&mut self) -> Result<u64, String> {
        if self.read_only { return Err(READ_ONLY_MSG.to_string()); }
        let path = self.path.clone().ok_or_else(|| NO_PATH_MSG.to_string())?;
        let written = disk::write_atomic(&path, self.bom, self.rope.chunks())?;
        self.bytes = written;
        self.saved_rev = self.rev;
        self.stamp = disk::stamp(&path).ok();   // taken after the rename, so our own save is not seen as an outside change
        Ok(written)
    }

    /// Re-reads the file, replacing the text. Undo history is dropped: its steps point into text
    /// that no longer exists. The reloaded text counts as saved. A failed read changes nothing.
    pub fn reload(&mut self) -> Result<(), String> {
        let path = self.path.clone().ok_or_else(|| NO_PATH_MSG.to_string())?;
        let (bytes, stamp) = read_disk(&path)?;
        let content = Content::parse(bytes);
        self.rope = content.rope;
        self.eol = content.eol;
        self.bom = content.bom;
        self.read_only = content.read_only;
        self.bytes = content.bytes;
        self.stamp = stamp;
        self.history.clear();
        self.rev += 1;
        self.saved_rev = self.rev;
        Ok(())
    }

    pub fn line_count(&self) -> usize { self.rope.len_lines() }

    pub(crate) fn rope(&self) -> &Rope { &self.rope }

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
    pub fn edit(&mut self, start: Pos, end: Pos, text: &str, kind: EditKind) -> Result<Pos, String> {
        if self.read_only { return Err(READ_ONLY_MSG.to_string()); }
        let (start, end) = if end < start { (end, start) } else { (start, end) };
        let (from, to) = (self.char_at(start), self.char_at(end));
        let inserted = self.normalise_eol(text);
        let inserted_chars = inserted.chars().count();
        let removed = self.splice(from, to, &inserted);
        if !removed.is_empty() || !inserted.is_empty() {
            self.history.record(Step { at: from, removed, inserted, kind });
        }
        self.rev += 1;
        Ok(self.pos_at(from + inserted_chars))
    }

    /// Reverses the latest step. Returns the caret just after the restored text, or `None` when
    /// there is nothing to undo.
    pub fn undo(&mut self) -> Option<Pos> {
        let step = self.history.pop_undo()?;
        self.splice(step.at, step.at + step.inserted.chars().count(), &step.removed);
        let caret = self.pos_at(step.at + step.removed.chars().count());
        self.history.push_redo(step);
        self.rev += 1;
        Some(caret)
    }

    /// Applies the latest undone step again. Returns the caret just after the re-inserted text, or
    /// `None` when there is nothing to redo.
    pub fn redo(&mut self) -> Option<Pos> {
        let step = self.history.pop_redo()?;
        self.splice(step.at, step.at + step.removed.chars().count(), &step.inserted);
        let caret = self.pos_at(step.at + step.inserted.chars().count());
        self.history.push_undo(step);
        self.rev += 1;
        Some(caret)
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

/// The facts derived from a file's bytes: shared by loading and reloading.
struct Content { rope: Rope, eol: &'static str, bom: bool, read_only: bool, bytes: u64 }

impl Content {
    fn parse(bytes: Vec<u8>) -> Content {
        let size = bytes.len() as u64;
        let bom = bytes.starts_with(BOM);
        let body = if bom { &bytes[BOM.len()..] } else { &bytes[..] };
        let (rope, read_only) = match std::str::from_utf8(body) {
            Ok(s) => (Rope::from_str(s), false),
            Err(_) => (Rope::from_str(&String::from_utf8_lossy(body)), true),
        };
        let eol = if has_crlf(&rope) { "\r\n" } else { "\n" };
        Content { rope, eol, bom, read_only, bytes: size }
    }
}

/// The file's bytes and its stamp. The stamp is taken before the read, so a change that lands
/// in between is noticed later rather than missed.
fn read_disk(path: &Path) -> Result<(Vec<u8>, Option<Stamp>), String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("Couldn't open that file: {e}"))?;
    check_size(meta.len())?;
    let stamp = disk::stamp(path).ok();
    let bytes = std::fs::read(path).map_err(|e| format!("Couldn't read that file: {e}"))?;
    Ok((bytes, stamp))
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
    use crate::search::{Hit, COUNT_CAP, TEXT_CAP_BYTES, TEXT_CAP_MSG};
    use crate::testutil::TempDir;

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
    fn ty(d: &mut Doc, line: usize, col: usize, s: &str) { d.edit(p(line,col), p(line,col), s, EditKind::Type).unwrap(); }
    #[test] fn typed_word_is_one_step() { let mut d = doc(""); ty(&mut d,0,0,"a"); ty(&mut d,0,1,"b"); ty(&mut d,0,2,"c"); assert_eq!(d.undo(), Some(p(0,0))); assert_eq!(d.whole(), ""); assert_eq!(d.undo(), None); }
    #[test] fn newline_breaks_the_group() { let mut d = doc(""); ty(&mut d,0,0,"a"); ty(&mut d,0,1,"\n"); ty(&mut d,1,0,"b"); d.undo(); assert_eq!(d.whole(), "a\n"); d.undo(); assert_eq!(d.whole(), "a"); }
    #[test] fn typing_elsewhere_breaks_the_group() { let mut d = doc("xy"); ty(&mut d,0,0,"a"); ty(&mut d,0,3,"b"); d.undo(); assert_eq!(d.whole(), "axy"); }
    #[test] fn backspaces_group() { let mut d = doc("abc"); d.edit(p(0,2),p(0,3),"",EditKind::Delete).unwrap(); d.edit(p(0,1),p(0,2),"",EditKind::Delete).unwrap(); assert_eq!(d.undo(), Some(p(0,3))); assert_eq!(d.whole(), "abc"); }
    #[test] fn delete_key_presses_group() { let mut d = doc("abcd"); d.edit(p(0,1),p(0,2),"",EditKind::Delete).unwrap(); d.edit(p(0,1),p(0,2),"",EditKind::Delete).unwrap(); assert_eq!(d.whole(), "ad"); assert_eq!(d.undo(), Some(p(0,3))); assert_eq!(d.whole(), "abcd"); assert_eq!(d.redo(), Some(p(0,1))); assert_eq!(d.whole(), "ad"); }
    #[test] fn paste_never_groups() { let mut d = doc(""); d.edit(p(0,0),p(0,0),"a",EditKind::Paste).unwrap(); d.edit(p(0,1),p(0,1),"b",EditKind::Paste).unwrap(); d.undo(); assert_eq!(d.whole(), "a"); }
    #[test] fn redo_restores_and_new_edit_clears_it() { let mut d = doc(""); ty(&mut d,0,0,"a"); d.undo(); assert_eq!(d.redo(), Some(p(0,1))); assert_eq!(d.whole(), "a"); d.undo(); ty(&mut d,0,0,"z"); assert_eq!(d.redo(), None); }
    #[test] fn undo_replace_restores_removed_text() { let mut d = doc("hello"); d.edit(p(0,0),p(0,5),"x",EditKind::Other).unwrap(); d.undo(); assert_eq!(d.whole(), "hello"); }
    #[test] fn undo_and_redo_bump_rev_and_stay_dirty() { let mut d = doc("a"); ty(&mut d,0,1,"b"); assert_eq!(d.rev(), 1); d.undo(); assert_eq!(d.rev(), 2); assert!(d.dirty()); d.redo(); assert_eq!(d.rev(), 3); }
    #[test] fn undo_with_nothing_changes_nothing() { let mut d = doc("a"); assert_eq!(d.undo(), None); assert_eq!(d.redo(), None); assert_eq!(d.rev(), 0); }
    #[test] fn undo_keeps_crlf_and_utf16_columns() {
        let mut d = doc("a\r\nb");
        d.edit(p(0,1), p(1,0), "😀", EditKind::Other).unwrap();
        assert_eq!(d.whole(), "a😀b");
        assert_eq!(d.undo(), Some(p(1,0))); assert_eq!(d.whole(), "a\r\nb");
        assert_eq!(d.redo(), Some(p(0,3))); assert_eq!(d.whole(), "a😀b");
    }
    #[test] fn forward_from_caret_and_wrap() { let d = doc("foo\nbar foo"); assert_eq!(d.find("foo", true, p(0,1), false), Some(Hit { line: 1, col: 4, len: 3 })); assert_eq!(d.find("foo", true, p(1,5), false), Some(Hit { line: 0, col: 0, len: 3 })); }
    #[test] fn backward_and_wrap() { let d = doc("foo\nbar foo"); assert_eq!(d.find("foo", true, p(1,4), true), Some(Hit { line: 0, col: 0, len: 3 })); assert_eq!(d.find("foo", true, p(0,0), true), Some(Hit { line: 1, col: 4, len: 3 })); }
    #[test] fn case_folding_is_ascii() { let d = doc("Foo É"); assert!(d.find("foo", false, p(0,0), false).is_some()); assert!(d.find("foo", true, p(0,0), false).is_none()); assert!(d.find("é", false, p(0,0), false).is_none()); }
    #[test] fn col_and_len_are_utf16() { let d = doc("😀😀x"); assert_eq!(d.find("😀x", true, p(0,0), false), Some(Hit { line: 0, col: 2, len: 3 })); }
    #[test] fn hit_across_chunk_edges() {   // ropey chunks are about 1 KB: a needle placed every 997 bytes crosses many edges
        let mut s = String::new(); for _ in 0..200 { s.push_str(&"a".repeat(990)); s.push_str("NEEDLE!"); }
        assert_eq!(doc(&s).count("NEEDLE!", true), (200, false));
    }
    #[test] fn count_caps() { assert_eq!(doc(&"ab".repeat(20_000)).count("ab", true), (COUNT_CAP, true)); }
    #[test] fn no_overlap() { assert_eq!(doc("aaaa").count("aa", true), (2, false)); }
    #[test] fn empty_query() { let d = doc("abc"); assert_eq!(d.find("", true, p(0,0), false), None); assert_eq!(d.count("", true), (0, false)); }
    #[test] fn text_normalises_endings() { assert_eq!(doc("a\r\nb\r\nc").text(p(0,0), p(2,1)).unwrap(), "a\nb\nc"); }
    #[test] fn text_cap() { let d = doc(&"x".repeat(TEXT_CAP_BYTES + 1)); assert_eq!(d.text(p(0,0), p(0, usize::MAX)).unwrap_err(), TEXT_CAP_MSG); }

    // Hits found through the carry buffer keep their absolute position and are reported once.
    fn cols_of_all_hits(needle: &str, match_case: bool, text: &str) -> Vec<usize> {
        let d = doc(text); let mut out: Vec<usize> = Vec::new(); let mut from = p(0, 0);
        while let Some(h) = d.find(needle, match_case, from, false) {
            if out.last().map_or(false, |&c| c >= h.col) { break; }   // wrapped round
            out.push(h.col); from = p(0, h.col + needle.len());
        }
        out
    }
    #[test] fn chunk_edge_hits_have_exact_positions() {
        let mut s = String::new(); let mut want = Vec::new();
        for _ in 0..50 { s.push_str(&"a".repeat(990)); want.push(s.len()); s.push_str("NEEDLE!"); }
        assert_eq!(cols_of_all_hits("NEEDLE!", true, &s), want);
        assert_eq!(cols_of_all_hits("needle!", false, &s), want);
    }
    #[test] fn no_overlap_across_chunk_edges() {
        for len in 1990..2010 {
            assert_eq!(doc(&"a".repeat(len)).count("aaa", true), (len / 3, false));
            assert_eq!(doc(&"a".repeat(len)).count("AAA", false), (len / 3, false));
        }
    }
    #[test] fn case_insensitive_finds_mixed_case() { let d = doc("xx HeLLo x"); assert_eq!(d.find("hello", false, p(0,0), false), Some(Hit { line: 0, col: 3, len: 5 })); assert_eq!(d.count("HELLO", false), (1, false)); }
    #[test] fn needle_longer_than_text() { let d = doc("ab"); assert_eq!(d.find("abc", true, p(0,0), false), None); assert_eq!(d.count("abc", false), (0, false)); }
    #[test] fn exactly_the_cap_is_not_capped() { assert_eq!(doc(&"ab".repeat(COUNT_CAP)).count("ab", true), (COUNT_CAP, false)); }
    #[test] fn text_range_and_clamp() { let d = doc("ab\ncd\nef"); assert_eq!(d.text(p(0,1), p(1,1)).unwrap(), "b\nc"); assert_eq!(d.text(p(1,1), p(0,1)).unwrap(), "b\nc"); assert_eq!(d.text(p(2,0), p(9,9)).unwrap(), "ef"); }
    #[test] fn text_keeps_lone_cr_and_chunk_edge_crlf() {
        assert_eq!(doc("a\rb\nc").text(p(0,0), p(1,1)).unwrap(), "a\rb\nc");
        let s = format!("{}\r\n{}", "x".repeat(2000), "y".repeat(2000));
        assert_eq!(doc(&s).text(p(0,0), p(1,2000)).unwrap(), format!("{}\n{}", "x".repeat(2000), "y".repeat(2000)));
    }
    #[test] fn scan_matches_a_naive_search_on_random_text() {
        use crate::search::scan;
        let mut seed = 12345u64;
        let mut next = move || { seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); (seed >> 33) as usize };
        for _ in 0..40 {
            let text: String = (0..4000).map(|_| ['a', 'A', 'b', 'é'][next() % 4]).collect();
            let rope = ropey::Rope::from_str(&text);
            for needle in ["a", "ab", "aAb", "bbb", "éa", "abAbaAb"] {
                for match_case in [true, false] {
                    let (from, to) = { let a = next() % (text.len() + 1); let b = next() % (text.len() + 1); (a.min(b), a.max(b)) };
                    let (from, to) = (rope.char_to_byte(rope.byte_to_char(from)), rope.char_to_byte(rope.byte_to_char(to)));
                    let eq = |a: &[u8], b: &[u8]| if match_case { a == b } else { a.eq_ignore_ascii_case(b) };
                    let (hay, nb) = (text.as_bytes(), needle.as_bytes());
                    let mut want = Vec::new(); let mut i = from;
                    while i < to && i + nb.len() <= hay.len() { if eq(&hay[i..i + nb.len()], nb) { want.push(i); i += nb.len(); } else { i += 1; } }
                    let mut got = Vec::new();
                    scan(&rope, nb, match_case, from, to, &mut |b| { got.push(b); true });
                    assert_eq!(got, want, "needle {needle} case {match_case} range {from}..{to}");
                }
            }
        }
    }
    #[test] fn unedited_round_trip_is_byte_identical() {   // CRLF, mixed endings, BOM, no trailing newline
        for bytes in [&b"a\r\nb\nc"[..], b"\xEF\xBB\xBFx\r\n", b"", b"one line"] {
            let t = TempDir::new(); let f = t.file("f.txt", bytes);
            let mut d = Doc::load(&f).unwrap(); d.save().unwrap();
            assert_eq!(std::fs::read(&f).unwrap(), bytes);
        }
    }
    #[test] fn edits_land_and_dirty_clears() { let t = TempDir::new(); let f = t.file("f.txt", b"ab"); let mut d = Doc::load(&f).unwrap(); d.edit(p(0,2),p(0,2),"c",EditKind::Type).unwrap(); assert!(d.dirty()); assert_eq!(d.save().unwrap(), 3); assert!(!d.dirty()); assert_eq!(std::fs::read(&f).unwrap(), b"abc"); assert!(!d.changed_on_disk()); }
    #[test] fn no_temp_file_left_behind() { let t = TempDir::new(); let f = t.file("f.txt", b"a"); Doc::load(&f).unwrap().save().unwrap(); assert_eq!(std::fs::read_dir(t.path()).unwrap().count(), 1); }
    #[test] fn external_change_is_seen_and_reload_takes_it() { let t = TempDir::new(); let f = t.file("f.txt", b"a"); let mut d = Doc::load(&f).unwrap(); assert!(!d.changed_on_disk()); std::fs::write(&f, b"longer").unwrap(); assert!(d.changed_on_disk()); d.reload().unwrap(); assert_eq!(d.whole(), "longer"); assert!(!d.dirty()); assert_eq!(d.undo(), None); assert!(!d.changed_on_disk()); }
    #[test] fn deleted_file_counts_as_changed() { let t = TempDir::new(); let f = t.file("f.txt", b"a"); let d = Doc::load(&f).unwrap(); std::fs::remove_file(&f).unwrap(); assert!(d.changed_on_disk()); }
    #[test] fn read_only_cannot_save() { let t = TempDir::new(); let f = t.file("f.bin", &[0xFF]); assert_eq!(Doc::load(&f).unwrap().save().unwrap_err(), READ_ONLY_MSG); }
    #[test] fn save_without_a_path_fails() { let mut d = doc("a"); assert_eq!(d.save().unwrap_err(), "This file has no path"); assert_eq!(d.reload().unwrap_err(), "This file has no path"); assert!(!d.changed_on_disk()); assert_eq!(d.path(), None); assert_eq!(d.stamp(), None); }
    #[test] fn bom_survives_an_edit_and_save() { let t = TempDir::new(); let f = t.file("f.txt", b"\xEF\xBB\xBFab\r\n"); let mut d = Doc::load(&f).unwrap(); d.edit(p(0,2),p(0,2),"c\nd",EditKind::Type).unwrap(); assert_eq!(d.save().unwrap(), 11); assert_eq!(std::fs::read(&f).unwrap(), b"\xEF\xBB\xBFabc\r\nd\r\n"); assert_eq!(d.bytes(), 11); }
    #[test] fn reload_redetects_ending_bom_and_read_only() {
        let t = TempDir::new(); let f = t.file("f.txt", b"a\nb");
        let mut d = Doc::load(&f).unwrap(); assert_eq!(d.eol(), "\n");
        d.edit(p(0,0),p(0,0),"x",EditKind::Type).unwrap();
        std::fs::write(&f, b"\xEF\xBB\xBFq\r\nr").unwrap(); d.reload().unwrap();
        assert_eq!(d.eol(), "\r\n"); assert_eq!(d.whole(), "q\r\nr"); assert_eq!(d.bytes(), 7); assert!(!d.dirty());
        d.save().unwrap(); assert_eq!(std::fs::read(&f).unwrap(), b"\xEF\xBB\xBFq\r\nr");   // BOM kept
        std::fs::write(&f, [0xFF, b'a']).unwrap(); d.reload().unwrap(); assert!(d.read_only());
    }
    #[test] fn reload_of_a_vanished_file_fails_and_keeps_the_text() { let t = TempDir::new(); let f = t.file("f.txt", b"a"); let mut d = Doc::load(&f).unwrap(); d.edit(p(0,1),p(0,1),"b",EditKind::Type).unwrap(); std::fs::remove_file(&f).unwrap(); assert!(d.reload().is_err()); assert_eq!(d.whole(), "ab"); assert!(d.dirty()); assert!(d.undo().is_some()); }
    #[test] fn save_recreates_a_deleted_file() { let t = TempDir::new(); let f = t.file("f.txt", b"a"); let mut d = Doc::load(&f).unwrap(); std::fs::remove_file(&f).unwrap(); d.save().unwrap(); assert_eq!(std::fs::read(&f).unwrap(), b"a"); assert!(!d.changed_on_disk()); }
    #[test] fn failed_save_into_a_missing_folder_changes_nothing() { let t = TempDir::new(); let sub = t.dir("sub"); let f = sub.join("f.txt"); std::fs::write(&f, b"a").unwrap(); let mut d = Doc::load(&f).unwrap(); d.edit(p(0,1),p(0,1),"b",EditKind::Type).unwrap(); std::fs::remove_dir_all(&sub).unwrap(); assert!(d.save().is_err()); assert!(d.dirty()); assert_eq!(d.whole(), "ab"); }
    #[cfg(windows)]
    #[test] fn locked_file_fails_cleanly() {
        use std::os::windows::fs::OpenOptionsExt;
        let t = TempDir::new(); let f = t.file("f.txt", b"old");
        let mut d = Doc::load(&f).unwrap(); d.edit(p(0,3),p(0,3),"!",EditKind::Type).unwrap();
        let held = std::fs::OpenOptions::new().read(true).share_mode(0).open(&f).unwrap();   // no sharing: rename over it must fail
        assert!(d.save().is_err());
        assert!(d.dirty()); assert_eq!(d.whole(), "old!");
        assert_eq!(std::fs::read_dir(t.path()).unwrap().count(), 1);   // temp file removed
        drop(held); assert_eq!(std::fs::read(&f).unwrap(), b"old");
        assert_eq!(d.save().unwrap(), 4); assert_eq!(std::fs::read(&f).unwrap(), b"old!");   // and a retry works
    }
    #[test] fn edit_inside_a_cut_line() { let mut d = doc(&"x".repeat(30_000)); d.edit(p(0,5), p(0,5), "Y", EditKind::Type).unwrap(); assert_eq!(d.lines(0,1)[0].len, 30_001); assert_eq!(&d.lines(0,1)[0].text[..7], "xxxxxYx"); }
}
