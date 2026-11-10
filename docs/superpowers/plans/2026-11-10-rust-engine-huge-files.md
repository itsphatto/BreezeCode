# Rust Document Engine, Piece 1 (Editable Files Above 50 MB) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Text files above 50 MB open in Breeze Code and are editable, backed by a Rust sidecar that owns the text.

**Architecture:** A Rust binary (`breeze-engine`) holds each open document in a rope and answers JSON-line requests on stdio. `src/main/engine.js` spawns it and matches replies; `doc:*` IPC handlers guard paths; a new line-and-column surface (`BigSurface`) in the renderer holds only the visible lines and edits optimistically.

**Tech Stack:** Rust 1.99 (`ropey`, `serde`, `serde_json`, `memchr`), Node 24 / Electron 44, TypeScript 7 (global-scope renderer files, no imports), `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-10-rust-engine-huge-files-design.md`. Read it before any task.

## Global Constraints

- Work on a branch named `feat/rust-engine`, not `main`. `main` has unrelated uncommitted changes: do not stage them.
- Only `\n` ends a line. Line count equals `text.split('\n').length`.
- Positions are `{ line, col }`, 0-based; `col` counts UTF-16 code units inside the line.
- A file above 2 GB (2 * 1024^3 bytes) is refused: "This file is larger than 2 GB".
- A line longer than 10,000 UTF-16 units is returned cut to 10,000, with its full length in `len`.
- `text` refuses a range above 100 MB (100 * 1024^2 bytes): "That selection is too large to copy".
- Undo history holds at most 256 MB of text; oldest steps are dropped beyond that.
- `count` stops at 9,999.
- Read-only edit error: "This file isn't valid UTF-8, so it can't be edited here".
- Missing executable error: "The Breeze engine isn't built. Run npm run build:engine".
- Renderer files share one global scope: no `import` / `export`. New renderer files are added to `tsconfig.json` `files` and to `src/renderer/breeze.html` script tags, in dependency order.
- Existing editing code for normal files is not changed beyond the branches this plan names.
- Error strings reach the user as written. No "Uh oh", no stack traces.
- The engine never panics on input from the page: every request is answered with `ok: true` or `ok: false`.

## Review Focus

Conditions the spec implies that are most likely to hurt a user. Each has a test in the task named.

1. **Out-of-range positions** (line past the end, `col` past the line, `col` inside a surrogate pair): clamp, never panic. A panic kills the engine and every open document. Task 2, Task 7.
2. **One enormous line** (a 60 MB minified JSON file with no newline): `lines` must answer without copying the whole line, and an edit inside the first 10,000 units must work. Task 1, Task 2.
3. **Typing faster than replies arrive**: a `lines` reply fetched before a local edit must not overwrite the edited text on screen. Task 10.
4. **Save while another program holds the file open** (Windows sharing violation on rename): error returned, temp file removed, original intact, edits still in memory and still `dirty`. Task 5.
5. **Tabs and non-ASCII text** (CJK, emoji, combining marks): the caret and a click land on the same character the engine edits. Task 11.

---

## File Structure

| File | Responsibility |
|---|---|
| `engine/Cargo.toml` | Crate manifest |
| `engine/src/lib.rs` | Re-exports modules so tests and `main.rs` share them |
| `engine/src/doc.rs` | `Doc`: rope, load, line windows, position conversion, edit |
| `engine/src/history.rs` | Undo and redo stacks, grouping, the 256 MB cap |
| `engine/src/search.rs` | `find`, `count` over rope chunks |
| `engine/src/disk.rs` | `Stamp`, atomic save, changed-on-disk check |
| `engine/src/journal.rs` | Crash journal: append, replay, delete |
| `engine/src/proto.rs` | `Engine::handle(&str) -> String`: parse a request line, dispatch, build the reply |
| `engine/src/main.rs` | Argument parsing and the stdin/stdout loop |
| `engine/tests/big.rs` | The 200 MB and single-line tests |
| `scripts/build-engine.js` | `cargo build --release`, copy the executable to `runtime/` |
| `src/main/engine.js` | Spawn, request ids, restart, `down` event |
| `src/main/main.js` | `doc:*` handlers (new section after the `fs:search` block) |
| `src/main/preload.js` | `api.doc.*` |
| `src/renderer/bigcore.ts` | Pure logic: line cache, optimistic edits, position maths |
| `src/renderer/bigsurface.ts` | `BigSurface`: DOM, input, selection, scrolling |
| `src/renderer/breeze/bigfile.ts` | Wires a `large` buffer into tabs, save, find, status, reload |
| `test/engine.test.js`, `test/bigcore.test.js` | Node tests |
| `test/harness/bigsurface.html` | Manual harness for the surface, like `test/harness/codeview.html` |

---

### Task 1: Engine crate, load and line windows

**Files:**
- Create: `engine/Cargo.toml`, `engine/src/lib.rs`, `engine/src/doc.rs`, `engine/src/main.rs` (a `fn main() {}` stub for now), `scripts/build-engine.js`
- Modify: `package.json` (scripts), `.gitignore`

**Interfaces:**
- Produces:
  ```rust
  // doc.rs
  #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
  pub struct Pos { pub line: usize, pub col: usize }
  #[derive(Debug, PartialEq, serde::Serialize)]
  pub struct LineItem { pub text: String, pub len: usize }
  pub const LONG_LINE: usize = 10_000;
  pub const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
  pub struct Doc { /* rope, path, eol, bom, read_only, bytes, rev, saved_rev, ... */ }
  impl Doc {
      pub fn load(path: &std::path::Path) -> Result<Doc, String>;
      pub fn from_bytes(bytes: Vec<u8>) -> Doc;          // no path; for tests
      pub fn line_count(&self) -> usize;
      pub fn lines(&self, first: usize, count: usize) -> Vec<LineItem>;
      pub fn eol(&self) -> &'static str;                 // "\n" or "\r\n"
      pub fn read_only(&self) -> bool;
      pub fn bytes(&self) -> u64;                        // size on disk at load
      pub fn rev(&self) -> u64;
      pub fn dirty(&self) -> bool;
      pub(crate) fn char_at(&self, pos: Pos) -> usize;   // clamped rope char index
      pub(crate) fn pos_at(&self, char_idx: usize) -> Pos;
  }
  ```
- `package.json` scripts: `"build:engine": "node scripts/build-engine.js"`, `"test:engine": "cargo test --release --manifest-path engine/Cargo.toml -- --include-ignored"`; `predist` becomes `node scripts/write-config.js && node scripts/build-engine.js`.

- [ ] **Step 1: Create the crate manifest**

```toml
[package]
name = "breeze-engine"
version = "0.1.0"
edition = "2021"

[dependencies]
ropey = { version = "1.6", default-features = false, features = ["simd"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
memchr = "2"

[profile.release]
opt-level = 3
lto = true
```

Check on docs.rs/ropey that with default features off, only `\n` is a line break. The `crlf_and_lone_cr` test below pins it either way.

- [ ] **Step 2: Write the failing tests** (in `doc.rs` under `#[cfg(test)]`)

```rust
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
```

- [ ] **Step 3: Run to verify failure**

Run: `cargo test --manifest-path engine/Cargo.toml`
Expected: compile errors for `Doc`.

- [ ] **Step 4: Implement `doc.rs`**

- `load`: `metadata` first; refuse above `MAX_BYTES`. Read with `std::fs::read`, then `from_bytes` plus path and stamp fields (stamp arrives in Task 5; leave a `path: Option<PathBuf>` now).
- `from_bytes`: strip a leading UTF-8 BOM and remember it. `String::from_utf8` success builds the rope; failure uses `from_utf8_lossy` and sets `read_only`.
- `eol`: `"\r\n"` if the rope contains `"\r\n"` anywhere (scan chunks with `memchr::memmem`, carrying one byte across chunk edges), else `"\n"`. Compute once at load.
- `lines`: for each line, take the rope line slice, drop a trailing `\n` then a trailing `\r`. `len` is the slice's UTF-16 length (`len_utf16_cu`). When `len > LONG_LINE`, take the chars up to UTF-16 unit `LONG_LINE` (`utf16_cu_to_char`), which rounds down at a surrogate pair. Never materialise the whole line.
- `char_at`: clamp `line` to the last line; clamp `col` to that line's `len` (without its terminator); convert with `utf16_cu_to_char` on the line slice.

- [ ] **Step 5: Run tests**

Run: `cargo test --manifest-path engine/Cargo.toml`
Expected: all pass.

- [ ] **Step 6: Write `scripts/build-engine.js`**

Runs `cargo build --release --manifest-path engine/Cargo.toml` with `stdio: 'inherit'`, then copies `engine/target/release/breeze-engine(.exe)` to `runtime/`. Exits non-zero with "Rust isn't installed. Get it from https://rustup.rs" when `cargo` is not found. Add the scripts to `package.json`; add `engine/target/` and `runtime/breeze-engine.exe` to `.gitignore`.

- [ ] **Step 7: Verify the build**

Run: `npm run build:engine`
Expected: `runtime/breeze-engine.exe` exists.

- [ ] **Step 8: Commit**

