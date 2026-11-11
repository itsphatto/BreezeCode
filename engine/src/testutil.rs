//! Test helpers shared by the test modules.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// A unique folder under the system temp dir, removed (with everything in it) on drop.
pub struct TempDir { dir: PathBuf }

impl TempDir {
    pub fn new() -> TempDir {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!("breeze-engine-test-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&dir).unwrap();
        TempDir { dir }
    }
    pub fn path(&self) -> &Path { &self.dir }
    /// Creates `name` inside the folder with `bytes` and returns its path.
    pub fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let p = self.dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }
    /// Creates the sub-folder `name` and returns its path.
    pub fn dir(&self, name: &str) -> PathBuf {
        let p = self.dir.join(name);
        std::fs::create_dir_all(&p).unwrap();
        p
    }
}

impl Drop for TempDir {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.dir); }
}
