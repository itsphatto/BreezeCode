//! The Breeze document engine: reads one JSON request per line on stdin and answers each with one
//! JSON line on stdout. stdout carries replies and nothing else. Exits 0 when stdin closes.

use std::io::{self, BufRead, Write};
use std::path::PathBuf;

use breeze_engine::proto::Engine;

/// The folder given after `--journal-dir`, created if it does not exist. Without a usable
/// folder the engine runs with no crash journal.
fn journal_dir() -> Option<PathBuf> {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--journal-dir" {
            let dir = PathBuf::from(args.next()?);
            return match std::fs::create_dir_all(&dir) {
                Ok(()) => Some(dir),
                Err(e) => { let _ = writeln!(io::stderr(), "breeze-engine: no crash journal, {}: {e}", dir.display()); None }
            };
        }
    }
    None
}

fn main() {
    // A panic inside a request is caught and answered by the engine. The hook only keeps the
    // message off stdout (stderr is fine), where it would corrupt the reply stream.
    std::panic::set_hook(Box::new(|info| { let _ = writeln!(io::stderr(), "breeze-engine: {info}"); }));

    let mut engine = Engine::new(journal_dir());
    let mut input = io::stdin().lock();
    let mut out = io::stdout().lock();
    let mut line = Vec::new();
    loop {
        line.clear();
        match input.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let mut reply = engine.handle_bytes(&line);
        reply.push('\n');
        if out.write_all(reply.as_bytes()).and_then(|_| out.flush()).is_err() { break; }   // the other end is gone
    }
}