```bash
git add engine scripts/build-engine.js package.json .gitignore
git commit -m "feat(engine): Rust document engine crate with load and line windows"
```

---

### Task 2: Edit

**Files:**
- Modify: `engine/src/doc.rs`

**Interfaces:**
- Produces:
  ```rust
  #[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
  #[serde(rename_all = "lowercase")]
  pub enum EditKind { Type, Delete, Paste, Other }
  pub const READ_ONLY_MSG: &str = "This file isn't valid UTF-8, so it can't be edited here";
  impl Doc {
      /// Replaces start..end with `text`. Returns the caret: the position just after the inserted text.
      pub fn edit(&mut self, start: Pos, end: Pos, text: &str, kind: EditKind) -> Result<Pos, String>;
      /// The same replacement by rope char index, with no history entry. Returns the removed text.
      pub(crate) fn splice(&mut self, from: usize, to: usize, text: &str) -> String;
      pub fn whole(&self) -> String;   // tests only: the full text
  }
  ```
- `edit` bumps `rev` by one. `dirty()` is `rev != saved_rev`.
- Incoming `text` uses `\n`. `edit` removes every `\r` from it, then replaces each `\n` with `self.eol()`.
- `end` before `start` is swapped, not an error.

- [ ] **Step 1: Write the failing tests**

```rust
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
```

- [ ] **Step 2: Run to verify failure** — `cargo test --manifest-path engine/Cargo.toml`; expected: `edit` not found.

- [ ] **Step 3: Implement `edit`, `splice`, `whole`**

`edit` on a position at the end of a CRLF line removes the whole `\r\n` when the range reaches the next line start: `char_at` already places `{line, col: len}` before the `\r`, so no special case is needed. History is added in Task 3; leave the call site obvious.

- [ ] **Step 4: Run tests** — expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add engine/src/doc.rs
git commit -m "feat(engine): positional edits with UTF-16 columns and kept line endings"
```

---

### Task 3: Undo and redo

**Files:**
- Create: `engine/src/history.rs`
- Modify: `engine/src/doc.rs` (record in `edit`; add `undo`, `redo`), `engine/src/lib.rs`

**Interfaces:**
- Consumes: `Doc::splice`, `Doc::pos_at`.
- Produces:
  ```rust
  // history.rs
  pub const UNDO_CAP_BYTES: usize = 256 * 1024 * 1024;
  pub struct Step { pub at: usize, pub removed: String, pub inserted: String, pub kind: EditKind }  // `at` is a rope char index
  pub struct History { /* undo: VecDeque<Step>, redo: Vec<Step>, bytes: usize */ }
  impl History {
      pub fn record(&mut self, step: Step);   // joins the last step or pushes; clears redo; enforces the cap
      pub fn pop_undo(&mut self) -> Option<Step>;
      pub fn push_redo(&mut self, step: Step);
      pub fn pop_redo(&mut self) -> Option<Step>;
      pub fn push_undo(&mut self, step: Step);   // from redo: does not clear redo
      pub fn clear(&mut self);
  }
  // doc.rs
  impl Doc {
      pub fn undo(&mut self) -> Option<Pos>;   // caret after the restored text; None when nothing to undo
      pub fn redo(&mut self) -> Option<Pos>;
  }
  ```
- Join rule: same `kind`, `kind` is `Type` or `Delete`, neither step's `removed` or `inserted` contains `\n`, and the new step starts where the last one's inserted text ended (`Type`) or ends where the last one started or starts at the same place (`Delete`: Backspace and Delete key).
- `undo` and `redo` bump `rev`. Undoing back to the saved state does not clear `dirty` (it compares revisions).

- [ ] **Step 1: Write the failing tests**

```rust
fn ty(d: &mut Doc, line: usize, col: usize, s: &str) { d.edit(p(line,col), p(line,col), s, EditKind::Type).unwrap(); }
#[test] fn typed_word_is_one_step() { let mut d = doc(""); ty(&mut d,0,0,"a"); ty(&mut d,0,1,"b"); ty(&mut d,0,2,"c"); assert_eq!(d.undo(), Some(p(0,0))); assert_eq!(d.whole(), ""); assert_eq!(d.undo(), None); }
#[test] fn newline_breaks_the_group() { let mut d = doc(""); ty(&mut d,0,0,"a"); ty(&mut d,0,1,"\n"); ty(&mut d,1,0,"b"); d.undo(); assert_eq!(d.whole(), "a\n"); d.undo(); assert_eq!(d.whole(), "a"); }
#[test] fn typing_elsewhere_breaks_the_group() { let mut d = doc("xy"); ty(&mut d,0,0,"a"); ty(&mut d,0,3,"b"); d.undo(); assert_eq!(d.whole(), "axy"); }
#[test] fn backspaces_group() { let mut d = doc("abc"); d.edit(p(0,2),p(0,3),"",EditKind::Delete).unwrap(); d.edit(p(0,1),p(0,2),"",EditKind::Delete).unwrap(); assert_eq!(d.undo(), Some(p(0,3))); assert_eq!(d.whole(), "abc"); }
#[test] fn paste_never_groups() { let mut d = doc(""); d.edit(p(0,0),p(0,0),"a",EditKind::Paste).unwrap(); d.edit(p(0,1),p(0,1),"b",EditKind::Paste).unwrap(); d.undo(); assert_eq!(d.whole(), "a"); }
#[test] fn redo_restores_and_new_edit_clears_it() { let mut d = doc(""); ty(&mut d,0,0,"a"); d.undo(); assert_eq!(d.redo(), Some(p(0,1))); assert_eq!(d.whole(), "a"); d.undo(); ty(&mut d,0,0,"z"); assert_eq!(d.redo(), None); }
#[test] fn undo_replace_restores_removed_text() { let mut d = doc("hello"); d.edit(p(0,0),p(0,5),"x",EditKind::Other).unwrap(); d.undo(); assert_eq!(d.whole(), "hello"); }
#[test] fn cap_drops_oldest() {   // history.rs test, with a small cap passed to a test constructor
    let mut h = History::with_cap(10);
    for i in 0..5 { h.record(Step { at: i * 100, removed: String::new(), inserted: "abcd".into(), kind: EditKind::Paste }); }
    let mut n = 0; while h.pop_undo().is_some() { n += 1; } assert_eq!(n, 2);
}
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** `History::with_cap(usize)` is the constructor; `Default` uses `UNDO_CAP_BYTES`.
- [ ] **Step 4: Run tests** — expected: all pass.
- [ ] **Step 5: Commit**

```bash
git add engine/src
git commit -m "feat(engine): undo and redo with grouped typing"
```

---

### Task 4: Find, count and range text

**Files:**
- Create: `engine/src/search.rs`
- Modify: `engine/src/doc.rs`, `engine/src/lib.rs`

**Interfaces:**
- Produces:
  ```rust
  #[derive(Debug, PartialEq, serde::Serialize)]
  pub struct Hit { pub line: usize, pub col: usize, pub len: usize }   // len in UTF-16 units
  pub const COUNT_CAP: usize = 9_999;
  pub const TEXT_CAP_BYTES: usize = 100 * 1024 * 1024;
  pub const TEXT_CAP_MSG: &str = "That selection is too large to copy";
  impl Doc {
      /// Forward: the first hit starting at or after `from`, else the first hit in the file (wrap).
      /// Backward: the last hit starting before `from`, else the last hit in the file.
      pub fn find(&self, query: &str, match_case: bool, from: Pos, backward: bool) -> Option<Hit>;
      pub fn count(&self, query: &str, match_case: bool) -> (usize, bool);   // (count, capped)
      pub fn text(&self, start: Pos, end: Pos) -> Result<String, String>;    // line endings returned as "\n"
  }
  ```
- Case-insensitive matching folds ASCII letters only. Non-ASCII characters match exactly.
- An empty query finds nothing: `None` and `(0, false)`.
- Hits do not overlap (searching `aa` in `aaaa` counts 2), matching the editor's `indexOf` loop.

- [ ] **Step 1: Write the failing tests**

