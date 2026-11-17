//! Breeze Agent's hands: the mouse and keyboard for Device Control.
//! Reads one JSON request per line on stdin and answers each with one JSON line on stdout, the same way the
//! document engine does. It runs as its own process so an Electron update can never break it, and so the kill
//! switch can stop every click and keystroke at once by ending this one process.
//! The rules (what may be typed, where, at which Control level) live in Breeze (deviceguard.ts); this only acts.

use std::io::{self, BufRead, Write};

use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use serde_json::{json, Value};

const MAX_TEXT: usize = 4000;
const MAX_KEYS: usize = 6;

fn button(name: &str) -> Result<Button, String> {
    match name {
        "" | "left" => Ok(Button::Left),
        "right" => Ok(Button::Right),
        "middle" => Ok(Button::Middle),
        other => Err(format!("There is no mouse button called {other}")),
    }
}

/// One key name from a combo like "ctrl+shift+t".
fn key(name: &str) -> Result<Key, String> {
    let n = name.trim().to_ascii_lowercase();
    Ok(match n.as_str() {
        "ctrl" | "control" => Key::Control,
        "shift" => Key::Shift,
        "alt" | "option" => Key::Alt,
        "win" | "meta" | "cmd" | "super" => Key::Meta,
        "enter" | "return" => Key::Return,
        "tab" => Key::Tab,
        "space" => Key::Space,
        "esc" | "escape" => Key::Escape,
        "backspace" => Key::Backspace,
        "delete" | "del" => Key::Delete,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        "up" => Key::UpArrow,
        "down" => Key::DownArrow,
        "left" => Key::LeftArrow,
        "right" => Key::RightArrow,
        "capslock" => Key::CapsLock,
        "volumeup" => Key::VolumeUp,
        "volumedown" => Key::VolumeDown,
        "mute" | "volumemute" => Key::VolumeMute,
        "f1" => Key::F1, "f2" => Key::F2, "f3" => Key::F3, "f4" => Key::F4, "f5" => Key::F5, "f6" => Key::F6,
        "f7" => Key::F7, "f8" => Key::F8, "f9" => Key::F9, "f10" => Key::F10, "f11" => Key::F11, "f12" => Key::F12,
        _ => {
            let mut chars = n.chars();
            match (chars.next(), chars.next()) {
                (Some(c), None) => Key::Unicode(c),
                _ => return Err(format!("There is no key called {name}")),
            }
        }
    })
}

fn num(req: &Value, k: &str) -> Result<i32, String> {
    req.get(k).and_then(Value::as_f64).filter(|v| v.is_finite() && v.abs() < 100_000.0).map(|v| v.round() as i32)
        .ok_or_else(|| format!("{k} must be a number"))
}
fn text<'a>(req: &'a Value, k: &str) -> &'a str { req.get(k).and_then(Value::as_str).unwrap_or("") }

