//! The JSON-lines protocol: one request line in, one reply line out.

use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::doc::{Doc, EditKind, Pos};
use crate::journal::{Entry, Journal};

const BAD_REQUEST: &str = "Bad request";
const NOT_OPEN: &str = "That file isn't open";
const INTERNAL: &str = "The engine hit an internal error";

/// The extra fields of one reply, after `id` and `ok`.
type Fields = Map<String, Value>;
type Open = (Doc, Option<Journal>);

/// The open documents and everything needed to answer requests about them.
pub struct Engine {
    docs: HashMap<u32, Open>,
    next_id: u32,
    journal_dir: Option<PathBuf>,
}

/// A number from the page, clamped to what this machine can index.
fn clamp(n: u64) -> usize { usize::try_from(n).unwrap_or(usize::MAX) }

#[derive(Deserialize)]
struct WirePos { line: u64, col: u64 }

impl WirePos {
    fn pos(&self) -> Pos { Pos { line: clamp(self.line), col: clamp(self.col) } }
}

#[derive(Deserialize)] struct OpenArgs { path: PathBuf }
#[derive(Deserialize)] struct DocArgs { doc: u64 }
#[derive(Deserialize)] struct LinesArgs { doc: u64, first: u64, count: u64 }
#[derive(Deserialize)] struct EditArgs { doc: u64, start: WirePos, end: WirePos, text: String, kind: EditKind }
#[derive(Deserialize)] struct TextArgs { doc: u64, start: WirePos, end: WirePos }
#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
struct FindArgs { doc: u64, query: String, match_case: bool, from: WirePos, backward: bool }
#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
struct CountArgs { doc: u64, query: String, match_case: bool }

/// Reads the arguments of a request. Anything missing or of the wrong type is a bad request.
fn args<T: DeserializeOwned>(req: &Value) -> Result<T, String> {
    T::deserialize(req).map_err(|_| BAD_REQUEST.to_string())
}

