//! The crash journal: every edit is appended to a small file so unsaved work survives a crash of
//! the engine. It is replayed when the same, unchanged file is opened again. It is best effort:
//! every I/O error is swallowed, and a journal that cannot be written simply stops journaling.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::disk::Stamp;
use crate::doc::{Doc, EditKind, Pos, Replacement};

/// One journaled operation. One entry is always one physical line (JSON escapes newlines).
///
/// An undo or redo is journaled as the replacement it performed (`undone` / `redone`), never as
/// "undo the latest step": a save keeps the undo history but restarts the journal, and a replay
/// starts from a freshly loaded document with no history, so replay must not depend on history.
/// The old bare `{"op":"undo"}` / `{"op":"redo"}` lines no longer parse, so a journal written by
/// an earlier build ends its replay there, like a torn tail.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Entry {
    Edit { start: Pos, end: Pos, text: String, kind: EditKind },
    Undone(Replacement),
    Redone(Replacement),
}

/// The first line of a journal file: which document, in which state, the entries apply to.
/// `eol` is the line ending the document inserts for a typed newline. A document keeps the ending
/// it was first loaded with across saves, while a fresh load re-detects it from the saved bytes, so
/// the replay must restore it or the entries would insert different line endings. It is absent in
/// journals written by an earlier build; those replay with the detected ending.
#[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
struct Header { path: String, size: u64, mtime_ms: u64, #[serde(default)] eol: Option<String> }

pub struct Journal {
    file_path: PathBuf,
    file: Option<File>,
    doc_path: String,
    stamp: Stamp,
    eol: &'static str,
    /// Set once creating or opening the file failed: the journal stays silent from then on.
    failed: bool,
}

/// Applies one entry to `doc`. An edit the document refuses (a read-only document) is skipped.
/// False when an undone/redone replacement does not fit the text: the replay must stop there.
pub fn apply(doc: &mut Doc, entry: &Entry) -> bool {
    match entry {
        Entry::Edit { start, end, text, kind } => { let _ = doc.edit(*start, *end, text, *kind); true }
        Entry::Undone(r) => doc.replay_undo_redo(true, r),
        Entry::Redone(r) => doc.replay_undo_redo(false, r),
    }
}

/// FNV-1a, 64 bit. Written inline so journal file names are stable across Rust versions.
fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for &b in bytes { hash ^= b as u64; hash = hash.wrapping_mul(0x100000001b3); }
    hash
}

impl Journal {
    /// `dir/<fnv1a64 of the absolute path, as 16 hex digits>.journal`. Creates nothing on disk yet.
    /// `eol` is the document's line ending (`Doc::eol`), written into the header.
    pub fn for_doc(dir: &Path, doc_path: &Path, stamp: Stamp, eol: &'static str) -> Journal {
        let doc_path = doc_path.to_string_lossy().into_owned();
        let file_path = dir.join(format!("{:016x}.journal", fnv1a64(doc_path.as_bytes())));
        Journal { file_path, file: None, doc_path, stamp, eol, failed: false }
    }

    /// Appends one line and flushes (no fsync). The first append creates the file and writes the
    /// header line first. The whole line goes out in a single write, so a crash tears at most the
    /// last line.
    pub fn append(&mut self, entry: &Entry) {
        if self.failed { return; }
        let Ok(mut line) = serde_json::to_string(entry) else { return };
        line.push('\n');
        if self.file.is_none() && !self.open() { self.failed = true; return; }
        if let Some(file) = self.file.as_mut() {
            if file.write_all(line.as_bytes()).and_then(|_| file.flush()).is_err() { self.failed = true; }
        }
    }