fn handle(enigo: &mut Option<Enigo>, req: &Value) -> Result<Value, String> {
    let op = text(req, "op");
    if op == "ping" { return Ok(json!({ "version": env!("CARGO_PKG_VERSION") })); }
    // Made on first use: on a machine with no display it fails here, with the reason, instead of at start-up.
    if enigo.is_none() { *enigo = Some(Enigo::new(&Settings::default()).map_err(|e| format!("Can't reach the mouse and keyboard: {e}"))?); }
    let e = enigo.as_mut().unwrap();
    let fail = |err: enigo::InputError| err.to_string();
    match op {
        "size" => { let (w, h) = e.main_display().map_err(fail)?; Ok(json!({ "width": w, "height": h })) }
        "cursor" => { let (x, y) = e.location().map_err(fail)?; Ok(json!({ "x": x, "y": y })) }
        "move" => { e.move_mouse(num(req, "x")?, num(req, "y")?, Coordinate::Abs).map_err(fail)?; Ok(json!({})) }
        "click" => {
            if req.get("x").is_some() { e.move_mouse(num(req, "x")?, num(req, "y")?, Coordinate::Abs).map_err(fail)?; }
            let b = button(text(req, "button"))?;
            let times = if req.get("double").and_then(Value::as_bool) == Some(true) { 2 } else { 1 };
            for _ in 0..times { e.button(b, Direction::Click).map_err(fail)?; }
            Ok(json!({}))
        }
        "scroll" => {
            let dy = req.get("dy").map(|_| num(req, "dy")).transpose()?.unwrap_or(0);
            let dx = req.get("dx").map(|_| num(req, "dx")).transpose()?.unwrap_or(0);
            if dy != 0 { e.scroll(dy.clamp(-50, 50), Axis::Vertical).map_err(fail)?; }
            if dx != 0 { e.scroll(dx.clamp(-50, 50), Axis::Horizontal).map_err(fail)?; }
            Ok(json!({}))
        }
        "type" => {
            let t = text(req, "text");
            if t.chars().count() > MAX_TEXT { return Err(format!("Type at most {MAX_TEXT} characters at a time")); }
            e.text(t).map_err(fail)?;
            Ok(json!({}))
        }
        "key" => {
            let combo = text(req, "keys");
            let keys = combo.split('+').filter(|s| !s.trim().is_empty()).map(key).collect::<Result<Vec<_>, _>>()?;
            if keys.is_empty() || keys.len() > MAX_KEYS { return Err("keys must name 1 to 6 keys, like ctrl+s".into()); }
            let (last, mods) = keys.split_last().unwrap();
            // Held in order, the last one clicked, released in reverse: a modifier is never left stuck down.
            let mut held = Vec::new();
            let mut result = Ok(());
            for m in mods { match e.key(*m, Direction::Press) { Ok(()) => held.push(*m), Err(err) => { result = Err(fail(err)); break; } } }
            if result.is_ok() { result = e.key(*last, Direction::Click).map_err(fail); }
            for m in held.iter().rev() { let _ = e.key(*m, Direction::Release); }
            result.map(|_| json!({}))
        }
        other => Err(format!("Unknown request: {other}")),
    }
}

fn main() {
    std::panic::set_hook(Box::new(|info| { let _ = writeln!(io::stderr(), "breeze-hands: {info}"); }));
    let mut enigo: Option<Enigo> = None;
    let stdin = io::stdin();
    let mut out = io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() { continue; }
        let reply = match serde_json::from_str::<Value>(&line) {
            Err(_) => json!({ "id": null, "ok": false, "error": "Not JSON" }),
            Ok(req) => {
                let id = req.get("id").cloned().unwrap_or(Value::Null);
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handle(&mut enigo, &req))) {
                    Ok(Ok(Value::Object(mut m))) => { m.insert("id".into(), id); m.insert("ok".into(), Value::Bool(true)); Value::Object(m) }
                    Ok(Ok(_)) => json!({ "id": id, "ok": true }),
                    Ok(Err(error)) => json!({ "id": id, "ok": false, "error": error }),
                    Err(_) => { enigo = None; json!({ "id": id, "ok": false, "error": "The hands stopped on that request" }) }
                }
            }
        };
        if writeln!(out, "{reply}").and_then(|_| out.flush()).is_err() { break; }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_names() {
        assert!(matches!(key("Ctrl"), Ok(Key::Control)));
        assert!(matches!(key("enter"), Ok(Key::Return)));
        assert!(matches!(key("s"), Ok(Key::Unicode('s'))));
        assert!(key("hyper").is_err());
        assert!(button("left").is_ok());
        assert!(button("side").is_err());
    }

    #[test]
    fn ping_needs_no_display() {
        let mut e = None;
        let r = handle(&mut e, &json!({ "op": "ping" })).unwrap();
        assert_eq!(r["version"], env!("CARGO_PKG_VERSION"));
        assert!(e.is_none());
    }

    #[test]
    fn bad_numbers_are_refused() {
        assert!(num(&json!({ "x": "a" }), "x").is_err());
        assert!(num(&json!({ "x": 1e9 }), "x").is_err());
        assert_eq!(num(&json!({ "x": 12.6 }), "x"), Ok(13));
    }
}
