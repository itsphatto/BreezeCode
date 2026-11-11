//! Talking to the file system: the size-and-time stamp of a file, and the atomic write used by save.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// What a file looked like when we last read or wrote it. A different stamp means someone else
/// changed it.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Stamp { pub size: u64, pub mtime_ms: u64 }

pub fn stamp(path: &Path) -> std::io::Result<Stamp> {
    let meta = std::fs::metadata(path)?;
    let mtime_ms = meta.modified()?.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    Ok(Stamp { size: meta.len(), mtime_ms })
}

/// Writes `chunks` to `<path>.breeze-tmp-<pid>`, syncs, renames over `path`. Removes the temp file on any error.
/// The temp file sits beside the target because a rename across volumes is not atomic. On any
/// failure the original file is left exactly as it was. Returns the number of bytes written.
/// A `path` that is a symbolic link is written through: the temp file goes beside, and is renamed
/// over, the file the link resolves to, so the link stays a link.
pub fn write_atomic<'a>(path: &Path, bom: bool, chunks: impl Iterator<Item = &'a str>) -> Result<u64, String> {
    let target = resolve_link(path);
    let tmp = temp_path(&target);
    let file = File::create(&tmp).map_err(|e| e.to_string())?;
    match write_and_replace(file, &tmp, &target, bom, chunks) {
        Ok(n) => Ok(n),
        Err(e) => { let _ = std::fs::remove_file(&tmp); Err(e) }
    }
}

/// The file a symbolic link at `path` points to (fully resolved), or `path` itself when it is not
/// a link or the link cannot be resolved (a dangling link is replaced, like a missing file).
/// On Windows the resolved path is a `\\?\` verbatim path; `with_file_name` and `rename` take it.
fn resolve_link(path: &Path) -> PathBuf {
    let is_link = std::fs::symlink_metadata(path).map(|m| m.file_type().is_symlink()).unwrap_or(false);
    if !is_link { return path.to_path_buf(); }
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn temp_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(format!(".breeze-tmp-{}", std::process::id()));
    path.with_file_name(name)
}

fn write_and_replace<'a>(file: File, tmp: &Path, path: &Path, bom: bool, chunks: impl Iterator<Item = &'a str>) -> Result<u64, String> {
    let mut out = BufWriter::new(file);
    let mut written = 0u64;
    if bom { out.write_all(b"\xEF\xBB\xBF").map_err(|e| e.to_string())?; written += 3; }
    for chunk in chunks {
        out.write_all(chunk.as_bytes()).map_err(|e| e.to_string())?;
        written += chunk.len() as u64;
    }
    out.flush().map_err(|e| e.to_string())?;
    let file = out.into_inner().map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    #[cfg(unix)]
    if let Ok(meta) = std::fs::metadata(path) { let _ = file.set_permissions(meta.permissions()); }   // keep the original's mode
    drop(file);   // the handle must be closed before the rename
    std::fs::rename(tmp, path).map_err(|e| e.to_string())?;
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    fn files_in(dir: &Path) -> usize { std::fs::read_dir(dir).unwrap().count() }

    /// Creates a symbolic link to a file, or None when this machine does not allow it (on Windows
    /// that needs Developer Mode or the symlink privilege).
    fn file_link(target: &Path, link: &Path) -> Option<()> {
        #[cfg(windows)] let made = std::os::windows::fs::symlink_file(target, link);
        #[cfg(unix)] let made = std::os::unix::fs::symlink(target, link);
        match made {
            Ok(()) => Some(()),
            Err(e) => {
                // written straight to stderr so it shows in the cargo output, not only on failure
                let _ = writeln!(std::io::stderr(), "SKIPPED save_through_a_symlink: cannot create a symlink here ({e})");
                None
            }
        }
    }

    #[test]
    fn save_through_a_symlink_keeps_the_link_and_writes_the_target() {
        let t = TempDir::new(); let real = t.file("real.txt", b"old");
        let link = t.path().join("link.txt");
        if file_link(Path::new("real.txt"), &link).is_none() { return; }   // relative target: resolved from the link's folder
        assert_eq!(write_atomic(&link, false, ["new ", "text"].into_iter()).unwrap(), 8);
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink(), "the link was replaced by a file");
        assert_eq!(std::fs::read_link(&link).unwrap(), Path::new("real.txt"));
        assert_eq!(std::fs::read(&real).unwrap(), b"new text");
        assert_eq!(std::fs::read(&link).unwrap(), b"new text");
        assert_eq!(files_in(t.path()), 2);   // no temp file left beside either
        // and through Doc: the stamp follows the link, so our own save is not an outside change
        let mut d = crate::doc::Doc::load(&link).unwrap();
        d.edit(crate::doc::Pos { line: 0, col: 0 }, crate::doc::Pos { line: 0, col: 0 }, "!", crate::doc::EditKind::Type).unwrap();
        d.save().unwrap();
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read(&real).unwrap(), b"!new text");
        assert!(!d.changed_on_disk());
    }

    #[test]
    fn ordinary_save_lands_at_the_given_path() {
        let t = TempDir::new(); let f = t.file("f.txt", b"old");
        assert_eq!(write_atomic(&f, true, ["ab"].into_iter()).unwrap(), 5);
        assert!(!std::fs::symlink_metadata(&f).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read(&f).unwrap(), b"\xEF\xBB\xBFab");
        assert_eq!(files_in(t.path()), 1);
        let new = t.path().join("new.txt");   // a path that does not exist yet is created as given
        write_atomic(&new, false, ["x"].into_iter()).unwrap();
        assert_eq!(std::fs::read(&new).unwrap(), b"x");
        assert_eq!(files_in(t.path()), 2);
    }
}