```rust
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
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement `search.rs`**

One function does all the scanning:

```rust
/// Calls `on_hit(byte_offset)` for each non-overlapping match in byte range `from..to`; stop when it returns false.
pub fn scan(rope: &ropey::Rope, needle: &[u8], match_case: bool, from: usize, to: usize, on_hit: &mut dyn FnMut(usize) -> bool);
```

Walk `rope.chunks_at_byte(from)`. Keep a carry buffer of the last `needle.len() - 1` bytes of the previous chunk, so a match across an edge is found in `carry + chunk prefix`. Case-sensitive uses `memchr::memmem::Finder`. Case-insensitive lowercases the needle's ASCII once and compares windows with `eq_ignore_ascii_case`, using `memchr2` on the first byte's two cases to skip ahead.

`find` forward: `scan(from..end)` first hit, else `scan(0..from)` first hit. Backward: `scan(0..from)` keeping the last hit, else `scan(from..end)` keeping the last. Convert the byte offset to `Pos` with `byte_to_char` then `pos_at`.

- [ ] **Step 4: Run tests** — expected: all pass.
- [ ] **Step 5: Commit**

```bash
git add engine/src
git commit -m "feat(engine): find, count and range text over rope chunks"
```

---

### Task 5: Save, disk stamp, reload

**Files:**
- Create: `engine/src/disk.rs`
- Modify: `engine/src/doc.rs`, `engine/src/lib.rs`

**Interfaces:**
- Produces:
  ```rust
  // disk.rs
  #[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
  pub struct Stamp { pub size: u64, pub mtime_ms: u64 }
  pub fn stamp(path: &Path) -> std::io::Result<Stamp>;
  /// Writes `chunks` to `<path>.breeze-tmp-<pid>`, syncs, renames over `path`. Removes the temp file on any error.
  pub fn write_atomic<'a>(path: &Path, bom: bool, chunks: impl Iterator<Item = &'a str>) -> Result<u64, String>;   // bytes written
  // doc.rs
  impl Doc {
      pub fn save(&mut self) -> Result<u64, String>;   // sets saved_rev = rev, refreshes the stamp and `bytes`
      pub fn changed_on_disk(&self) -> bool;           // stamp differs, or the file is gone
      pub fn reload(&mut self) -> Result<(), String>;  // re-reads; clears history; rev += 1; saved_rev = rev
      pub fn stamp(&self) -> Option<Stamp>;
      pub fn path(&self) -> Option<&Path>;
  }
  ```
- `save` on a read-only document fails with `READ_ONLY_MSG`. `save` on a `from_bytes` document (no path) fails with "This file has no path".
- Error text for a failed write or rename is the OS error's `to_string()`.

- [ ] **Step 1: Write the failing tests** (use a helper that makes a unique folder under `std::env::temp_dir()` and removes it on drop)

```rust
#[test] fn unedited_round_trip_is_byte_identical() {   // CRLF, mixed endings, BOM, no trailing newline
    for bytes in [&b"a\r\nb\nc"[..], b"\xEF\xBB\xBFx\r\n", b"", b"one line"] {
        let t = TempDir::new(); let f = t.file("f.txt", bytes);
        let mut d = Doc::load(&f).unwrap(); d.save().unwrap();
        assert_eq!(std::fs::read(&f).unwrap(), bytes);
    }
}
#[test] fn edits_land_and_dirty_clears() { let t = TempDir::new(); let f = t.file("f.txt", b"ab"); let mut d = Doc::load(&f).unwrap(); d.edit(p(0,2),p(0,2),"c",EditKind::Type).unwrap(); assert!(d.dirty()); assert_eq!(d.save().unwrap(), 3); assert!(!d.dirty()); assert_eq!(std::fs::read(&f).unwrap(), b"abc"); assert!(!d.changed_on_disk()); }
#[test] fn no_temp_file_left_behind() { let t = TempDir::new(); let f = t.file("f.txt", b"a"); Doc::load(&f).unwrap().save().unwrap(); assert_eq!(std::fs::read_dir(t.path()).unwrap().count(), 1); }
#[test] fn external_change_is_seen_and_reload_takes_it() { let t = TempDir::new(); let f = t.file("f.txt", b"a"); let mut d = Doc::load(&f).unwrap(); std::fs::write(&f, b"longer").unwrap(); assert!(d.changed_on_disk()); d.reload().unwrap(); assert_eq!(d.whole(), "longer"); assert!(!d.dirty()); assert_eq!(d.undo(), None); }
#[test] fn deleted_file_counts_as_changed() { let t = TempDir::new(); let f = t.file("f.txt", b"a"); let d = Doc::load(&f).unwrap(); std::fs::remove_file(&f).unwrap(); assert!(d.changed_on_disk()); }
#[test] fn read_only_cannot_save() { let t = TempDir::new(); let f = t.file("f.bin", &[0xFF]); assert_eq!(Doc::load(&f).unwrap().save().unwrap_err(), READ_ONLY_MSG); }
#[cfg(windows)]
#[test] fn locked_file_fails_cleanly() {   // Review Focus 4
    use std::os::windows::fs::OpenOptionsExt;
    let t = TempDir::new(); let f = t.file("f.txt", b"old");
    let mut d = Doc::load(&f).unwrap(); d.edit(p(0,3),p(0,3),"!",EditKind::Type).unwrap();
    let _held = std::fs::OpenOptions::new().read(true).share_mode(0).open(&f).unwrap();   // no sharing: rename over it must fail
    assert!(d.save().is_err());
    assert!(d.dirty()); assert_eq!(d.whole(), "old!");
    assert_eq!(std::fs::read_dir(t.path()).unwrap().count(), 1);   // temp file removed
    drop(_held); assert_eq!(std::fs::read(&f).unwrap(), b"old");
}
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** `save` passes `self.rope.chunks()` to `write_atomic`. `std::fs::rename` replaces an existing file on Windows.
- [ ] **Step 4: Run tests** — expected: all pass.
- [ ] **Step 5: Commit**

```bash
git add engine/src
git commit -m "feat(engine): atomic save, changed-on-disk check and reload"
```

---

### Task 6: Crash journal

**Files:**
- Create: `engine/src/journal.rs`
- Modify: `engine/src/lib.rs`

**Interfaces:**
- Consumes: `Doc`, `Pos`, `EditKind`, `Stamp`.
- Produces:
  ```rust
  #[derive(serde::Serialize, serde::Deserialize)]
  #[serde(tag = "op", rename_all = "lowercase")]
  pub enum Entry { Edit { start: Pos, end: Pos, text: String, kind: EditKind }, Undo, Redo }
  pub struct Journal { /* file path, Option<File>, path of the document, stamp */ }
  impl Journal {
      /// `dir/<fnv1a64 of the absolute path, as 16 hex digits>.journal`. Creates nothing on disk yet.
      pub fn for_doc(dir: &Path, doc_path: &Path, stamp: Stamp) -> Journal;
      /// Appends one line and flushes (no fsync). The first append creates the file and writes the header line first.
      pub fn append(&mut self, entry: &Entry);
      /// If a journal file exists and its header matches `doc_path` and `stamp`, applies every entry to `doc`
      /// and returns the number applied. Otherwise deletes the file and returns 0. A line that fails to parse
      /// (a torn last write) ends the replay; earlier entries stay applied.
      pub fn replay(&mut self, doc: &mut Doc) -> usize;
      pub fn restart(&mut self, stamp: Stamp);   // after save or reload: delete the file, use the new stamp
      pub fn delete(&mut self);
  }
  ```
