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
pub fn write_atomic<'a>(path: &Path, bom: bool, chunks: impl Iterator<Item = &'a str>) -> Result<u64, String> {
    let tmp = temp_path(path);
    let file = File::create(&tmp).map_err(|e| e.to_string())?;
    match write_and_replace(file, &tmp, path, bom, chunks) {
        Ok(n) => Ok(n),
        Err(e) => { let _ = std::fs::remove_file(&tmp); Err(e) }
    }
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