/// `{ "id", "ok", ...fields }` or `{ "id", "ok": false, "error" }`, in that key order.
fn reply(id: Value, result: Result<Fields, String>) -> String {
    let mut out = Map::new();
    out.insert("id".into(), id);
    match result {
        Ok(fields) => { out.insert("ok".into(), Value::Bool(true)); out.extend(fields); }
        Err(error) => { out.insert("ok".into(), Value::Bool(false)); out.insert("error".into(), Value::String(error)); }
    }
    serde_json::to_string(&Value::Object(out)).unwrap_or_else(|_| format!(r#"{{"id":null,"ok":false,"error":"{INTERNAL}"}}"#))
}

fn fields(v: Value) -> Fields {
    match v { Value::Object(m) => m, _ => Map::new() }
}

fn caret(p: Pos) -> Value { json!({ "line": p.line, "col": p.col }) }

/// Adds the facts every document reply carries: `rev`, `lines`, `dirty`.
fn with_state(doc: &Doc, mut f: Fields) -> Fields {
    f.insert("rev".into(), json!(doc.rev()));
    f.insert("lines".into(), json!(doc.line_count()));
    f.insert("dirty".into(), json!(doc.dirty()));
    f
}

/// The reply of `open` and `reload`, without the doc id.
fn open_fields(doc: &Doc, recovered: bool) -> Fields {
    fields(json!({ "bytes": doc.bytes(), "eol": doc.eol(), "readOnly": doc.read_only(), "recovered": recovered }))
}

impl Engine {
    pub fn new(journal_dir: Option<PathBuf>) -> Engine { Engine { docs: HashMap::new(), next_id: 1, journal_dir } }

    /// A request that arrived as raw bytes: one that is not UTF-8 is a bad request.
    pub fn handle_bytes(&mut self, line: &[u8]) -> String {
        match std::str::from_utf8(line) {
            Ok(s) => self.handle(s),
            Err(_) => reply(Value::Null, Err(BAD_REQUEST.to_string())),
        }
    }

    /// One request line in, one reply line out (no trailing newline). Never panics.
    pub fn handle(&mut self, line: &str) -> String {
        let req: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return reply(Value::Null, Err(BAD_REQUEST.to_string())),
        };
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        match catch_unwind(AssertUnwindSafe(|| self.dispatch(&req))) {
            Ok(result) => reply(id, result),
            Err(_) => {
                // A panic may have left the document the request named half-edited. The engine
                // goes on serving, but that document is dropped: the page sees "isn't open" and
                // can open it again (its journal file stays on disk and is replayed then).
                if let Some(doc) = req.get("doc").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()) {
                    self.docs.remove(&doc);
                }
                reply(id, Err(INTERNAL.to_string()))
            }
        }
    }

    fn dispatch(&mut self, req: &Value) -> Result<Fields, String> {
        let op = req.get("op").and_then(Value::as_str).ok_or_else(|| BAD_REQUEST.to_string())?;
        match op {
            "open" => { let a: OpenArgs = args(req)?; self.open(&a.path) }
            "reload" => { let a: DocArgs = args(req)?; self.reload(a.doc) }
            "close" => { let a: DocArgs = args(req)?; self.close(a.doc) }
            "lines" => {
                let a: LinesArgs = args(req)?;
                let (doc, _) = self.open_doc(a.doc)?;
                let items = serde_json::to_value(doc.lines(clamp(a.first), clamp(a.count))).map_err(|_| INTERNAL.to_string())?;
                Ok(with_state(doc, fields(json!({ "items": items }))))
            }
            "edit" => {
                let a: EditArgs = args(req)?;
                let (doc, journal) = self.open_doc(a.doc)?;
                let (start, end) = (a.start.pos(), a.end.pos());
                let at = doc.edit(start, end, &a.text, a.kind)?;
                if let Some(j) = journal { j.append(&Entry::Edit { start, end, text: a.text, kind: a.kind }); }
                Ok(with_state(doc, fields(json!({ "caret": caret(at) }))))
            }
            "undo" | "redo" => {
                let a: DocArgs = args(req)?;
                let (doc, journal) = self.open_doc(a.doc)?;
                let undo = op == "undo";
                let moved = if undo { doc.undo() } else { doc.redo() };
                let f = match moved {
                    Some(at) => {
                        if let Some(j) = journal { j.append(if undo { &Entry::Undo } else { &Entry::Redo }); }
                        fields(json!({ "caret": caret(at) }))
                    }
                    None => fields(json!({ "none": true })),   // nothing happened, so nothing is journaled
                };
                Ok(with_state(doc, f))
            }
            "text" => {
                let a: TextArgs = args(req)?;
                let (doc, _) = self.open_doc(a.doc)?;
                let text = doc.text(a.start.pos(), a.end.pos())?;
                Ok(with_state(doc, fields(json!({ "text": text }))))
            }
            "find" => {
                let a: FindArgs = args(req)?;
                let (doc, _) = self.open_doc(a.doc)?;
                let hit = serde_json::to_value(doc.find(&a.query, a.match_case, a.from.pos(), a.backward)).map_err(|_| INTERNAL.to_string())?;
                Ok(with_state(doc, fields(json!({ "hit": hit }))))
            }
            "count" => {
                let a: CountArgs = args(req)?;
                let (doc, _) = self.open_doc(a.doc)?;
                let (count, capped) = doc.count(&a.query, a.match_case);
                Ok(with_state(doc, fields(json!({ "count": count, "capped": capped }))))
            }
            "save" => {
                let a: DocArgs = args(req)?;
                let (doc, journal) = self.open_doc(a.doc)?;
                let bytes = doc.save()?;   // a failed save returns here and leaves the journal alone
                match (journal.as_mut(), doc.stamp()) {
                    (Some(j), Some(stamp)) => j.restart(stamp),
                    (Some(j), None) => { j.delete(); *journal = None; }
                    (None, _) => {}
                }
                Ok(with_state(doc, fields(json!({ "bytes": bytes }))))
            }
            "changed" => {
                let a: DocArgs = args(req)?;
                let (doc, _) = self.open_doc(a.doc)?;
                Ok(with_state(doc, fields(json!({ "changed": doc.changed_on_disk() }))))
            }
            #[cfg(test)]
            "__panic" => panic!("test panic"),
            _ => Err(BAD_REQUEST.to_string()),
        }
    }

    fn open_doc(&mut self, id: u64) -> Result<&mut Open, String> {
        u32::try_from(id).ok().and_then(|id| self.docs.get_mut(&id)).ok_or_else(|| NOT_OPEN.to_string())
    }

    /// Opens `path` as a new document. If the same path (compared as given) is already open, that
    /// document is dropped first and its journal file is left on disk: the new document replays
    /// it, so the unsaved edits carry over and two documents never share one journal.
    fn open(&mut self, path: &Path) -> Result<Fields, String> {
        self.docs.retain(|_, (doc, _)| doc.path().map(Path::as_os_str) != Some(path.as_os_str()));
        let mut doc = Doc::load(path)?;
        let (journal, recovered) = self.start_journal(&mut doc);
        let id = self.fresh_id();
        let mut f = fields(json!({ "doc": id }));
        f.extend(open_fields(&doc, recovered));
        let f = with_state(&doc, f);
        self.docs.insert(id, (doc, journal));
        Ok(f)
    }

    /// The next document id that is not in use (ids start at 1 and skip any still open on wrap-around).
    fn fresh_id(&mut self) -> u32 {
        while self.docs.contains_key(&self.next_id) { self.next_id = self.next_id.wrapping_add(1).max(1); }
        let id = self.next_id;
        self.next_id = id.wrapping_add(1).max(1);
        id
    }

    /// The journal of a freshly opened document, with whatever it held replayed into the text.
    /// Replay comes first, always: `append` trusts the header of a file that exists, so only a
    /// replay (which deletes a journal that does not match) makes it safe to append. There is no
    /// journal without a journal folder, a stamp, or for a read-only document. Returns the journal
    /// and whether at least one entry was applied.
    fn start_journal(&self, doc: &mut Doc) -> (Option<Journal>, bool) {
        let Some(mut journal) = self.new_journal(doc) else { return (None, false) };
        let applied = journal.replay(doc);
        (Some(journal), applied > 0)
    }

    fn new_journal(&self, doc: &Doc) -> Option<Journal> {
        let dir = self.journal_dir.as_deref()?;
        let path = doc.path()?;
        let stamp = doc.stamp()?;
        if doc.read_only() { return None; }
        let path = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
        Some(Journal::for_doc(dir, &path, stamp))
    }

    fn reload(&mut self, id: u64) -> Result<Fields, String> {
        let id32 = u32::try_from(id).map_err(|_| NOT_OPEN.to_string())?;
        let (mut doc, old) = self.docs.remove(&id32).ok_or_else(|| NOT_OPEN.to_string())?;
        let result = doc.reload();
        // The reloaded text is the file as it is now, so the journal starts over with its stamp.
        // A failed reload changes nothing, so the old journal is kept as it was.
        let journal = if result.is_err() { old } else {
            match (old, doc.stamp(), doc.read_only()) {
                (Some(mut j), Some(stamp), false) => { j.restart(stamp); Some(j) }
                (Some(mut j), _, _) => { j.delete(); None }
                (None, _, _) => self.new_journal(&doc).map(|mut j| { j.delete(); j }),   // no journal yet: start one, removing any file an earlier run left for this path
            }
        };
        let answer = result.map(|()| {
            let mut f = fields(json!({ "doc": id32 }));
            f.extend(open_fields(&doc, false));
            with_state(&doc, f)
        });
        self.docs.insert(id32, (doc, journal));
        answer
    }

    fn close(&mut self, id: u64) -> Result<Fields, String> {
        let (_, journal) = u32::try_from(id).ok().and_then(|id| self.docs.remove(&id)).ok_or_else(|| NOT_OPEN.to_string())?;
        if let Some(mut j) = journal { j.delete(); }
        Ok(Fields::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::doc::{check_size, MAX_BYTES};
    use crate::testutil::TempDir;
    use serde_json::{json, Value};

    fn call(e: &mut Engine, v: Value) -> Value {
        serde_json::from_str(&e.handle(&serde_json::to_string(&v).unwrap())).unwrap()
    }
    fn edit(id: u64, line: u64, col: u64, text: &str) -> Value {
        json!({"id":id,"op":"edit","doc":1,"start":{"line":line,"col":col},"end":{"line":line,"col":col},"text":text,"kind":"type"})
    }
    fn journal_files(dir: &std::path::Path) -> usize { std::fs::read_dir(dir).unwrap().count() }

    #[test] fn open_lines_edit_save_close() {
        let t = TempDir::new(); let f = t.file("f.txt", b"ab\ncd"); let mut e = Engine::new(None);
        let o = call(&mut e, json!({"id":1,"op":"open","path":f}));
        assert_eq!(o, json!({"id":1,"ok":true,"doc":1,"bytes":5,"eol":"\n","readOnly":false,"recovered":false,"rev":0,"lines":2,"dirty":false}));
        assert_eq!(call(&mut e, json!({"id":2,"op":"lines","doc":1,"first":1,"count":5}))["items"], json!([{"text":"cd","len":2}]));
        let r = call(&mut e, json!({"id":3,"op":"edit","doc":1,"start":{"line":0,"col":2},"end":{"line":0,"col":2},"text":"!","kind":"type"}));
        assert_eq!(r, json!({"id":3,"ok":true,"caret":{"line":0,"col":3},"rev":1,"lines":2,"dirty":true}));
        assert_eq!(call(&mut e, json!({"id":4,"op":"save","doc":1}))["dirty"], json!(false));
        assert_eq!(std::fs::read(&f).unwrap(), b"ab!\ncd");
        assert_eq!(call(&mut e, json!({"id":5,"op":"close","doc":1}))["ok"], json!(true));
        assert_eq!(call(&mut e, json!({"id":6,"op":"lines","doc":1,"first":0,"count":1})), json!({"id":6,"ok":false,"error":"That file isn't open"}));
    }
    #[test] fn undo_with_nothing_to_undo() {
        let t = TempDir::new(); let f = t.file("f.txt", b"ab"); let mut e = Engine::new(None);
        call(&mut e, json!({"id":1,"op":"open","path":f}));
        let u = call(&mut e, json!({"id":2,"op":"undo","doc":1}));
        assert_eq!(u, json!({"id":2,"ok":true,"none":true,"rev":0,"lines":1,"dirty":false}));
        assert_eq!(call(&mut e, json!({"id":3,"op":"redo","doc":1}))["none"], json!(true));
    }
    #[test] fn undo_and_redo_return_the_caret() {
        let t = TempDir::new(); let f = t.file("f.txt", b"ab"); let mut e = Engine::new(None);
        call(&mut e, json!({"id":1,"op":"open","path":f}));
        call(&mut e, edit(2, 0, 2, "!"));
        let u = call(&mut e, json!({"id":3,"op":"undo","doc":1}));
        assert_eq!(u, json!({"id":3,"ok":true,"caret":{"line":0,"col":2},"rev":2,"lines":1,"dirty":true}));
        let r = call(&mut e, json!({"id":4,"op":"redo","doc":1}));
        assert_eq!(r["caret"], json!({"line":0,"col":3}));
    }
    #[test] fn find_and_count_shapes() {
        let t = TempDir::new(); let f = t.file("f.txt", b"ab\nAB ab"); let mut e = Engine::new(None);
        call(&mut e, json!({"id":1,"op":"open","path":f}));
        let h = call(&mut e, json!({"id":2,"op":"find","doc":1,"query":"ab","matchCase":true,"from":{"line":0,"col":1},"backward":false}));
        assert_eq!(h["hit"], json!({"line":1,"col":3,"len":2}));
        let h = call(&mut e, json!({"id":3,"op":"find","doc":1,"query":"zzz","matchCase":false,"from":{"line":0,"col":0},"backward":false}));
        assert_eq!(h["ok"], json!(true)); assert!(h["hit"].is_null());
        let c = call(&mut e, json!({"id":4,"op":"count","doc":1,"query":"ab","matchCase":false}));
        assert_eq!((c["count"].clone(), c["capped"].clone()), (json!(3), json!(false)));
    }
    #[test] fn text_returns_the_range() {
        let t = TempDir::new(); let f = t.file("f.txt", b"ab\r\ncd"); let mut e = Engine::new(None);
        call(&mut e, json!({"id":1,"op":"open","path":f}));
        let r = call(&mut e, json!({"id":2,"op":"text","doc":1,"start":{"line":0,"col":1},"end":{"line":1,"col":1}}));
        assert_eq!(r["text"], json!("b\nc"));
    }
    #[test] fn changed_reports_outside_edits_and_reload_picks_them_up() {
        let t = TempDir::new(); let f = t.file("f.txt", b"ab"); let mut e = Engine::new(None);
        call(&mut e, json!({"id":1,"op":"open","path":f}));
        assert_eq!(call(&mut e, json!({"id":2,"op":"changed","doc":1}))["changed"], json!(false));
        std::fs::write(&f, b"abcdef").unwrap();
        assert_eq!(call(&mut e, json!({"id":3,"op":"changed","doc":1}))["changed"], json!(true));
        let r = call(&mut e, json!({"id":4,"op":"reload","doc":1}));
        assert_eq!(r["bytes"], json!(6)); assert_eq!(r["recovered"], json!(false)); assert_eq!(r["doc"], json!(1));
        assert_eq!(call(&mut e, json!({"id":5,"op":"changed","doc":1}))["changed"], json!(false));
    }
    #[test] fn read_only_edit_is_refused_with_the_message() {
        let t = TempDir::new(); let f = t.file("f.bin", &[b'a', 0xFF]); let mut e = Engine::new(None);
        assert_eq!(call(&mut e, json!({"id":1,"op":"open","path":f}))["readOnly"], json!(true));
        assert_eq!(call(&mut e, edit(2, 0, 0, "x")), json!({"id":2,"ok":false,"error":"This file isn't valid UTF-8, so it can't be edited here"}));
    }
    #[test] fn open_failure_is_an_error_reply() {
        let t = TempDir::new(); let mut e = Engine::new(None);
        let r = call(&mut e, json!({"id":1,"op":"open","path":t.path().join("missing.txt")}));
        assert_eq!(r["ok"], json!(false)); assert!(r["error"].as_str().unwrap().starts_with("Couldn't open that file"));
    }
    #[test] fn bad_requests_do_not_panic() {
        let mut e = Engine::new(None);
        assert_eq!(e.handle("not json"), r#"{"id":null,"ok":false,"error":"Bad request"}"#);
        assert_eq!(e.handle(""), r#"{"id":null,"ok":false,"error":"Bad request"}"#);
        assert_eq!(e.handle("[1,2]"), r#"{"id":null,"ok":false,"error":"Bad request"}"#);
        assert_eq!(call(&mut e, json!({"id":9,"op":"nope"})), json!({"id":9,"ok":false,"error":"Bad request"}));
        assert_eq!(call(&mut e, json!({"id":9})), json!({"id":9,"ok":false,"error":"Bad request"}));
        assert_eq!(call(&mut e, json!({"id":9,"op":"lines","doc":1}))["ok"], json!(false));   // missing fields
        assert_eq!(call(&mut e, json!({"id":9,"op":"open"}))["ok"], json!(false));
    }
    #[test] fn replies_put_id_then_ok_first() {
        let t = TempDir::new(); let f = t.file("f.txt", b"ab"); let mut e = Engine::new(None);
        let line = e.handle(&json!({"id":"x7","op":"open","path":f}).to_string());
        assert!(line.starts_with(r#"{"id":"x7","ok":true,"doc":1,"#), "{line}");
    }
    #[test] fn wild_positions_do_not_panic() {
        let t = TempDir::new(); let f = t.file("f.txt", "a😀\n".as_bytes()); let mut e = Engine::new(None);
        call(&mut e, json!({"id":1,"op":"open","path":f}));
        for (l, c) in [(u32::MAX as u64, 0u64), (0, u32::MAX as u64), (0, 2), (5, 5), (u64::MAX, u64::MAX)] {
            assert_eq!(call(&mut e, json!({"id":2,"op":"edit","doc":1,"start":{"line":l,"col":c},"end":{"line":l,"col":c},"text":"x","kind":"type"}))["ok"], json!(true));
            assert_eq!(call(&mut e, json!({"id":3,"op":"lines","doc":1,"first":l,"count":u32::MAX}))["ok"], json!(true));
            assert_eq!(call(&mut e, json!({"id":4,"op":"lines","doc":1,"first":0,"count":u64::MAX}))["ok"], json!(true));
            assert_eq!(call(&mut e, json!({"id":5,"op":"text","doc":1,"start":{"line":l,"col":c},"end":{"line":0,"col":0}}))["ok"], json!(true));
            assert_eq!(call(&mut e, json!({"id":6,"op":"find","doc":1,"query":"x","matchCase":false,"from":{"line":l,"col":c},"backward":false}))["ok"], json!(true));
        }
    }
    #[test] fn crash_then_open_recovers() {
        let t = TempDir::new(); let f = t.file("f.txt", b"ab"); let jd = t.dir("j");
        { let mut e = Engine::new(Some(jd.clone())); call(&mut e, json!({"id":1,"op":"open","path":f})); call(&mut e, json!({"id":2,"op":"edit","doc":1,"start":{"line":0,"col":0},"end":{"line":0,"col":0},"text":"X","kind":"type"})); }
        let mut e = Engine::new(Some(jd)); let o = call(&mut e, json!({"id":1,"op":"open","path":f}));
        assert_eq!(o["recovered"], json!(true)); assert_eq!(o["dirty"], json!(true));
        assert_eq!(call(&mut e, json!({"id":2,"op":"lines","doc":1,"first":0,"count":1}))["items"][0]["text"], json!("Xab"));
    }
    #[test] fn undo_and_redo_are_journaled_and_replayed() {
        let t = TempDir::new(); let f = t.file("f.txt", b"ab"); let jd = t.dir("j");
        { let mut e = Engine::new(Some(jd.clone())); call(&mut e, json!({"id":1,"op":"open","path":f}));
          call(&mut e, edit(2, 0, 0, "X")); call(&mut e, edit(3, 0, 1, "Y"));
          call(&mut e, json!({"id":4,"op":"undo","doc":1}));
          call(&mut e, json!({"id":5,"op":"undo","doc":1}));
          call(&mut e, json!({"id":6,"op":"redo","doc":1}));
          call(&mut e, json!({"id":7,"op":"redo","doc":1})); }
        let mut e = Engine::new(Some(jd)); let o = call(&mut e, json!({"id":1,"op":"open","path":f}));
        assert_eq!(o["recovered"], json!(true));
        assert_eq!(call(&mut e, json!({"id":2,"op":"lines","doc":1,"first":0,"count":1}))["items"][0]["text"], json!("XYab"));
    }
    #[test] fn nothing_to_undo_is_not_journaled() {
        let t = TempDir::new(); let f = t.file("f.txt", b"ab"); let jd = t.dir("j"); let mut e = Engine::new(Some(jd.clone()));
        call(&mut e, json!({"id":1,"op":"open","path":f}));
        call(&mut e, json!({"id":2,"op":"undo","doc":1}));
        assert_eq!(journal_files(&jd), 0);
    }
    #[test] fn stale_journal_is_not_extended() {
        let t = TempDir::new(); let f = t.file("f.txt", b"ab"); let jd = t.dir("j");
        { let mut e = Engine::new(Some(jd.clone())); call(&mut e, json!({"id":1,"op":"open","path":f})); call(&mut e, edit(2, 0, 0, "X")); }
        std::fs::write(&f, b"different").unwrap();   // the file changed under the journal
        let mut e = Engine::new(Some(jd.clone()));
        let o = call(&mut e, json!({"id":1,"op":"open","path":f}));
        assert_eq!(o["recovered"], json!(false)); assert_eq!(o["dirty"], json!(false));
        call(&mut e, edit(2, 0, 0, "Z"));
        drop(e);
        let mut e = Engine::new(Some(jd)); let o = call(&mut e, json!({"id":1,"op":"open","path":f}));
        assert_eq!(o["recovered"], json!(true));
        assert_eq!(call(&mut e, json!({"id":2,"op":"lines","doc":1,"first":0,"count":1}))["items"][0]["text"], json!("Zdifferent"));
    }
    #[test] fn close_deletes_the_journal_and_save_restarts_it() {
        let t = TempDir::new(); let f = t.file("f.txt", b"ab"); let jd = t.dir("j"); let mut e = Engine::new(Some(jd.clone()));
        call(&mut e, json!({"id":1,"op":"open","path":f}));
        assert_eq!(journal_files(&jd), 0);
        call(&mut e, edit(2, 0, 0, "X")); assert_eq!(journal_files(&jd), 1);
        call(&mut e, json!({"id":3,"op":"save","doc":1})); assert_eq!(journal_files(&jd), 0);
        call(&mut e, edit(4, 0, 0, "Y")); assert_eq!(journal_files(&jd), 1);
        call(&mut e, json!({"id":5,"op":"close","doc":1})); assert_eq!(journal_files(&jd), 0);
    }
    #[test] fn failed_save_keeps_the_journal() {
        let t = TempDir::new(); let f = t.file("f.txt", b"ab"); let jd = t.dir("j"); let mut e = Engine::new(Some(jd.clone()));
        call(&mut e, json!({"id":1,"op":"open","path":f}));
        call(&mut e, edit(2, 0, 0, "X"));
        std::fs::remove_file(&f).unwrap(); std::fs::create_dir(&f).unwrap();   // the path is now a folder: the rename cannot land
        assert_eq!(call(&mut e, json!({"id":3,"op":"save","doc":1}))["ok"], json!(false));
        assert_eq!(journal_files(&jd), 1);
    }
    #[test] fn reload_restarts_the_journal() {
        let t = TempDir::new(); let f = t.file("f.txt", b"ab"); let jd = t.dir("j"); let mut e = Engine::new(Some(jd.clone()));
        call(&mut e, json!({"id":1,"op":"open","path":f}));
        call(&mut e, edit(2, 0, 0, "X")); assert_eq!(journal_files(&jd), 1);
        std::fs::write(&f, b"other").unwrap();
        let r = call(&mut e, json!({"id":3,"op":"reload","doc":1}));
        assert_eq!((r["recovered"].clone(), r["dirty"].clone()), (json!(false), json!(false)));
        assert_eq!(journal_files(&jd), 0);
        call(&mut e, edit(4, 0, 0, "Q")); assert_eq!(journal_files(&jd), 1);
        drop(e);
        let mut e = Engine::new(Some(jd));
        assert_eq!(call(&mut e, json!({"id":1,"op":"open","path":f}))["recovered"], json!(true));
        assert_eq!(call(&mut e, json!({"id":2,"op":"lines","doc":1,"first":0,"count":1}))["items"][0]["text"], json!("Qother"));
    }
    #[test] fn read_only_documents_get_no_journal() {
        let t = TempDir::new(); let f = t.file("f.bin", &[0xFF]); let jd = t.dir("j"); let mut e = Engine::new(Some(jd.clone()));
        assert_eq!(call(&mut e, json!({"id":1,"op":"open","path":f}))["readOnly"], json!(true));
        assert!(e.docs[&1].1.is_none());
        call(&mut e, edit(2, 0, 0, "x"));
        assert!(e.docs[&1].1.is_none());
        assert_eq!(journal_files(&jd), 0);
        // an ordinary document in the same engine does get one
        let g = t.file("g.txt", b"ab");
        call(&mut e, json!({"id":3,"op":"open","path":g}));
        assert!(e.docs[&2].1.is_some());
    }
    #[test] fn find_and_count_require_all_their_fields() {
        let t = TempDir::new(); let f = t.file("f.txt", b"ab"); let mut e = Engine::new(None);
        call(&mut e, json!({"id":1,"op":"open","path":f}));
        let bad = json!({"id":2,"ok":false,"error":"Bad request"});
        assert_eq!(call(&mut e, json!({"id":2,"op":"find","doc":1,"query":"a","from":{"line":0,"col":0},"backward":false})), bad);
        assert_eq!(call(&mut e, json!({"id":2,"op":"find","doc":1,"query":"a","matchCase":true,"backward":false})), bad);
        assert_eq!(call(&mut e, json!({"id":2,"op":"find","doc":1,"query":"a","matchCase":true,"from":{"line":0,"col":0}})), bad);
        assert_eq!(call(&mut e, json!({"id":2,"op":"count","doc":1,"query":"a"})), bad);
        assert_eq!(call(&mut e, json!({"id":2,"op":"count","doc":1,"query":"a","matchCase":true}))["count"], json!(1));
    }
    #[test] fn opening_an_open_path_again_carries_the_unsaved_edits_over() {
        let t = TempDir::new(); let f = t.file("f.txt", b"ab"); let jd = t.dir("j"); let mut e = Engine::new(Some(jd.clone()));
        assert_eq!(call(&mut e, json!({"id":1,"op":"open","path":f}))["doc"], json!(1));
        call(&mut e, edit(2, 0, 0, "X"));
        let o = call(&mut e, json!({"id":3,"op":"open","path":f}));
        assert_eq!(o["doc"], json!(2));
        assert_eq!((o["recovered"].clone(), o["dirty"].clone()), (json!(true), json!(true)));
        assert_eq!(call(&mut e, json!({"id":4,"op":"lines","doc":2,"first":0,"count":1}))["items"][0]["text"], json!("Xab"));
        assert_eq!(call(&mut e, json!({"id":5,"op":"lines","doc":1,"first":0,"count":1})), json!({"id":5,"ok":false,"error":"That file isn't open"}));
        assert_eq!(journal_files(&jd), 1);
        // the new document keeps journaling into the same single file
        call(&mut e, json!({"id":6,"op":"edit","doc":2,"start":{"line":0,"col":0},"end":{"line":0,"col":0},"text":"Y","kind":"type"}));
        assert_eq!(journal_files(&jd), 1);
        drop(e);
        let mut e = Engine::new(Some(jd));
        call(&mut e, json!({"id":1,"op":"open","path":f}));
        assert_eq!(call(&mut e, json!({"id":2,"op":"lines","doc":1,"first":0,"count":1}))["items"][0]["text"], json!("YXab"));
    }
    #[test] fn opening_a_clean_open_path_again_is_not_recovered() {
        let t = TempDir::new(); let f = t.file("f.txt", b"ab"); let jd = t.dir("j"); let mut e = Engine::new(Some(jd.clone()));
        call(&mut e, json!({"id":1,"op":"open","path":f}));
        let o = call(&mut e, json!({"id":2,"op":"open","path":f}));
        assert_eq!((o["doc"].clone(), o["recovered"].clone(), o["dirty"].clone()), (json!(2), json!(false), json!(false)));
        assert_eq!(call(&mut e, json!({"id":3,"op":"lines","doc":1,"first":0,"count":1}))["error"], json!("That file isn't open"));
        assert_eq!(journal_files(&jd), 0);
    }
    #[test] fn too_large_is_refused() {
        assert_eq!(check_size(MAX_BYTES), Ok(()));
        assert_eq!(check_size(MAX_BYTES + 1), Err("This file is larger than 2 GB".to_string()));
    }
    #[test] fn a_panic_is_answered_and_drops_the_named_document() {
        let t = TempDir::new(); let f = t.file("f.txt", b"ab"); let mut e = Engine::new(None);
        call(&mut e, json!({"id":1,"op":"open","path":f}));
        assert_eq!(call(&mut e, json!({"id":2,"op":"__panic","doc":1})), json!({"id":2,"ok":false,"error":"The engine hit an internal error"}));
        assert_eq!(call(&mut e, json!({"id":3,"op":"lines","doc":1,"first":0,"count":1}))["error"], json!("That file isn't open"));
        assert_eq!(call(&mut e, json!({"id":4,"op":"open","path":f}))["doc"], json!(2));   // the engine keeps serving
    }
    #[test] fn edit_kind_wire_names() {
        use crate::doc::EditKind;
        assert_eq!(serde_json::to_string(&EditKind::Type).unwrap(), r#""type""#);
        assert_eq!(serde_json::to_string(&EditKind::Delete).unwrap(), r#""delete""#);
        assert_eq!(serde_json::to_string(&EditKind::Paste).unwrap(), r#""paste""#);
        assert_eq!(serde_json::to_string(&EditKind::Other).unwrap(), r#""other""#);
        let t = TempDir::new(); let f = t.file("f.txt", b"abcd"); let mut e = Engine::new(None);
        call(&mut e, json!({"id":1,"op":"open","path":f}));
        for kind in ["type", "delete", "paste", "other"] {
            let r = call(&mut e, json!({"id":2,"op":"edit","doc":1,"start":{"line":0,"col":0},"end":{"line":0,"col":0},"text":"x","kind":kind}));
            assert_eq!(r["ok"], json!(true), "{kind}");
        }
        let r = call(&mut e, json!({"id":3,"op":"edit","doc":1,"start":{"line":0,"col":0},"end":{"line":0,"col":0},"text":"x","kind":"Type"}));
        assert_eq!(r["ok"], json!(false));
    }
}