- Header line: `{"path":"<absolute path>","size":<u64>,"mtime_ms":<u64>}`.
- Journal I/O errors are swallowed (the journal is best effort and must never fail an edit).
- After a replay the journal keeps appending to the same file.

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn replay_restores_edits_undo_and_redo() {
    let t = TempDir::new(); let f = t.file("f.txt", b"ab"); let jd = t.dir("j");
    { let mut d = Doc::load(&f).unwrap(); let mut j = Journal::for_doc(&jd, &f, d.stamp().unwrap());
      for e in [Entry::Edit { start: p(0,2), end: p(0,2), text: "c".into(), kind: EditKind::Type }, Entry::Edit { start: p(0,0), end: p(0,1), text: "".into(), kind: EditKind::Delete }, Entry::Undo, Entry::Redo] { apply(&mut d, &e); j.append(&e); } }   // dropped without save: the "crash"
    let mut d = Doc::load(&f).unwrap(); let mut j = Journal::for_doc(&jd, &f, d.stamp().unwrap());
    assert_eq!(j.replay(&mut d), 4); assert_eq!(d.whole(), "bc"); assert!(d.dirty());
}
#[test] fn journal_for_a_changed_file_is_ignored_and_deleted() {
    let t = TempDir::new(); let f = t.file("f.txt", b"ab"); let jd = t.dir("j");
    { let d = Doc::load(&f).unwrap(); let mut j = Journal::for_doc(&jd, &f, d.stamp().unwrap()); j.append(&Entry::Undo); }
    std::fs::write(&f, b"different").unwrap();
    let mut d = Doc::load(&f).unwrap(); let mut j = Journal::for_doc(&jd, &f, d.stamp().unwrap());
    assert_eq!(j.replay(&mut d), 0); assert_eq!(std::fs::read_dir(&jd).unwrap().count(), 0);
}
#[test] fn no_file_until_first_append() { let t = TempDir::new(); let f = t.file("f.txt", b"a"); let jd = t.dir("j"); let d = Doc::load(&f).unwrap(); let _j = Journal::for_doc(&jd, &f, d.stamp().unwrap()); assert_eq!(std::fs::read_dir(&jd).unwrap().count(), 0); }
#[test] fn torn_last_line_keeps_earlier_entries() { /* append one Edit, then append the raw bytes `{"op":"ed` to the file; replay returns 1 */ }
#[test] fn restart_and_delete_remove_the_file() { /* append, restart(new stamp) -> dir empty; append, delete -> dir empty */ }
```

`apply(doc, entry)` is a `pub fn apply(doc: &mut Doc, entry: &Entry)` in `journal.rs` that calls `edit`, `undo` or `redo`; `replay` uses it.

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** FNV-1a 64 is written inline (offset basis `0xcbf29ce484222325`, prime `0x100000001b3`) so the file name is stable across Rust versions.
- [ ] **Step 4: Run tests** — expected: all pass.
- [ ] **Step 5: Commit**

```bash
git add engine/src
git commit -m "feat(engine): crash journal with replay"
```

---

### Task 7: Protocol and the stdio loop

**Files:**
- Create: `engine/src/proto.rs`, `engine/tests/big.rs`
- Modify: `engine/src/main.rs`, `engine/src/lib.rs`

**Interfaces:**
- Consumes: everything in Tasks 1 to 6.
- Produces:
  ```rust
  pub struct Engine { /* docs: HashMap<u32, (Doc, Option<Journal>)>, next_id: u32, journal_dir: Option<PathBuf> */ }
  impl Engine {
      pub fn new(journal_dir: Option<PathBuf>) -> Engine;
      /// One request line in, one reply line out (no trailing newline). Never panics.
      pub fn handle(&mut self, line: &str) -> String;
  }
  ```
- `main.rs`: parses `--journal-dir <path>` (creates the folder), then reads stdin line by line, writes `handle(line)` plus `\n` to stdout and flushes after each. Exits 0 on stdin EOF.
- Wire format, exactly as the spec's table. Field names: `id`, `op`, `doc`, `path`, `first`, `count`, `start`, `end`, `text`, `kind`, `query`, `matchCase`, `from`, `backward`.
- Reply fields: always `id` and `ok`. On failure `error`. Document replies add `rev`, `lines`, `dirty`. Per op:
  - `open`, `reload`: `doc`, `bytes`, `eol`, `readOnly`, `recovered`
  - `lines`: `items`
  - `edit`: `caret`
  - `undo`, `redo`: `caret`, or `none: true` when there is nothing to do
  - `text`: `text`
  - `find`: `hit` (object or `null`)
  - `count`: `count`, `capped`
  - `save`: `bytes`
  - `changed`: `changed`
  - `close`: nothing extra
- `recovered` is true when `replay` applied at least one entry.
- `edit`, `undo`, `redo` append to the journal. `save` and `reload` call `restart`. `close` calls `delete`.
- Unknown `doc`: `"error": "That file isn't open"`. Unparseable line or unknown `op`: `"error": "Bad request"` with `id` copied when it could be read, else `id: null`.
- `handle` wraps dispatch in `std::panic::catch_unwind` and answers `"error": "The engine hit an internal error"`.

- [ ] **Step 1: Write the failing tests** (in `proto.rs`; `fn call(e: &mut Engine, v: serde_json::Value) -> serde_json::Value` serialises, calls `handle`, parses)

```rust
#[test] fn open_lines_edit_save_close() {
    let t = TempDir::new(); let f = t.file("f.txt", b"ab\ncd"); let mut e = Engine::new(None);
    let o = call(&mut e, json!({"id":1,"op":"open","path":f}));
    assert_eq!(o, json!({"id":1,"ok":true,"doc":1,"bytes":5,"eol":"\n","readOnly":false,"recovered":false,"rev":0,"lines":2,"dirty":false}));
    assert_eq!(call(&mut e, json!({"id":2,"op":"lines","doc":1,"first":1,"count":5}))["items"], json!([{"text":"cd","len":2}]));
    let r = call(&mut e, json!({"id":3,"op":"edit","doc":1,"start":{"line":0,"col":2},"end":{"line":0,"col":2},"text":"!","kind":"type"}));
    assert_eq!(r, json!({"id":3,"ok":true,"caret":{"line":0,"col":3},"rev":1,"lines":2,"dirty":true}));
    assert_eq!(call(&mut e, json!({"id":4,"op":"save","doc":1}))["dirty"], json!(false));
    assert_eq!(call(&mut e, json!({"id":5,"op":"close","doc":1}))["ok"], json!(true));
    assert_eq!(call(&mut e, json!({"id":6,"op":"lines","doc":1,"first":0,"count":1})), json!({"id":6,"ok":false,"error":"That file isn't open"}));
}
#[test] fn undo_with_nothing_to_undo() { /* open, undo -> {"none":true, ...}, ok true */ }
#[test] fn find_and_count_shapes() { /* hit object with line/col/len; "hit": null when absent; count + capped */ }
#[test] fn bad_requests_do_not_panic() {
    let mut e = Engine::new(None);
    assert_eq!(e.handle("not json"), r#"{"id":null,"ok":false,"error":"Bad request"}"#);
    assert_eq!(call(&mut e, json!({"id":9,"op":"nope"})), json!({"id":9,"ok":false,"error":"Bad request"}));
    assert_eq!(call(&mut e, json!({"id":9,"op":"lines","doc":1}))["ok"], json!(false));   // missing fields
}
#[test] fn wild_positions_do_not_panic() {   // Review Focus 1
    let t = TempDir::new(); let f = t.file("f.txt", "a😀\n".as_bytes()); let mut e = Engine::new(None);
    call(&mut e, json!({"id":1,"op":"open","path":f}));
    for (l, c) in [(u32::MAX as u64, 0u64), (0, u32::MAX as u64), (0, 2), (5, 5)] {
        assert_eq!(call(&mut e, json!({"id":2,"op":"edit","doc":1,"start":{"line":l,"col":c},"end":{"line":l,"col":c},"text":"x","kind":"type"}))["ok"], json!(true));
        assert_eq!(call(&mut e, json!({"id":3,"op":"lines","doc":1,"first":l,"count":u32::MAX}))["ok"], json!(true));
    }
}
#[test] fn crash_then_open_recovers() {
    let t = TempDir::new(); let f = t.file("f.txt", b"ab"); let jd = t.dir("j");
    { let mut e = Engine::new(Some(jd.clone())); call(&mut e, json!({"id":1,"op":"open","path":f})); call(&mut e, json!({"id":2,"op":"edit","doc":1,"start":{"line":0,"col":0},"end":{"line":0,"col":0},"text":"X","kind":"type"})); }
    let mut e = Engine::new(Some(jd)); let o = call(&mut e, json!({"id":1,"op":"open","path":f}));
    assert_eq!(o["recovered"], json!(true)); assert_eq!(o["dirty"], json!(true));
    assert_eq!(call(&mut e, json!({"id":2,"op":"lines","doc":1,"first":0,"count":1}))["items"][0]["text"], json!("Xab"));
}
#[test] fn close_deletes_the_journal_and_save_restarts_it() { /* after edit: 1 file in jd; after save: 0; edit again: 1; close: 0 */ }
#[test] fn too_large_is_refused() { /* unit-test the size check with a helper `check_size(u64) -> Result<(), String>`: check_size(MAX_BYTES + 1) == Err("This file is larger than 2 GB") */ }
```

`engine/tests/big.rs` (both `#[ignore]`, run by `npm run test:engine`):

```rust
#[test] #[ignore] fn two_hundred_megabytes() {
    // Write 200 MB of lines "line 0000000\n"… to a temp file. Through Engine::handle:
    // open (assert lines == count + 1), read the last 50 lines, edit line 0 and the last text line,
    // save, drop the engine, open again, assert both edits are present and the rest is untouched
    // (compare three sampled windows against the generator).
}
#[test] #[ignore] fn sixty_megabyte_single_line() {   // Review Focus 2
    // One 60 MB line of 'x', no newline. open: lines == 1. `lines` returns text of 10,000 units and len 60 MB,
    // in under 200 ms (std::time::Instant). Edit at col 5 succeeds; `lines` then starts with "xxxxxY".
}
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement `proto.rs` and `main.rs`.** Parse each line into `serde_json::Value` first to read `id` and `op`, then deserialize the arguments per op into small private structs with `#[serde(rename_all = "camelCase")]`.
- [ ] **Step 4: Run all engine tests**

Run: `npm run test:engine`
Expected: all pass, including the two ignored tests.

- [ ] **Step 5: Smoke-test the binary by hand**

Run: `npm run build:engine`, then pipe one line into it:

```bash
echo '{"id":1,"op":"open","path":"package.json"}' | runtime/breeze-engine.exe
```

Expected: one line starting `{"id":1,"ok":true,"doc":1,`.

- [ ] **Step 6: Commit**

```bash
git add engine
git commit -m "feat(engine): JSON-line protocol, stdio loop and large-file tests"
```

---

### Task 8: `src/main/engine.js`

**Files:**
- Create: `src/main/engine.js`, `test/engine.test.js`

**Interfaces:**
- Consumes: the executable and wire format from Task 7.
- Produces:
  ```js
  const { EventEmitter } = require('node:events');
  class Engine extends EventEmitter {
    constructor({ exe, journalDir })        // nothing is spawned yet
    request(op, args = {})                  // Promise<object>: the reply without `id` and `ok`; rejects with Error(reply.error)
    stop()                                  // kills the process; pending requests reject with Error('The engine stopped')
    get running()                           // boolean
  }
  const NOT_BUILT = "The Breeze engine isn't built. Run npm run build:engine";
  module.exports = { Engine, NOT_BUILT };
  ```
