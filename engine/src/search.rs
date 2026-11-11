//! Find, count and range text. Everything walks the rope chunk by chunk: a document can be 2 GB
//! and can be one single line, so nothing here copies the whole rope or a whole line.

use memchr::{memchr, memchr2, memmem};
use ropey::Rope;

use crate::doc::{Doc, Pos};

/// A match: where it starts, and its length in UTF-16 units (the query's length).
#[derive(Debug, PartialEq, serde::Serialize)]
pub struct Hit { pub line: usize, pub col: usize, pub len: usize }

/// `count` stops here.
pub const COUNT_CAP: usize = 9_999;
/// `text` refuses a range above this many bytes.
pub const TEXT_CAP_BYTES: usize = 100 * 1024 * 1024;
pub const TEXT_CAP_MSG: &str = "That selection is too large to copy";

/// Finds one needle in byte slices, with or without ASCII case folding. Non-ASCII bytes always
/// match exactly, so a hit for a valid UTF-8 needle always starts on a char boundary.
enum Matcher {
    Exact(memmem::Finder<'static>),
    /// The needle lowercased (ASCII only).
    Folded(Vec<u8>),
}

impl Matcher {
    fn new(needle: &[u8], match_case: bool) -> Matcher {
        if match_case { Matcher::Exact(memmem::Finder::new(needle).into_owned()) }
        else { Matcher::Folded(needle.to_ascii_lowercase()) }
    }

    /// The first match in `hay` starting at or after `from`.
    fn find(&self, hay: &[u8], from: usize) -> Option<usize> {
        match self {
            Matcher::Exact(f) => f.find(hay.get(from..)?).map(|i| i + from),
            Matcher::Folded(needle) => {
                let n = needle.len();
                let first = needle[0];
                let mut at = from;
                while at + n <= hay.len() {
                    // Candidate starts only: the last start that can still fit the needle is len - n.
                    let rest = &hay[at..hay.len() - n + 1];
                    let i = if first.is_ascii_alphabetic() { memchr2(first, first.to_ascii_uppercase(), rest) } else { memchr(first, rest) }?;
                    if hay[at + i..at + i + n].eq_ignore_ascii_case(needle) { return Some(at + i); }
                    at += i + 1;
                }
                None
            }
        }
    }
}

/// Calls `on_hit(byte_offset)` for each non-overlapping match whose start lies in byte range
/// `from..to`, in order; stops when it returns false. A match may run past `to`. After a hit,
/// scanning resumes at the hit's end, also across chunk edges.
pub fn scan(rope: &Rope, needle: &[u8], match_case: bool, from: usize, to: usize, on_hit: &mut dyn FnMut(usize) -> bool) {
    let n = needle.len();
    let total = rope.len_bytes();
    let to = to.min(total);
    if n == 0 || from >= to { return; }
    let end = total.min(to.saturating_add(n - 1));   // last byte a match starting before `to` can touch
    let matcher = Matcher::new(needle, match_case);

    // `carry` holds the last n-1 bytes seen so far, starting at absolute offset `carry_start`.
    // A match straddling a chunk edge starts inside it and is found in `carry + chunk head`.
    let mut carry: Vec<u8> = Vec::new();
    let mut carry_start = from;
    let mut window: Vec<u8> = Vec::new();
    let mut next_min = from;   // a hit may not start before this (non-overlap)

    let (chunks, chunk_start, _, _) = rope.chunks_at_byte(from);
    let mut chunk_at = chunk_start;
    for chunk in chunks {
        let all = chunk.as_bytes();
        let this_start = chunk_at;
        chunk_at += all.len();
        if this_start >= end { break; }
        let lo = from.saturating_sub(this_start);
        let hi = all.len().min(end - this_start);
        if lo >= hi { continue; }
        let bytes = &all[lo..hi];
        let base = this_start + lo;

        // A match that starts in the carry and ends in this chunk. At most one exists: two
        // non-overlapping matches cannot both start within n-1 bytes.
        if !carry.is_empty() {
            window.clear();
            window.extend_from_slice(&carry);
            window.extend_from_slice(&bytes[..bytes.len().min(n - 1)]);
            let min_idx = next_min.saturating_sub(carry_start);
            if let Some(i) = matcher.find(&window, min_idx) {
                if i < carry.len() {
                    let abs = carry_start + i;
                    if abs >= to || !on_hit(abs) { return; }
                    next_min = abs + n;
                }
            }
        }

        // Matches that start inside this chunk (never the one reported above, which starts before it).
        let mut at = next_min.max(base) - base;
        while let Some(i) = matcher.find(bytes, at) {
            let abs = base + i;
            if abs >= to || !on_hit(abs) { return; }
            next_min = abs + n;
            at = i + n;
        }

        // Keep the last n-1 bytes for the next edge.
        let keep = n - 1;
        if bytes.len() >= keep {
            carry.clear();
            carry.extend_from_slice(&bytes[bytes.len() - keep..]);
        } else {
            carry.extend_from_slice(bytes);
            if carry.len() > keep { carry.drain(..carry.len() - keep); }
        }
        carry_start = base + bytes.len() - carry.len();
    }
}

impl Doc {
    /// Forward: the first hit starting at or after `from`, else the first hit in the file (wrap).
    /// Backward: the last hit starting before `from`, else the last hit in the file.
    /// An empty query finds nothing. Case folding covers ASCII letters only.
    pub fn find(&self, query: &str, match_case: bool, from: Pos, backward: bool) -> Option<Hit> {
        let rope = self.rope();
        let needle = query.as_bytes();
        let total = rope.len_bytes();
        let from = rope.char_to_byte(self.char_at(from));
        let mut found = None;
        if backward {
            scan(rope, needle, match_case, 0, from, &mut |b| { found = Some(b); true });
            if found.is_none() { scan(rope, needle, match_case, from, total, &mut |b| { found = Some(b); true }); }
        } else {
            scan(rope, needle, match_case, from, total, &mut |b| { found = Some(b); false });
            if found.is_none() { scan(rope, needle, match_case, 0, from, &mut |b| { found = Some(b); false }); }
        }
        let pos = self.pos_at(rope.byte_to_char(found?));
        Some(Hit { line: pos.line, col: pos.col, len: query.encode_utf16().count() })
    }

