//! Large-file tests, run in release mode by `npm run test:engine`. They write big files to the OS
//! temp dir and remove them afterwards, also when an assertion fails.

use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

use breeze_engine::proto::Engine;
use serde_json::{json, Value};

/// A file in the temp dir that is removed on drop.
struct TempFile(PathBuf);

impl TempFile {
    fn new(name: &str) -> TempFile {
        TempFile(std::env::temp_dir().join(format!("breeze-engine-big-{}-{name}", std::process::id())))
    }
    fn path(&self) -> &Path { &self.0 }
}

impl Drop for TempFile {
    fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); }
}

fn call(e: &mut Engine, v: Value) -> Value {
    let reply = e.handle(&v.to_string());
    serde_json::from_str(&reply).expect("the reply is JSON")
}

/// The text of line `i` as the generator wrote it.
fn generated(i: u64) -> String { format!("line {i:08}") }

fn texts(e: &mut Engine, first: u64, count: u64) -> Vec<String> {
    let r = call(e, json!({"id":0,"op":"lines","doc":1,"first":first,"count":count}));
    assert_eq!(r["ok"], json!(true), "{r}");
    r["items"].as_array().unwrap().iter().map(|l| l["text"].as_str().unwrap().to_string()).collect()
}

#[test] #[ignore]
fn two_hundred_megabytes() {
    const LINES: u64 = 14_500_000;   // 14 bytes each: about 203 MB
    let file = TempFile::new("200mb.txt");
    {
        let mut w = BufWriter::with_capacity(1 << 20, std::fs::File::create(file.path()).unwrap());
        for i in 0..LINES { writeln!(w, "{}", generated(i)).unwrap(); }
        w.flush().unwrap();
    }
    let size = std::fs::metadata(file.path()).unwrap().len();
    assert_eq!(size, LINES * 14);

    let mut e = Engine::new(None);
    let o = call(&mut e, json!({"id":1,"op":"open","path":file.path()}));
    assert_eq!(o["ok"], json!(true), "{o}");
    assert_eq!(o["lines"], json!(LINES + 1));   // the final newline leaves an empty last line
    assert_eq!(o["bytes"], json!(size));

    let last = texts(&mut e, LINES - 49, 50);
    assert_eq!(last.len(), 50);
    assert_eq!(last[0], generated(LINES - 49));
    assert_eq!(last[48], generated(LINES - 1));
    assert_eq!(last[49], "");

    let first_edit = call(&mut e, json!({"id":2,"op":"edit","doc":1,"start":{"line":0,"col":0},"end":{"line":0,"col":0},"text":"AAAAA","kind":"type"}));
    assert_eq!(first_edit["ok"], json!(true));
    let last_edit = call(&mut e, json!({"id":3,"op":"edit","doc":1,"start":{"line":LINES - 1,"col":0},"end":{"line":LINES - 1,"col":0},"text":"ZZZZZ","kind":"type"}));
    assert_eq!(last_edit["ok"], json!(true));
    let saved = call(&mut e, json!({"id":4,"op":"save","doc":1}));
    assert_eq!(saved["ok"], json!(true), "{saved}");
    assert_eq!(saved["bytes"], json!(size + 10));
    assert_eq!(saved["dirty"], json!(false));
    drop(e);

    let mut e = Engine::new(None);
    let o = call(&mut e, json!({"id":1,"op":"open","path":file.path()}));
    assert_eq!(o["lines"], json!(LINES + 1));
    assert_eq!(o["bytes"], json!(size + 10));
    assert_eq!(texts(&mut e, 0, 3), [format!("AAAAA{}", generated(0)), generated(1), generated(2)]);
    let mid = LINES / 2;
    assert_eq!(texts(&mut e, mid, 3), [generated(mid), generated(mid + 1), generated(mid + 2)]);
    assert_eq!(texts(&mut e, LINES - 3, 5), [generated(LINES - 3), generated(LINES - 2), format!("ZZZZZ{}", generated(LINES - 1)), String::new()]);
}

#[test] #[ignore]
fn sixty_megabyte_single_line() {
    const LEN: usize = 60 * 1024 * 1024;
    let file = TempFile::new("60mb-line.txt");
    std::fs::write(file.path(), vec![b'x'; LEN]).unwrap();

    let mut e = Engine::new(None);
    let o = call(&mut e, json!({"id":1,"op":"open","path":file.path()}));
    assert_eq!(o["ok"], json!(true), "{o}");
    assert_eq!(o["lines"], json!(1));

    let started = Instant::now();
    let r = call(&mut e, json!({"id":2,"op":"lines","doc":1,"first":0,"count":1}));
    let took = started.elapsed();
    assert_eq!(r["items"][0]["text"].as_str().unwrap().len(), 10_000);
    assert_eq!(r["items"][0]["len"], json!(LEN));
    assert!(took.as_millis() < 200, "lines took {took:?}");

    let edit = call(&mut e, json!({"id":3,"op":"edit","doc":1,"start":{"line":0,"col":5},"end":{"line":0,"col":5},"text":"Y","kind":"type"}));
    assert_eq!(edit["ok"], json!(true), "{edit}");
    assert_eq!(edit["caret"], json!({"line":0,"col":6}));
    let r = call(&mut e, json!({"id":4,"op":"lines","doc":1,"first":0,"count":1}));
    assert!(r["items"][0]["text"].as_str().unwrap().starts_with("xxxxxY"));
    assert_eq!(r["items"][0]["len"], json!(LEN + 1));
}
