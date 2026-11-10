//! The crash journal: every edit is appended to a small file so unsaved work survives a crash of
//! the engine. It is replayed when the same, unchanged file is opened again. It is best effort:
//! every I/O error is swallowed, and a journal that cannot be written simply stops journaling.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::disk::Stamp;
use crate::doc::{Doc, EditKind, Pos};

/// One journaled operation. One entry is always one physical line (JSON escapes newlines).
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Entry {
    Edit { start: Pos, end: Pos, text: String, kind: EditKind },
    Undo,
    Redo,
}

/// The first line of a journal file: which document, in which state, the entries apply to.
#[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
struct Header { path: String, size: u64, mtime_ms: u64 }

pub struct Journal {
    file_path: PathBuf,
    file: Option<File>,
    doc_path: String,
    stamp: Stamp,
    /// Set once creating or opening the file failed: the journal stays silent from then on.
    failed: bool,
}

/// Applies one entry to `doc`. An edit the document refuses (a read-only document) is skipped.
pub fn apply(doc: &mut Doc, entry: &Entry) {
    match entry {
        Entry::Edit { start, end, text, kind } => { let _ = doc.edit(*start, *end, text, *kind); }
        Entry::Undo => { doc.undo(); }
        Entry::Redo => { doc.redo(); }
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
    pub fn for_doc(dir: &Path, doc_path: &Path, stamp: Stamp) -> Journal {
        let doc_path = doc_path.to_string_lossy().into_owned();
        let file_path = dir.join(format!("{:016x}.journal", fnv1a64(doc_path.as_bytes())));
        Journal { file_path, file: None, doc_path, stamp, failed: false }
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
            let header = Header { path: self.doc_path.clone(), size: self.stamp.size, mtime_ms: self.stamp.mtime_ms };
            let Ok(mut line) = serde_json::to_string(&header) else { return false };
            line.push('\n');
            if file.write_all(line.as_bytes()).and_then(|_| file.flush()).is_err() { return false; }
        }
        self.file = Some(file);
        true
    }

    /// If a journal file exists and its header matches `doc_path` and `stamp`, applies every entry
    /// to `doc` and returns the number applied. Otherwise deletes the file and returns 0. A line
    /// that fails to parse (a torn last write) ends the replay; earlier entries stay applied and
    /// the torn tail is cut off so later appends start on a clean line.
    pub fn replay(&mut self, doc: &mut Doc) -> usize {
        let Ok(bytes) = std::fs::read(&self.file_path) else { return 0 };
        let mut lines = bytes.split_inclusive(|&b| b == b'\n');
        let expected = Header { path: self.doc_path.clone(), size: self.stamp.size, mtime_ms: self.stamp.mtime_ms };
        let header_len = match lines.next() {
            Some(line) if line.ends_with(b"\n") && serde_json::from_slice::<Header>(line).ok().as_ref() == Some(&expected) => line.len(),
            _ => { self.delete(); return 0; }
        };
        let (mut applied, mut good_len) = (0, header_len);
        for line in lines {
            if !line.ends_with(b"\n") { break; }
            let Ok(entry) = serde_json::from_slice::<Entry>(line) else { break };
            apply(doc, &entry);
            applied += 1;
            good_len += line.len();
        }
        if good_len < bytes.len() {
            if let Ok(file) = OpenOptions::new().write(true).open(&self.file_path) { let _ = file.set_len(good_len as u64); }
        }
        applied
    }

    /// After a save or reload: deletes the file and uses the new stamp from now on.
    pub fn restart(&mut self, stamp: Stamp) {
        self.delete();
        self.stamp = stamp;
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

    #[test]
    fn replay_restores_edits_undo_and_redo() {
        let t = TempDir::new(); let f = t.file("f.txt", b"ab"); let jd = t.dir("j");
        { let mut d = Doc::load(&f).unwrap(); let mut j = Journal::for_doc(&jd, &f, d.stamp().unwrap());
          for e in [typed(2, "c"), Entry::Edit { start: p(0,0), end: p(0,1), text: "".into(), kind: EditKind::Delete }, Entry::Undo, Entry::Redo] { apply(&mut d, &e); j.append(&e); } }   // dropped without save: the "crash"
        let mut d = Doc::load(&f).unwrap(); let mut j = Journal::for_doc(&jd, &f, d.stamp().unwrap());
        assert_eq!(j.replay(&mut d), 4); assert_eq!(d.whole(), "bc"); assert!(d.dirty());
    }

    #[test]
    fn journal_for_a_changed_file_is_ignored_and_deleted() {
        let t = TempDir::new(); let f = t.file("f.txt", b"ab"); let jd = t.dir("j");
        { let d = Doc::load(&f).unwrap(); let mut j = Journal::for_doc(&jd, &f, d.stamp().unwrap()); j.append(&Entry::Undo); }
        std::fs::write(&f, b"different").unwrap();
        let mut d = Doc::load(&f).unwrap(); let mut j = Journal::for_doc(&jd, &f, d.stamp().unwrap());
        assert_eq!(j.replay(&mut d), 0); assert_eq!(count_files(&jd), 0);
        assert_eq!(d.whole(), "different"); assert!(!d.dirty());
    }

    #[test]
    fn no_file_until_first_append() {
        let t = TempDir::new(); let f = t.file("f.txt", b"a"); let jd = t.dir("j");
        let d = Doc::load(&f).unwrap(); let mut j = Journal::for_doc(&jd, &f, d.stamp().unwrap());
        assert_eq!(count_files(&jd), 0);
        j.append(&Entry::Undo);
        assert_eq!(count_files(&jd), 1);
    }

    #[test]
    fn file_name_is_16_hex_digits_of_the_fnv1a_hash() {
        assert_eq!(fnv1a64(b""), 0xcbf29ce484222325);
        assert_eq!(fnv1a64(b"a"), 0xaf63dc4c8601ec8c);
        let t = TempDir::new(); let f = t.file("f.txt", b"a"); let jd = t.dir("j");
        let j = Journal::for_doc(&jd, &f, Stamp { size: 1, mtime_ms: 2 });
        let name = j.file_path.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(name.len(), "0123456789abcdef.journal".len());
        assert!(name.ends_with(".journal") && name[..16].bytes().all(|b| b.is_ascii_hexdigit()));
    }

    #[test]
    fn torn_last_line_keeps_earlier_entries() {
        let t = TempDir::new(); let f = t.file("f.txt", b"ab"); let jd = t.dir("j");
        let mut j = Journal::for_doc(&jd, &f, Doc::load(&f).unwrap().stamp().unwrap());
        j.append(&typed(2, "c"));
        std::fs::OpenOptions::new().append(true).open(&j.file_path).unwrap().write_all(br#"{"op":"ed"#).unwrap();
        let mut d = Doc::load(&f).unwrap(); let mut j2 = Journal::for_doc(&jd, &f, d.stamp().unwrap());
        assert_eq!(j2.replay(&mut d), 1); assert_eq!(d.whole(), "abc");
        // appending after the replay starts on a clean line, so the next replay sees both entries
        j2.append(&typed(3, "d"));
        let mut d = Doc::load(&f).unwrap(); let mut j3 = Journal::for_doc(&jd, &f, d.stamp().unwrap());
        assert_eq!(j3.replay(&mut d), 2); assert_eq!(d.whole(), "abcd");
    }

    #[test]
    fn restart_and_delete_remove_the_file() {
        let t = TempDir::new(); let f = t.file("f.txt", b"a"); let jd = t.dir("j");
        let mut j = Journal::for_doc(&jd, &f, Stamp { size: 1, mtime_ms: 1 });
        j.append(&Entry::Undo); assert_eq!(count_files(&jd), 1);
        j.restart(Stamp { size: 2, mtime_ms: 2 }); assert_eq!(count_files(&jd), 0);
        j.append(&Entry::Undo); assert_eq!(count_files(&jd), 1);
        j.delete(); assert_eq!(count_files(&jd), 0);
    }

    #[test]
    fn restart_uses_the_new_stamp_in_the_header() {
        let t = TempDir::new(); let f = t.file("f.txt", b"ab"); let jd = t.dir("j");
        let mut j = Journal::for_doc(&jd, &f, Stamp { size: 1, mtime_ms: 1 });
        let new = Doc::load(&f).unwrap().stamp().unwrap();
        j.restart(new); j.append(&typed(2, "c"));
        let mut d = Doc::load(&f).unwrap(); let mut j2 = Journal::for_doc(&jd, &f, new);
        assert_eq!(j2.replay(&mut d), 1); assert_eq!(d.whole(), "abc");
    }

    #[test]
    fn missing_or_garbled_header_deletes_the_file() {
        let t = TempDir::new(); let f = t.file("f.txt", b"ab"); let jd = t.dir("j");
        let mut d = Doc::load(&f).unwrap(); let mut j = Journal::for_doc(&jd, &f, d.stamp().unwrap());
        std::fs::write(&j.file_path, b"not json\n{\"op\":\"undo\"}\n").unwrap();
        assert_eq!(j.replay(&mut d), 0); assert_eq!(count_files(&jd), 0);
    }

    #[test]
    fn entries_with_newlines_stay_on_one_line_and_replay_in_order() {
        let t = TempDir::new(); let f = t.file("f.txt", b""); let jd = t.dir("j");
        let mut j = Journal::for_doc(&jd, &f, Doc::load(&f).unwrap().stamp().unwrap());
        j.append(&typed(0, "a\nb")); j.append(&Entry::Edit { start: p(1,1), end: p(1,1), text: "!".into(), kind: EditKind::Paste });
        assert_eq!(std::fs::read_to_string(&j.file_path).unwrap().lines().count(), 3);   // header + 2 entries
        let mut d = Doc::load(&f).unwrap(); let mut j2 = Journal::for_doc(&jd, &f, d.stamp().unwrap());
        assert_eq!(j2.replay(&mut d), 2); assert_eq!(d.whole(), "a\nb!");
    }

    #[test]
    fn an_unusable_journal_folder_is_silent() {
        let t = TempDir::new(); let f = t.file("f.txt", b"a"); let blocker = t.file("blocker", b"x");
        let mut j = Journal::for_doc(&blocker.join("sub"), &f, Stamp { size: 1, mtime_ms: 1 });
        j.append(&Entry::Undo); j.append(&Entry::Redo);
        let mut d = Doc::load(&f).unwrap();
        assert_eq!(j.replay(&mut d), 0); j.restart(Stamp { size: 1, mtime_ms: 1 }); j.delete();
    }
}