    /// The number of non-overlapping hits, and whether there are more than `COUNT_CAP`.
    pub fn count(&self, query: &str, match_case: bool) -> (usize, bool) {
        let mut count = 0;
        let mut capped = false;
        scan(self.rope(), query.as_bytes(), match_case, 0, usize::MAX, &mut |_| {
            if count == COUNT_CAP { capped = true; return false; }
            count += 1;
            true
        });
        (count, capped)
    }

    /// The text from `start` to `end` (swapped if reversed, clamped to the document), with every
    /// `\r\n` returned as `\n`. Refuses a range above `TEXT_CAP_BYTES` before building anything.
    pub fn text(&self, start: Pos, end: Pos) -> Result<String, String> {
        let (start, end) = if end < start { (end, start) } else { (start, end) };
        let rope = self.rope();
        let (from, to) = (self.char_at(start), self.char_at(end));
        let size = rope.char_to_byte(to) - rope.char_to_byte(from);
        if size > TEXT_CAP_BYTES { return Err(TEXT_CAP_MSG.to_string()); }
        let mut out = String::with_capacity(size);
        let mut held_cr = false;   // a `\r` at the end of a chunk, waiting to see whether `\n` follows
        for chunk in rope.slice(from..to).chunks() {
            for c in chunk.chars() {
                if held_cr {
                    held_cr = false;
                    if c != '\n' { out.push('\r'); }
                }
                if c == '\r' { held_cr = true; } else { out.push(c); }
            }
        }
        if held_cr { out.push('\r'); }
        Ok(out)
    }
}