    /// Opens the file for appending, writing the header when the file is new. False on any error.
    fn open(&mut self) -> bool {
        if let Some(parent) = self.file_path.parent() {
            if std::fs::create_dir_all(parent).is_err() { return false; }
        }
        let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&self.file_path) else { return false };
        let is_new = file.metadata().map(|m| m.len() == 0).unwrap_or(false);
        if is_new {
            let header = Header { path: self.doc_path.clone(), size: self.stamp.size, mtime_ms: self.stamp.mtime_ms, eol: Some(self.eol.to_string()) };
            let Ok(mut line) = serde_json::to_string(&header) else { return false };
            line.push('\n');
            if file.write_all(line.as_bytes()).and_then(|_| file.flush()).is_err() { return false; }
        }
        self.file = Some(file);
        true
    }

    /// If a journal file exists and its header matches `doc_path` and `stamp`, applies every entry
    /// to `doc` and returns the number applied. Otherwise deletes the file and returns 0. A line
    /// that fails to parse (a torn last write, or an old-format undo/redo line) or a replacement
    /// that does not fit the text ends the replay; earlier entries stay applied and the rest is
    /// cut off so later appends start on a clean line.
    pub fn replay(&mut self, doc: &mut Doc) -> usize {
        let Ok(bytes) = std::fs::read(&self.file_path) else { return 0 };
        let mut lines = bytes.split_inclusive(|&b| b == b'\n');
        let header = lines.next().filter(|line| line.ends_with(b"\n"))
            .and_then(|line| serde_json::from_slice::<Header>(line).ok().map(|h| (line.len(), h)))
            .filter(|(_, h)| h.path == self.doc_path && h.size == self.stamp.size && h.mtime_ms == self.stamp.mtime_ms);
        let Some((header_len, header)) = header else { self.delete(); return 0 };
        if let Some(eol) = header.eol { doc.set_eol(&eol); }
        let (mut applied, mut good_len) = (0, header_len);
        for line in lines {
            if !line.ends_with(b"\n") { break; }
            let Ok(entry) = serde_json::from_slice::<Entry>(line) else { break };
            if !apply(doc, &entry) { break; }
            applied += 1;
            good_len += line.len();
        }
        if good_len < bytes.len() {
            if let Ok(file) = OpenOptions::new().write(true).open(&self.file_path) { let _ = file.set_len(good_len as u64); }
        }
        applied
    }

    /// After a save or reload: deletes the file and uses the new stamp (and the document's line
    /// ending, which a reload may have changed) from now on.
    pub fn restart(&mut self, stamp: Stamp, eol: &'static str) {
        self.delete();
        self.stamp = stamp;
        self.eol = eol;
    }

    pub fn delete(&mut self) {
        self.file = None;   // the handle must be closed before the file can be removed on Windows
        let _ = std::fs::remove_file(&self.file_path);
        self.failed = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    fn p(line: usize, col: usize) -> Pos { Pos { line, col } }
    fn typed(at: usize, text: &str) -> Entry { Entry::Edit { start: p(0, at), end: p(0, at), text: text.into(), kind: EditKind::Type } }
    fn count_files(dir: &Path) -> usize { std::fs::read_dir(dir).unwrap().count() }

    /// A replacement entry that is valid on any document (inserts `text` at the start).
    fn undone_insert(text: &str) -> Entry { Entry::Undone(Replacement { at: 0, removed: 0, text: text.into() }) }

    #[test]
    fn replay_restores_edits_undo_and_redo() {
        let t = TempDir::new(); let f = t.file("f.txt", b"ab"); let jd = t.dir("j");
        { let mut d = Doc::load(&f).unwrap(); let mut j = Journal::for_doc(&jd, &f, d.stamp().unwrap(), "
");
          for e in [typed(2, "c"), Entry::Edit { start: p(0,0), end: p(0,1), text: "".into(), kind: EditKind::Delete }] { assert!(apply(&mut d, &e)); j.append(&e); }
          let r = d.next_undo_redo(true).unwrap(); d.undo(); j.append(&Entry::Undone(r));
          let r = d.next_undo_redo(false).unwrap(); d.redo(); j.append(&Entry::Redone(r)); }   // dropped without save: the "crash"
        let mut d = Doc::load(&f).unwrap(); let mut j = Journal::for_doc(&jd, &f, d.stamp().unwrap(), "
");
        assert_eq!(j.replay(&mut d), 4); assert_eq!(d.whole(), "bc"); assert!(d.dirty());
        // the replayed undo/redo went through the history, so it still undoes step by step
        assert!(d.undo().is_some()); assert_eq!(d.whole(), "abc");
        assert!(d.undo().is_some()); assert_eq!(d.whole(), "ab");
        assert_eq!(d.undo(), None);
    }

    #[test]
    fn header_carries_the_line_ending_and_an_old_header_without_it_still_replays() {
        let t = TempDir::new(); let f = t.file("f.txt", b"ab"); let jd = t.dir("j");
        let stamp = Doc::load(&f).unwrap().stamp().unwrap();
        let mut j = Journal::for_doc(&jd, &f, stamp, "\r\n");
        j.append(&typed(2, "\n"));
        let mut d = Doc::load(&f).unwrap(); assert_eq!(d.eol(), "\n");
        assert_eq!(Journal::for_doc(&jd, &f, stamp, "\n").replay(&mut d), 1);
        assert_eq!(d.eol(), "\r\n"); assert_eq!(d.whole(), "ab\r\n");
        // a header written by the previous build has no eol: the detected ending is kept
        let old = format!("{}\n{}\n", serde_json::json!({"path": f.to_string_lossy(), "size": stamp.size, "mtime_ms": stamp.mtime_ms}), serde_json::to_string(&typed(2, "\n")).unwrap());
        std::fs::write(&j.file_path, old).unwrap();
        let mut d = Doc::load(&f).unwrap();
        assert_eq!(Journal::for_doc(&jd, &f, stamp, "\n").replay(&mut d), 1);
        assert_eq!(d.eol(), "\n"); assert_eq!(d.whole(), "ab\n");
    }

    #[test]
    fn undone_and_redone_wire_shape() {
        let r = Replacement { at: 3, removed: 2, text: "a\r\nb".into() };
        assert_eq!(serde_json::to_string(&Entry::Undone(r.clone())).unwrap(), r#"{"op":"undone","at":3,"removed":2,"text":"a\r\nb"}"#);
        assert_eq!(serde_json::to_string(&Entry::Redone(r)).unwrap(), r#"{"op":"redone","at":3,"removed":2,"text":"a\r\nb"}"#);
        assert!(serde_json::from_str::<Entry>(r#"{"op":"undo"}"#).is_err());
        assert!(serde_json::from_str::<Entry>(r#"{"op":"redo"}"#).is_err());
    }

    #[test]
    fn a_replacement_that_does_not_fit_ends_the_replay() {
        let t = TempDir::new(); let f = t.file("f.txt", b"ab"); let jd = t.dir("j");
        let mut j = Journal::for_doc(&jd, &f, Doc::load(&f).unwrap().stamp().unwrap(), "
");
        j.append(&typed(2, "c"));
        j.append(&Entry::Undone(Replacement { at: 2, removed: 5, text: "".into() }));   // past the end of "abc"
        j.append(&typed(0, "z"));
        let mut d = Doc::load(&f).unwrap(); let mut j2 = Journal::for_doc(&jd, &f, d.stamp().unwrap(), "
");
        assert_eq!(j2.replay(&mut d), 1); assert_eq!(d.whole(), "abc");
        assert_eq!(std::fs::read_to_string(&j2.file_path).unwrap().lines().count(), 2);   // header + the one good entry
    }

    #[test]
    fn a_replacement_that_is_not_the_next_history_step_clears_the_history() {
        let mut d = Doc::from_bytes(b"abc".to_vec());
        d.edit(p(0,3), p(0,3), "d", EditKind::Type).unwrap();
        assert!(d.replay_undo_redo(true, &Replacement { at: 0, removed: 1, text: "X".into() }));
        assert_eq!(d.whole(), "Xbcd"); assert_eq!(d.undo(), None); assert!(d.dirty());
    }

    #[test]
    fn journal_for_a_changed_file_is_ignored_and_deleted() {
        let t = TempDir::new(); let f = t.file("f.txt", b"ab"); let jd = t.dir("j");
        { let d = Doc::load(&f).unwrap(); let mut j = Journal::for_doc(&jd, &f, d.stamp().unwrap(), "
"); j.append(&undone_insert("x")); }
        std::fs::write(&f, b"different").unwrap();
        let mut d = Doc::load(&f).unwrap(); let mut j = Journal::for_doc(&jd, &f, d.stamp().unwrap(), "
");
        assert_eq!(j.replay(&mut d), 0); assert_eq!(count_files(&jd), 0);
        assert_eq!(d.whole(), "different"); assert!(!d.dirty());
    }

    #[test]
    fn no_file_until_first_append() {
        let t = TempDir::new(); let f = t.file("f.txt", b"a"); let jd = t.dir("j");
        let d = Doc::load(&f).unwrap(); let mut j = Journal::for_doc(&jd, &f, d.stamp().unwrap(), "
");
        assert_eq!(count_files(&jd), 0);
        j.append(&undone_insert("x"));
        assert_eq!(count_files(&jd), 1);
    }

    #[test]
    fn file_name_is_16_hex_digits_of_the_fnv1a_hash() {
        assert_eq!(fnv1a64(b""), 0xcbf29ce484222325);
        assert_eq!(fnv1a64(b"a"), 0xaf63dc4c8601ec8c);
        let t = TempDir::new(); let f = t.file("f.txt", b"a"); let jd = t.dir("j");
        let j = Journal::for_doc(&jd, &f, Stamp { size: 1, mtime_ms: 2 }, "
");
        let name = j.file_path.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(name.len(), "0123456789abcdef.journal".len());
        assert!(name.ends_with(".journal") && name[..16].bytes().all(|b| b.is_ascii_hexdigit()));
    }

    #[test]
    fn torn_last_line_keeps_earlier_entries() {
        let t = TempDir::new(); let f = t.file("f.txt", b"ab"); let jd = t.dir("j");
        let mut j = Journal::for_doc(&jd, &f, Doc::load(&f).unwrap().stamp().unwrap(), "
");
        j.append(&typed(2, "c"));
        std::fs::OpenOptions::new().append(true).open(&j.file_path).unwrap().write_all(br#"{"op":"ed"#).unwrap();
        let mut d = Doc::load(&f).unwrap(); let mut j2 = Journal::for_doc(&jd, &f, d.stamp().unwrap(), "
");
        assert_eq!(j2.replay(&mut d), 1); assert_eq!(d.whole(), "abc");
        // appending after the replay starts on a clean line, so the next replay sees both entries
        j2.append(&typed(3, "d"));
        let mut d = Doc::load(&f).unwrap(); let mut j3 = Journal::for_doc(&jd, &f, d.stamp().unwrap(), "
");
        assert_eq!(j3.replay(&mut d), 2); assert_eq!(d.whole(), "abcd");
    }

    #[test]
    fn restart_and_delete_remove_the_file() {
        let t = TempDir::new(); let f = t.file("f.txt", b"a"); let jd = t.dir("j");
        let mut j = Journal::for_doc(&jd, &f, Stamp { size: 1, mtime_ms: 1 }, "
");
        j.append(&undone_insert("x")); assert_eq!(count_files(&jd), 1);
        j.restart(Stamp { size: 2, mtime_ms: 2 }, "
"); assert_eq!(count_files(&jd), 0);
        j.append(&undone_insert("x")); assert_eq!(count_files(&jd), 1);
        j.delete(); assert_eq!(count_files(&jd), 0);
    }

    #[test]
    fn restart_uses_the_new_stamp_in_the_header() {
        let t = TempDir::new(); let f = t.file("f.txt", b"ab"); let jd = t.dir("j");
        let mut j = Journal::for_doc(&jd, &f, Stamp { size: 1, mtime_ms: 1 }, "
");
        let new = Doc::load(&f).unwrap().stamp().unwrap();
        j.restart(new, "
"); j.append(&typed(2, "c"));
        let mut d = Doc::load(&f).unwrap(); let mut j2 = Journal::for_doc(&jd, &f, new, "
");
        assert_eq!(j2.replay(&mut d), 1); assert_eq!(d.whole(), "abc");
    }

    #[test]
    fn missing_or_garbled_header_deletes_the_file() {
        let t = TempDir::new(); let f = t.file("f.txt", b"ab"); let jd = t.dir("j");
        let mut d = Doc::load(&f).unwrap(); let mut j = Journal::for_doc(&jd, &f, d.stamp().unwrap(), "
");
        std::fs::write(&j.file_path, b"not json\n{\"op\":\"undone\",\"at\":0,\"removed\":0,\"text\":\"x\"}\n").unwrap();
        assert_eq!(j.replay(&mut d), 0); assert_eq!(count_files(&jd), 0);
    }

    #[test]
    fn entries_with_newlines_stay_on_one_line_and_replay_in_order() {
        let t = TempDir::new(); let f = t.file("f.txt", b""); let jd = t.dir("j");
        let mut j = Journal::for_doc(&jd, &f, Doc::load(&f).unwrap().stamp().unwrap(), "
");
        j.append(&typed(0, "a\nb")); j.append(&Entry::Edit { start: p(1,1), end: p(1,1), text: "!".into(), kind: EditKind::Paste });
        assert_eq!(std::fs::read_to_string(&j.file_path).unwrap().lines().count(), 3);   // header + 2 entries
        let mut d = Doc::load(&f).unwrap(); let mut j2 = Journal::for_doc(&jd, &f, d.stamp().unwrap(), "
");
        assert_eq!(j2.replay(&mut d), 2); assert_eq!(d.whole(), "a\nb!");
    }

    #[test]
    fn an_unusable_journal_folder_is_silent() {
        let t = TempDir::new(); let f = t.file("f.txt", b"a"); let blocker = t.file("blocker", b"x");
        let mut j = Journal::for_doc(&blocker.join("sub"), &f, Stamp { size: 1, mtime_ms: 1 }, "
");
        j.append(&undone_insert("x")); j.append(&undone_insert("y"));
        let mut d = Doc::load(&f).unwrap();
        assert_eq!(j.replay(&mut d), 0); j.restart(Stamp { size: 1, mtime_ms: 1 }, "
"); j.delete();
    }
}