- Emits `'down'` once each time the process exits for any reason other than `stop()`.
- `request` spawns on demand: `spawn(exe, ['--journal-dir', journalDir], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })`. A missing `exe` (checked with `fs.existsSync` before spawn, and on a spawn `ENOENT`) rejects with `Error(NOT_BUILT)`.
- stdout is split on `\n` with a carry buffer, the way `kernel.js` does. stderr is kept (last 2,000 characters) and appended to nothing: it is for a debugger only.
- A reply line that isn't JSON is ignored.

- [ ] **Step 1: Write the failing test** (`test/engine.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Engine, NOT_BUILT } = require('../src/main/engine.js');
const exe = path.join(__dirname, '..', 'runtime', process.platform === 'win32' ? 'breeze-engine.exe' : 'breeze-engine');
const skip = fs.existsSync(exe) ? false : 'engine not built: run npm run build:engine';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-engine-'));

test('open, lines, edit, save, close through the real engine', { skip }, async () => {
  const dir = tmp(), file = path.join(dir, 'f.txt'); fs.writeFileSync(file, 'ab\ncd');
  const e = new Engine({ exe, journalDir: path.join(dir, 'j') });
  const o = await e.request('open', { path: file });
  assert.deepEqual({ lines: o.lines, bytes: o.bytes, eol: o.eol, dirty: o.dirty }, { lines: 2, bytes: 5, eol: '\n', dirty: false });
  assert.deepEqual((await e.request('lines', { doc: o.doc, first: 0, count: 9 })).items.map(l => l.text), ['ab', 'cd']);
  const r = await e.request('edit', { doc: o.doc, start: { line: 0, col: 2 }, end: { line: 0, col: 2 }, text: '!', kind: 'type' });
  assert.deepEqual(r.caret, { line: 0, col: 3 });
  await e.request('save', { doc: o.doc });
  assert.equal(fs.readFileSync(file, 'utf8'), 'ab!\ncd');
  await e.request('close', { doc: o.doc });
  e.stop();
});
test('an engine error rejects with its message', { skip }, async () => {
  const e = new Engine({ exe, journalDir: tmp() });
  await assert.rejects(e.request('lines', { doc: 99, first: 0, count: 1 }), /That file isn't open/);
  e.stop();
});
test('concurrent requests get their own replies', { skip }, async () => {
  const dir = tmp(), file = path.join(dir, 'f.txt'); fs.writeFileSync(file, Array.from({ length: 500 }, (_, i) => `L${i}`).join('\n'));
  const e = new Engine({ exe, journalDir: path.join(dir, 'j') });
  const { doc } = await e.request('open', { path: file });
  const got = await Promise.all([10, 200, 499].map(first => e.request('lines', { doc, first, count: 1 })));
  assert.deepEqual(got.map(g => g.items[0].text), ['L10', 'L200', 'L499']);
  e.stop();
});
test('a killed engine fires down, rejects what was waiting, and the next request restarts it', { skip }, async () => {
  const dir = tmp(), file = path.join(dir, 'f.txt'); fs.writeFileSync(file, 'x');
  const e = new Engine({ exe, journalDir: path.join(dir, 'j') });
  await e.request('open', { path: file });
  const down = new Promise(res => e.once('down', res));
  e.child.kill();                                   // `child` is the current ChildProcess, exposed for this test
  await down;
  assert.equal(e.running, false);
  assert.equal((await e.request('open', { path: file })).doc, 1);   // a fresh process numbers from 1 again
  e.stop();
});
test('stop does not fire down', { skip }, async () => { /* request once, listen for 'down', stop(), wait 200 ms, assert not fired */ });
test('a missing executable says how to build it', async () => {
  const e = new Engine({ exe: path.join(tmp(), 'nope.exe'), journalDir: tmp() });
  await assert.rejects(e.request('open', { path: 'x' }), { message: NOT_BUILT });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/engine.test.js`
Expected: fails with "Cannot find module '../src/main/engine.js'".

- [ ] **Step 3: Implement `src/main/engine.js`.**
- [ ] **Step 4: Run** `node --test test/engine.test.js` — expected: 6 pass (5 skip if the engine is not built; build it first).
- [ ] **Step 5: Commit**

```bash
git add src/main/engine.js test/engine.test.js
git commit -m "feat(engine): Node client that spawns and restarts the engine"
```

---

### Task 9: IPC handlers, preload bridge and types

**Files:**
- Modify: `src/main/main.js` (new section directly after the `fs:search` block ending near line 964; also the `setRoot` / `fs:closeFolder` lines that call `kernels.stopAll()`, and a `will-quit` hook)
- Modify: `src/main/preload.js` (new `doc` group next to `nb`)
- Modify: `src/renderer/breeze/core.ts` (types, and `doc` in `BreezeApi` near line 218)
- Create: `test/docargs.test.js`
- Create: `src/main/docargs.js`

**Interfaces:**
- Consumes: `Engine` from Task 8; `handle`, `resolveIn`, `unpacked`, `ROOT`, `win` in `main.js`.
- Produces (`src/main/docargs.js`, pure, so it is testable without Electron):
  ```js
  // Each returns a clean value or throws Error('Bad request').
  function docId(v)            // integer 1..2^31-1
  function docPos(v)           // { line, col }: integers 0..2^31-1
  function docLine(v)          // integer 0..2^31-1
  function docCount(v)         // integer 0..5000
  function docText(v)          // string of at most 52,428,800 characters (100 MB as UTF-16)
  function docQuery(v)         // string, 1..1000 characters, no '\n' or '\r'
  function docKind(v)          // 'type' | 'delete' | 'paste' | 'other'
  module.exports = { docId, docPos, docLine, docCount, docText, docQuery, docKind };
  ```
- IPC channels and their engine calls (every handler except `doc:open` first checks `openDocs.has(id)`, else throws `Error("That file isn't open")`):

  | Channel | Arguments | Engine request |
  |---|---|---|
  | `doc:open` | `rel` | `open { path: resolveIn(rel) }`; adds `doc` to `openDocs` |
  | `doc:lines` | `id, first, count` | `lines { doc, first: docLine(first), count: docCount(count) }` |
  | `doc:edit` | `id, start, end, text, kind` | `edit` |
  | `doc:undo` / `doc:redo` | `id` | `undo` / `redo` |
  | `doc:text` | `id, start, end` | `text` |
  | `doc:find` | `id, query, matchCase, from, backward` | `find` (booleans coerced with `=== true`) |
  | `doc:count` | `id, query, matchCase` | `count` |
  | `doc:save` | `id` | `save` |
  | `doc:changed` | `id` | `changed` |
  | `doc:reload` | `id` | `reload` |
  | `doc:close` | `id` | `close`; removes from `openDocs` |

- The engine instance: `new Engine({ exe: unpacked(path.join(ROOT, 'runtime', process.platform === 'win32' ? 'breeze-engine.exe' : 'breeze-engine')), journalDir: path.join(app.getPath('userData'), 'engine-journal') })`, created lazily on the first `doc:open`.
- `engine.on('down')`: clear `openDocs`, then `win?.webContents.send('doc:down')`.
- Root change and folder close (where `kernels.stopAll()` is called): close every id in `openDocs` (ignore errors) and clear the set.
- `app.on('will-quit', () => engine?.stop())`.
- Preload: `doc: { open, lines, edit, undo, redo, text, find, count, save, changed, reload, close, onDown: cb => listen('doc:down', cb) }`, each a thin `invoke` in the argument order above.
- Types in `core.ts`:
  ```ts
  interface DocPos { line: number; col: number }
  interface DocState { rev: number; lines: number; dirty: boolean }
  interface DocLine { text: string; len: number }
  interface DocOpen extends DocState { doc: number; bytes: number; eol: '\n' | '\r\n'; readOnly: boolean; recovered: boolean }
  type DocKind = 'type' | 'delete' | 'paste' | 'other';
  // in BreezeApi:
  doc: {
    open(rel: string): Promise<DocOpen>;
    lines(id: number, first: number, count: number): Promise<DocState & { items: DocLine[] }>;
    edit(id: number, start: DocPos, end: DocPos, text: string, kind: DocKind): Promise<DocState & { caret: DocPos }>;
    undo(id: number): Promise<DocState & { caret?: DocPos; none?: true }>;
    redo(id: number): Promise<DocState & { caret?: DocPos; none?: true }>;
    text(id: number, start: DocPos, end: DocPos): Promise<DocState & { text: string }>;
    find(id: number, query: string, matchCase: boolean, from: DocPos, backward: boolean): Promise<DocState & { hit: (DocPos & { len: number }) | null }>;
    count(id: number, query: string, matchCase: boolean): Promise<DocState & { count: number; capped: boolean }>;
    save(id: number): Promise<DocState & { bytes: number }>;
    changed(id: number): Promise<DocState & { changed: boolean }>;
    reload(id: number): Promise<DocOpen>;
    close(id: number): Promise<void>;
    onDown(cb: () => void): () => void;
  };
  ```

- [ ] **Step 1: Write the failing test** (`test/docargs.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const a = require('../src/main/docargs.js');
const bad = fn => assert.throws(fn, { message: 'Bad request' });
test('docId', () => { assert.equal(a.docId(3), 3); for (const v of [0, -1, 1.5, '3', null, 2 ** 31]) bad(() => a.docId(v)); });
test('docPos', () => { assert.deepEqual(a.docPos({ line: 0, col: 7, extra: 1 }), { line: 0, col: 7 }); for (const v of [null, {}, { line: -1, col: 0 }, { line: 0, col: 1.2 }, { line: '0', col: 0 }]) bad(() => a.docPos(v)); });
test('docLine', () => { assert.equal(a.docLine(0), 0); for (const v of [-1, 0.5, '0', 2 ** 31]) bad(() => a.docLine(v)); });
test('docCount', () => { assert.equal(a.docCount(5000), 5000); bad(() => a.docCount(5001)); bad(() => a.docCount(-1)); });
test('docText', () => { assert.equal(a.docText(''), ''); bad(() => a.docText(5)); bad(() => a.docText({ length: 1 })); });
test('docQuery', () => { assert.equal(a.docQuery('x'), 'x'); for (const v of ['', 'a\nb', 'a\rb', 'x'.repeat(1001), 7]) bad(() => a.docQuery(v)); });
test('docKind', () => { for (const k of ['type', 'delete', 'paste', 'other']) assert.equal(a.docKind(k), k); bad(() => a.docKind('eval')); });
```

- [ ] **Step 2: Run to verify failure** — `node --test test/docargs.test.js`; expected: module not found.
- [ ] **Step 3: Implement `docargs.js`, the `main.js` section, the preload group and the types.**
- [ ] **Step 4: Run the whole suite**

Run: `npm run build && npm test`
Expected: TypeScript compiles; every test passes.

- [ ] **Step 5: Commit**

```bash
git add src/main/docargs.js src/main/main.js src/main/preload.js src/renderer/breeze/core.ts test/docargs.test.js
git commit -m "feat(engine): doc IPC channels behind the path guard"
```

---

### Task 10: `bigcore.ts`, the pure surface logic

**Files:**
- Create: `src/renderer/bigcore.ts`, `test/bigcore.test.js`
- Modify: `tsconfig.json` (`files`: add `"src/renderer/bigcore.ts"` after `codeview.ts`), `.gitignore` (add `src/renderer/bigcore.js`, `src/renderer/bigsurface.js`)

**Interfaces:**
- Consumes: `DocPos`, `DocLine` (declared in `core.ts`; `bigcore.ts` re-declares nothing, the global scope shares them). For the Node test, the file must run alone: it may use those names only as types.
- Produces:
  ```ts
  const BIG_LONG_LINE = 10000;
  function posCmp(a: DocPos, b: DocPos): number;                 // <0, 0, >0
  function posMin(a: DocPos, b: DocPos): DocPos;
  function posMax(a: DocPos, b: DocPos): DocPos;
  /** Where the caret lands after `text` (with "\n" line breaks) is inserted at `start`. */
  function posAfterInsert(start: DocPos, text: string): DocPos;
  /** How many lines the document gains (negative: loses) when start..end is replaced by `text`. */
  function lineDelta(start: DocPos, end: DocPos, text: string): number;

  class LineCache {
    first: number;            // line number of items[0]
    items: DocLine[];
    /** Revision the cached lines reflect, counting local edits not yet confirmed. */
    rev: number;
    constructor();
    get last(): number;                                   // first + items.length (exclusive)
    get(line: number): DocLine | undefined;
    covers(first: number, last: number): boolean;         // every line in first..last (exclusive) is cached
    /** Stores a fetched window. Returns false, storing nothing, when `rev` is older than this.rev. */
    put(first: number, items: DocLine[], rev: number): boolean;
    /** Applies an edit to the cached lines as the engine will, and bumps rev by one.
     *  If start or end falls outside the cache, or touches a cut line beyond BIG_LONG_LINE, the cache is cleared. */
    apply(start: DocPos, end: DocPos, text: string): void;
    clear(): void;
  }

  interface BigMods { shift: boolean; ctrl: boolean }
  /** New head for a movement key. `lenOf` gives a cached line's editable length (min(len, BIG_LONG_LINE)), or
   *  undefined when the line isn't cached: then `col` is kept and the caller clamps after fetching.
   *  `goal` is the remembered column for vertical moves (pass null to start one). */
  function bigMove(head: DocPos, key: string, mods: BigMods, lines: number, page: number, goal: number | null,
    lenOf: (line: number) => number | undefined): { head: DocPos; goal: number | null };
  ```
- `bigMove` keys: `ArrowLeft`, `ArrowRight`, `ArrowUp`, `ArrowDown`, `Home`, `End`, `PageUp`, `PageDown`; with `ctrl`, `Home` and `End` go to the document's start and end. `ArrowLeft` at column 0 goes to the end of the previous line; `ArrowRight` at a line's end goes to the next line's start. `ArrowLeft` and `ArrowRight` step over a surrogate pair as one character (needs the line text: `bigMove` gets it through a second optional callback `textOf: (line: number) => string | undefined`, added as the last parameter).

- [ ] **Step 1: Write the failing test** (`test/bigcore.test.js`; load the file the way `test/editcore.test.js` loads `editcore.ts`, with `stripTypeScriptTypes` into a `vm` context)

```js
const L = (...t) => t.map(text => ({ text, len: text.length }));
const texts = c => c.items.map(i => i.text);
test('posAfterInsert', () => { eq(posAfterInsert({ line: 2, col: 3 }, 'ab'), { line: 2, col: 5 }); eq(posAfterInsert({ line: 2, col: 3 }, 'a\nbc\nd'), { line: 4, col: 1 }); });
test('lineDelta', () => { assert.equal(lineDelta(P(0,0), P(0,0), 'a\nb'), 1); assert.equal(lineDelta(P(1,0), P(3,2), ''), -2); assert.equal(lineDelta(P(1,0), P(2,0), 'x\ny'), 0); });
test('put then get', () => { const c = new LineCache(); assert.equal(c.put(10, L('a', 'b'), 0), true); assert.equal(c.get(11).text, 'b'); assert.equal(c.get(12), undefined); assert.equal(c.covers(10, 12), true); assert.equal(c.covers(9, 11), false); });
test('apply: typing in a line', () => { const c = new LineCache(); c.put(0, L('ab', 'cd'), 0); c.apply(P(0,1), P(0,1), 'X'); eq(texts(c), ['aXb', 'cd']); assert.equal(c.items[0].len, 3); assert.equal(c.rev, 1); });
test('apply: Enter splits, Backspace at line start joins', () => { const c = new LineCache(); c.put(5, L('abcd', 'ef'), 0); c.apply(P(5,2), P(5,2), '\n'); eq(texts(c), ['ab', 'cd', 'ef']); c.apply(P(5,2), P(6,0), ''); eq(texts(c), ['abcd', 'ef']); assert.equal(c.first, 5); });
test('apply: multi-line paste over a multi-line selection', () => { const c = new LineCache(); c.put(0, L('one', 'two', 'three'), 0); c.apply(P(0,1), P(2,2), 'A\nB'); eq(texts(c), ['oA', 'Bree']); });
test('apply: an edit reaching outside the cache clears it', () => { const c = new LineCache(); c.put(10, L('a', 'b'), 0); c.apply(P(3,0), P(10,1), ''); assert.equal(c.items.length, 0); assert.equal(c.rev, 1); });
test('apply: an edit above the cache clears it', () => { const c = new LineCache(); c.put(10, L('a', 'b'), 0); c.apply(P(2,0), P(2,0), 'x\n'); assert.equal(c.items.length, 0); });
test('a stale fetch never overwrites newer local text', () => {   // Review Focus 3
  const c = new LineCache(); c.put(0, L('ab'), 0);
  c.apply(P(0,2), P(0,2), 'c');                    // local rev is now 1
  assert.equal(c.put(0, L('ab'), 0), false);       // the reply to a fetch sent before the edit
  eq(texts(c), ['abc']);
  assert.equal(c.put(0, L('abc'), 1), true);       // the engine caught up
});
test('apply: a cut line clears the cache', () => { const c = new LineCache(); c.put(0, [{ text: 'x'.repeat(10000), len: 50000 }], 0); c.apply(P(0,5), P(0,5), 'y'); assert.equal(c.items.length, 0); });
test('bigMove', () => {
  const lens = [3, 0, 5], lenOf = l => lens[l], textOf = l => ['a😀', '', 'hello'][l], m = { shift: false, ctrl: false };
  const mv = (line, col, key, mods = m, goal = null) => bigMove(P(line, col), key, mods, 3, 2, goal, lenOf, textOf);
  eq(mv(0, 3, 'ArrowRight').head, P(1, 0)); eq(mv(1, 0, 'ArrowLeft').head, P(0, 3));
  eq(mv(0, 1, 'ArrowRight').head, P(0, 3));        // over the surrogate pair
  eq(mv(0, 3, 'ArrowLeft').head, P(0, 1));
  eq(mv(0, 0, 'ArrowLeft').head, P(0, 0)); eq(mv(2, 5, 'ArrowRight').head, P(2, 5));
  const down = mv(2, 4, 'ArrowUp'); eq(down.head, P(1, 0)); assert.equal(down.goal, 4);
  eq(mv(1, 0, 'ArrowUp', m, 4).head, P(0, 3));     // goal 4 clamps to the line's length
  eq(mv(0, 1, 'End').head, P(0, 3)); eq(mv(2, 3, 'Home').head, P(2, 0));
  eq(mv(1, 0, 'End', { shift: false, ctrl: true }).head, P(2, 5)); eq(mv(2, 2, 'Home', { shift: false, ctrl: true }).head, P(0, 0));
  eq(mv(0, 0, 'PageDown').head, P(2, 0)); eq(mv(2, 0, 'PageUp').head, P(0, 0));
  eq(bigMove(P(0, 2), 'ArrowDown', m, 3, 2, null, () => undefined).head, P(1, 2));   // uncached: column kept
});
```

- [ ] **Step 2: Run to verify failure** — `node --test test/bigcore.test.js`.
- [ ] **Step 3: Implement `bigcore.ts`.**
- [ ] **Step 4: Run** `npm run build && node --test test/bigcore.test.js` — expected: all pass.
- [ ] **Step 5: Commit**

```bash
git add src/renderer/bigcore.ts test/bigcore.test.js tsconfig.json .gitignore
git commit -m "feat(bigfile): line cache with optimistic edits and position maths"
```

---

### Task 11: `BigSurface`

**Files:**
- Create: `src/renderer/bigsurface.ts`, `test/harness/bigsurface.html`
- Modify: `tsconfig.json` (`files`: add `"src/renderer/bigsurface.ts"` after `bigcore.ts`), `src/renderer/breeze.html` (script tags for `bigcore.js` and `bigsurface.js` after `codeview.js`, line 856), `src/renderer/breeze.css` (the `.big-*` rules)

**Interfaces:**
- Consumes: `LineCache`, `bigMove`, `posCmp`, `posMin`, `posMax`, `posAfterInsert`, `lineDelta`, `BIG_LONG_LINE` (Task 10); `wordAt`, `colAtVisual` from `editcore.ts`; `DocPos`, `DocLine`, `DocState`, `DocKind`.
- Produces:
  ```ts
  interface BigSource {
    lines(first: number, count: number): Promise<DocState & { items: DocLine[] }>;
    edit(start: DocPos, end: DocPos, text: string, kind: DocKind): Promise<DocState & { caret: DocPos }>;
    undo(): Promise<DocState & { caret?: DocPos; none?: true }>;
    redo(): Promise<DocState & { caret?: DocPos; none?: true }>;
    text(start: DocPos, end: DocPos): Promise<string>;
  }
  interface BigOpts { lineHeight: () => number; charWidth: () => number; tabSize: number; label: string; readOnly: boolean; lines: number; rev: number }
  class BigSurface extends EventTarget {
    readonly root: HTMLDivElement;        // class "big-surface"
    readonly input: HTMLTextAreaElement;  // class "ta code-input", as CodeSurface
    constructor(host: HTMLElement, src: BigSource, opts: BigOpts);
    get lines(): number;
    get caret(): DocPos;                                   // the head
    get selection(): { anchor: DocPos; head: DocPos };
    get hasSelection(): boolean;
    setSelection(anchor: DocPos, head: DocPos): void;      // clamps to cached lengths where known; fires 'selectionchange'
    reveal(pos: DocPos): Promise<void>;                    // scrolls so the line is a third down the view, fetches, paints
    get topLine(): number;
    set topLine(n: number);                                // clamped to 0..lines-1
    insert(text: string, kind: DocKind): void;             // replaces the selection, as typing does
    undo(): Promise<void>;
    redo(): Promise<void>;
    selectedText(): Promise<string>;                       // '' with no selection; rejects with the engine's message when too large
    /** After a reload, an engine restart, or any change made outside the surface: forget the cache and refetch. */
    reset(state: DocState): Promise<void>;
    focus(): void;
    refresh(): void;                                       // metrics changed (font size): repaint
    remove(): void;
    get classList(): DOMTokenList;
  }
  ```
- Events: `'selectionchange'`; `'change'` as a `CustomEvent<DocState>` after every engine reply that changes state (edit, undo, redo); `'readonly'` when the user types into a read-only document; `'error'` as a `CustomEvent<string>` when an engine call fails.
- DOM inside `root`: `.big-gutter` (line numbers), `.big-code` (native horizontal scroll) holding `.big-lines` (one `div.big-line` per visible line, `white-space: pre`, text set with `textContent`), `.big-sel` boxes, `.code-caret`, the hidden input, and `.big-slider` > `.big-thumb` on the right edge.
- Vertical scrolling: no native scroll. `wheel` adds `deltaY / lineHeight()` lines (use `deltaMode` to convert lines and pages). The thumb's height is `max(24px, viewLines / lines * trackHeight)`; dragging maps the thumb's position linearly onto `0..lines - viewLines`.
- Fetching: on any change of the visible range, if the cache does not cover visible plus 40 lines either side, request visible plus 200 either side. Only one fetch in flight; a newer need replaces the queued one. A reply goes through `LineCache.put` (which rejects stale ones); a rejected reply triggers a refetch.
- Lines not cached yet paint as empty rows with their line number, so scrolling never blocks.
- Editing: every edit calls `cache.apply` and repaints before `src.edit` is sent. `lines` updates locally with `lineDelta`. The engine's reply only updates `rev`/`dirty` (via `'change'`) and is otherwise ignored unless it failed; on failure fire `'error'` and `reset`.
- Keys handled on the input: the `bigMove` keys with and without Shift; `Enter`; `Backspace`; `Delete`; `Tab` (inserts `\t`); `Ctrl+A`; `Ctrl+Z`; `Ctrl+Y` and `Ctrl+Shift+Z`. Text arrives through the `input` event and `compositionend`, as in `CodeSurface`.
- `Enter` copies no indentation in piece 1.
- Backspace with no selection deletes the character before the caret (a whole surrogate pair), or joins with the previous line at column 0. Delete mirrors it.
- Copy and cut (`copy`/`cut` events): `preventDefault`, then `selectedText()` and `navigator.clipboard.writeText`. Cut then calls `insert('', 'delete')`. Paste reads `clipboardData`, normalises `\r\n?` to `\n`, calls `insert(text, 'paste')`.
- Mouse: `pointerdown` places the caret (Shift extends), drag selects, double-click selects the word with `wordAt` on the line's text, triple-click selects the line. Dragging past the top or bottom edge scrolls.
- A cut line shows its first 10,000 units followed by a `span.big-more` reading `… N more characters` (`N = len - 10000`, with thousands separators). The caret cannot move past column 10,000 on such a line.
- Column to x: for a line that is ASCII without tabs, `col * charWidth()`. With tabs, use `colAtVisual`'s tab-stop rule with `opts.tabSize`. For a line containing any non-ASCII character, measure the prefix with a shared canvas 2D context whose `font` is read from the root's computed style. x to column inverts the same function by binary search.
- Read-only: all edit paths fire `'readonly'` and do nothing else. Selection, copy and scrolling work.

- [ ] **Step 1: Build the harness** (`test/harness/bigsurface.html`)

A page that loads `editcore.js`, `bigcore.js`, `bigsurface.js` and mounts a `BigSurface` on a fake `BigSource` holding an in-memory array of 3,000,000 lines (`line ${i}`, with line 5 = 30,000 `x`, line 6 = `a\tb\tc`, line 7 = `日本語 😀 é end`). The fake applies edits to the array and answers after a random 5 to 60 ms delay, so stale replies happen. It exposes `window.surface` and `window.fake`. Copy the surface's CSS from `breeze.css` into the page, as `codeview.html` does.

- [ ] **Step 2: Implement `bigsurface.ts` and the CSS.**

- [ ] **Step 3: Compile**

Run: `npm run build`
Expected: no TypeScript errors.

- [ ] **Step 4: Verify in the harness** (open `test/harness/bigsurface.html` in the Browser pane; each line is a check)

1. Line 1 shows at the top; the gutter reads 1, 2, 3.
2. Drag the thumb to the bottom: the last line number is 3,000,000 and its text is `line 2999999`.
3. Wheel scrolling moves about three lines per notch; blank rows fill within 100 ms.
4. Click line 1, type `hello` quickly: the text appears with no flicker and no characters lost or reordered (Review Focus 3). `fake.lines[0]` equals `helloline 0` after 200 ms.
5. Enter, Backspace, Delete, Tab change the text and the line count as expected.
6. Ctrl+Z undoes; Ctrl+Y redoes.
7. Shift+arrows and drag select; the selection boxes sit exactly behind the text.
8. On line 7 (`日本語 😀 é end`): click just after `語`, type `X`; `fake.lines[6]` is `日本語X 😀 é end`. Arrow right over `😀` takes one press (Review Focus 5).
9. On line 6 (tabs): click after `b`; typing inserts after `b`.
10. Line 5 shows the `… 20,000 more characters` chip; End stops at column 10,000.
11. Ctrl+End goes to the last line; Ctrl+Home to the first.
12. `await surface.selectedText()` after Ctrl+A on a 3-line fake returns the three lines joined with `\n`.

Fix what fails, then re-run the list.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/bigsurface.ts test/harness/bigsurface.html tsconfig.json src/renderer/breeze.html src/renderer/breeze.css
git commit -m "feat(bigfile): windowed editing surface for huge files"
```

---

### Task 12: Wire huge files into the app

**Files:**
- Create: `src/renderer/breeze/bigfile.ts`
- Modify: `tsconfig.json` (`files`: add `"src/renderer/breeze/bigfile.ts"` directly before `editor.ts`), `src/renderer/breeze.html` (script tag for `breeze/bigfile.js` in the same position; add `<div class="big-host hidden" id="bigHost"></div>` inside `#editor`, directly after the `.code` div at line 519)
- Modify: `src/renderer/breeze/workspace.ts:5-26,40`, `buffers.ts:79-82,106-125`, `editor.ts:147-153,154-200,1088,1408-1453,1512`, `tabs.ts:449-457,511-513`, `commands.ts:47-48`, `src/renderer/breeze.css`

**Interfaces:**
- Consumes: `api.doc` (Task 9), `BigSurface`, `BigSource` (Task 11).
- Produces:
  ```ts
  // workspace.ts, in EditorBuffer:
  big?: { doc: number; surface: BigSurface; readOnly: boolean; dirty: boolean; lines: number; changedOnDisk: boolean };
  bigError?: string;      // why the engine could not open it; shown in the note
  // bigfile.ts
  async function openBig(b: EditorBuffer): Promise<void>;       // sets b.big, or b.bigError
  function showBig(b: EditorBuffer | undefined): boolean;        // shows or hides #bigHost; true when b.big is shown
  async function saveBig(b: EditorBuffer): Promise<boolean>;
  function closeBig(b: EditorBuffer): void;
  async function bigFindStep(b: EditorBuffer, dir: 1 | -1): Promise<void>;
  async function bigFindCount(b: EditorBuffer): Promise<void>;
  function bigGoToLine(b: EditorBuffer): void;
  const activeBig = (): EditorBuffer | undefined;                // the active buffer when it has `big`
  ```

Changes to existing code, each a small branch:

| Where | Change |
|---|---|
| `workspace.ts:40` `isDirty` | `!!b && ((b.kind === 'text' && b.text !== b.saved) \|\| !!b.big?.dirty)` |
| `buffers.ts` `loadBuffer` | After the buffer is built: `if (b.kind === 'large') await openBig(b);` |
| `buffers.ts` `resetWorkspace` | In the loop over buffers: also `b.big?.surface.remove()` |
| `editor.ts` `editorNote` | For `large`: when `b.bigError` is set, return `` `${b.bigError} (${(b.size / 1048576).toFixed(1)} MB)` `` |
| `editor.ts` `renderEditor` | First line after `hideSuggest()` and `const b`: `const big = showBig(b);`. After the notebook branch: `if (big) { empty.classList.add('hidden'); hlLines.replaceChildren(); hlBoxes.replaceChildren(); gutLines.replaceChildren(); updateSliders(); updateStatus(); b!.big!.surface.focus(); return; }` |
| `editor.ts` `updateStatus` | For `activeBig()`: show `#sbPos` with `Ln X, Col Y` from `surface.caret` (1-based), and `#sbEol` with the ending, `UTF-8`, and `fmtSize(b.size)`; add ` · Read only` when `readOnly` |
| `editor.ts` `openFind` | At the top: for `activeBig()`, open the bar, call `showReplace(false)`, hide `#findToggle`, focus the input, call `bigFindCount`, return. `closeFind` un-hides `#findToggle` |
| `editor.ts` `runFind`, `stepFind` | At the top: for `activeBig()`, call `bigFindCount` (runFind) or `bigFindStep(b, d)` (stepFind) and return |
| `editor.ts` `goToLine` | At the top: `const big = activeBig(); if (big) { bigGoToLine(big); return; }` |
| `tabs.ts` `saveFile` | First line after `const b`: `if (b?.big) return saveBig(b);` |
| `tabs.ts` `dropTab` | Before `buffers.delete(path)`: `const gone = buffers.get(path); if (gone?.big) closeBig(gone);` |
| `commands.ts:47-48` | `'edit.undo'`: `activeBig() ? void activeBig()!.big!.surface.undo() : editRole('undo')`; same for redo |

Behaviour in `bigfile.ts`:

- `openBig`: `api.doc.open(b.path)`. On success build the `BigSource` from `api.doc.*` bound to the id, create the surface in `#bigHost` (hidden until shown) with `lineHeight: () => LINE_H`, `charWidth: measureChar`, `tabSize: 4`, set `b.eol`, `b.big`. If `recovered`, `toast(`Restored unsaved edits to ${baseName(b.path)}`)`. On failure set `b.bigError = errMsg(e)`.
- Surface `'change'`: copy `dirty` and `lines` into `b.big`; when `dirty` flipped, `renderTabs()`.
- Surface `'selectionchange'`: `updateStatus()`.
- Surface `'readonly'`: once per buffer, `toast("This file isn't valid UTF-8, so it can't be edited here")`.
- Surface `'error'`: `toast(detail)`.
- `showBig`: toggles `hidden` on `#bigHost` and on each big buffer's `surface.root` so only the active one shows; returns whether the active buffer has `big`.
- `saveBig`: if `changedOnDisk`, ask with the existing `askDiskConflict(b)`; `'reload'` calls `api.doc.reload` then `surface.reset`, returns false; anything but `'overwrite'` returns false. Then `api.doc.save`; on success set `dirty = false`, `changedOnDisk = false`, `b.size = bytes`, `renderTabs(); renderTree(); flushSession();` and return true. On failure `toast(`Couldn't save ${baseName(b.path)}: ${errMsg(e)}`)` and return false.
- `closeBig`: `surface.remove()`, `void api.doc.close(doc).catch(() => {})`.
- `bigFindStep`: `api.doc.find(doc, findInput.value, findCase, from, dir === -1)`, where `from` is the selection's end (forward) or start (backward). On a hit: `setSelection` over it and `reveal`. On none: `$('#findCount').textContent = 'No results'`.
- `bigFindCount`: `api.doc.count`; text is `No results`, `` `${count} results` ``, or `9999+ results` when capped. Empty query clears the text.
- `bigGoToLine`: the same modal as `goToLine` with `total = b.big.lines`; Enter sets the caret to `{ line: n - 1, col: 0 }` and reveals it.
- `api.fs.onChange(paths => …)`: for each big buffer whose path is in `paths`, `api.doc.changed`; when true and not dirty, `api.doc.reload` then `surface.reset`; when true and dirty, set `changedOnDisk = true` (the next save asks).
- `api.doc.onDown(() => …)`: for each big buffer, keep `surface.topLine` and `surface.selection`, call `api.doc.open(b.path)` again, point the buffer and its `BigSource` at the new id, `surface.reset(state)`, then restore `topLine` and the selection. If the reopen fails, drop `b.big`, set `b.bigError`, and `renderEditor()`.

`askDiskConflict` (`tabs.ts:558`) reads only `b.path`, so it works for a big buffer unchanged.

- [ ] **Step 1: Implement `bigfile.ts` and the branches above.**

- [ ] **Step 2: Compile and run the suite**

Run: `npm run build && npm test`
Expected: compiles; all tests pass.

- [ ] **Step 3: Generate a test file** (outside the repository, in the scratch folder)

```bash
node -e "const fs=require('fs');const w=fs.createWriteStream(process.argv[1]);let i=0;(function go(){while(i<12000000){if(!w.write('line '+String(i++).padStart(8,'0')+' the quick brown fox\r\n'))return w.once('drain',go);}w.end();})()" "%TEMP%/breeze-big.log"
```

Expected: a file of about 400 MB with CRLF endings. Copy it into a test project folder.

- [ ] **Step 4: Verify in the running app** (start with `npm start`; open the test folder)

1. Click the file: it opens with text, not the "too large" note. Note the time to first text against the 5-second target.
2. Ctrl+End: the last line shows. Ctrl+Home: the first.
3. Type on line 1 and on the last text line: the tab shows the unsaved dot; the status bar shows `Ln`, `Col`, `CRLF · UTF-8`.
4. Ctrl+Z twice, Ctrl+Y twice.
5. Ctrl+F, search `11999999`: Enter jumps to it; the count reads `1 results`. Search `fox`: `9999+ results`.
6. Ctrl+G, `6000000`: the view jumps there.
7. Ctrl+S: the dot clears. Close the tab, reopen: both edits are there. `git diff --stat` on a copy, or a byte check of an untouched middle line, shows CRLF endings were kept.
8. With an unsaved edit, end `breeze-engine.exe` in Task Manager: the view stays, and the edit is still there after it reloads.
9. Close the tab with an unsaved edit: the "Save changes" prompt appears.
10. Open a normal small file and edit it: nothing about it changed.
11. Rename `runtime/breeze-engine.exe` away, restart, open the big file: the note reads "The Breeze engine isn't built. Run npm run build:engine". Rename it back.

Fix what fails, then re-run the list. Record the measured numbers for the spec's four targets in the commit message body.

- [ ] **Step 5: Commit**

```bash
git add src/renderer tsconfig.json
git commit -m "feat(bigfile): open and edit files above 50 MB through the Rust engine"
```
