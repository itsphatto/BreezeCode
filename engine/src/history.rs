//! Undo history: the edits made to a document, newest last, with typing and deleting merged
//! into steps a person would undo in one go.

use std::collections::VecDeque;

use crate::doc::EditKind;

/// The undo stack holds at most this many bytes of text (`removed` plus `inserted`).
pub const UNDO_CAP_BYTES: usize = 256 * 1024 * 1024;

/// One replacement: at rope char index `at`, `removed` was replaced by `inserted`. Both texts are
/// as they sit in the rope, line endings included.
#[derive(Clone, Debug, PartialEq)]
pub struct Step { pub at: usize, pub removed: String, pub inserted: String, pub kind: EditKind }

impl Step {
    fn bytes(&self) -> usize { self.removed.len() + self.inserted.len() }

    /// Whether `next`, made right after this step, undoes together with it.
    fn joins(&self, next: &Step) -> bool {
        if self.kind != next.kind { return false; }
        let has_newline = |s: &Step| s.removed.contains('\n') || s.inserted.contains('\n');
        if has_newline(self) || has_newline(next) { return false; }
        match self.kind {
            EditKind::Type => next.at == self.at + self.inserted.chars().count(),
            // Backspace ends where the last delete began; the Delete key starts where it did.
            EditKind::Delete => {
                self.inserted.is_empty() && next.inserted.is_empty()
                    && (next.at + next.removed.chars().count() == self.at || next.at == self.at)
            }
            EditKind::Paste | EditKind::Other => false,
        }
    }

    /// Folds `next` (which `joins` this step) into this one.
    fn absorb(&mut self, next: Step) {
        match self.kind {
            EditKind::Type => {
                self.removed.push_str(&next.removed);
                self.inserted.push_str(&next.inserted);
            }
            _ if next.at == self.at => self.removed.push_str(&next.removed),
            _ => {
                self.at = next.at;
                self.removed.insert_str(0, &next.removed);
            }
        }
    }
}

pub struct History {
    undo: VecDeque<Step>,
    redo: Vec<Step>,
    /// Bytes of text held by `undo`.
    bytes: usize,
    cap: usize,
}

impl Default for History {
    fn default() -> History { History::with_cap(UNDO_CAP_BYTES) }
}

impl History {
    pub fn with_cap(cap: usize) -> History { History { undo: VecDeque::new(), redo: Vec::new(), bytes: 0, cap } }

    /// Records a new edit: joins the last step when the two belong together, otherwise pushes.
    /// Clears redo and drops the oldest steps while over the cap.
    pub fn record(&mut self, step: Step) {
        self.redo.clear();
        match self.undo.back_mut() {
            Some(last) if last.joins(&step) => {
                let before = last.bytes();
                last.absorb(step);
                self.bytes = self.bytes - before + last.bytes();
            }
            _ => self.push_undo(step),
        }
        self.enforce_cap();
    }

    pub fn pop_undo(&mut self) -> Option<Step> {
        let step = self.undo.pop_back()?;
        self.bytes -= step.bytes();
        Some(step)
    }

    pub fn push_redo(&mut self, step: Step) { self.redo.push(step); }

    pub fn pop_redo(&mut self) -> Option<Step> { self.redo.pop() }

    /// The step the next `pop_undo` / `pop_redo` would return.
    pub fn peek_undo(&self) -> Option<&Step> { self.undo.back() }
    pub fn peek_redo(&self) -> Option<&Step> { self.redo.last() }

    /// Puts a redone step back on the undo stack. Unlike `record`, it keeps the redo stack.
    pub fn push_undo(&mut self, step: Step) {
        self.bytes += step.bytes();
        self.undo.push_back(step);
        self.enforce_cap();
    }

    /// Forgets every step.
    pub fn clear(&mut self) {
        self.undo.clear();
        self.redo.clear();
        self.bytes = 0;
    }

    fn enforce_cap(&mut self) {
        while self.bytes > self.cap {
            match self.undo.pop_front() {
                Some(dropped) => self.bytes -= dropped.bytes(),
                None => break,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test] fn cap_drops_oldest() {
        let mut h = History::with_cap(10);
        for i in 0..5 { h.record(Step { at: i * 100, removed: String::new(), inserted: "abcd".into(), kind: EditKind::Paste }); }
        let mut n = 0; while h.pop_undo().is_some() { n += 1; } assert_eq!(n, 2);
    }
}
