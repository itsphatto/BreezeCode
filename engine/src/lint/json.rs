//! A small JSON parser that reports where the first mistake is (the page's `JsonChecker`). `loose`
//! allows comments and trailing commas (tsconfig and friends).

use super::{at, char_at, diag, index_of, is, is_digit, is_word, line_end, starts_with, RawDiag};

/// Nesting deeper than this is not checked: the parser recurses, and a stack overflow would take
/// the whole engine down. (The page's checker throws a RangeError there and reports nothing too.)
const MAX_DEPTH: usize = 1000;

pub fn check(t: &[u16], loose: bool) -> Vec<RawDiag> {
    let mut p = Parser { t, loose, i: 0, depth: 0 };
    match p.document() {
        Ok(()) | Err(Stop::TooDeep) => vec![],
        Err(Stop::Mistake(d)) => vec![d],
    }
}

enum Stop { Mistake(RawDiag), TooDeep }
type Step = Result<(), Stop>;

struct Parser<'a> { t: &'a [u16], loose: bool, i: usize, depth: usize }

fn is_json_space(c: u16) -> bool { c == b' ' as u16 || c == b'\n' as u16 || c == b'\t' as u16 || c == b'\r' as u16 }

impl Parser<'_> {
    fn document(&mut self) -> Step {
        self.ws()?;
        if self.ended() { return Ok(()); }
        self.value()?;
        self.ws()?;
        if !self.ended() { return self.fail("Unexpected text after the end of the JSON"); }
        Ok(())
    }

    fn ended(&self) -> bool { self.i >= self.t.len() }
    fn fail(&self, msg: impl Into<String>) -> Step { self.fail_at(msg, self.i, 1) }
    fn fail_at(&self, msg: impl Into<String>, at: usize, len: usize) -> Step { Err(Stop::Mistake(diag(at, len, msg))) }

    fn ws(&mut self) -> Step {
        let t = self.t;
        while !self.ended() {
            if is_json_space(t[self.i]) { self.i += 1; }
            else if self.loose && starts_with(t, self.i, "//") { self.i = line_end(t, self.i); }
            else if self.loose && starts_with(t, self.i, "/*") { self.skip_comment()?; }
            else { return Ok(()); }
        }
        Ok(())
    }

    fn skip_comment(&mut self) -> Step {
        match index_of(self.t, "*/", self.i + 2) {
            None => self.fail_at("Comment is never closed (missing */)", self.i, 2),
            Some(e) => { self.i = e + 2; Ok(()) }
        }
    }

    fn str(&mut self) -> Step {
        let t = self.t;
        let s = self.i;
        self.i += 1;
        while !self.ended() && !is(t, self.i, b'"') && !is(t, self.i, b'\n') { self.i += if is(t, self.i, b'\\') { 2 } else { 1 }; }
        if !is(t, self.i, b'"') { return self.fail_at("String is never closed (missing \")", s, (self.i - s).max(1)); }
        self.i += 1;
        Ok(())
    }

    /// The items of an object (`members`) or array, up to the closing bracket.
    fn list(&mut self, close: u8, members: bool) -> Step {
        self.depth += 1;
        if self.depth > MAX_DEPTH { return Err(Stop::TooDeep); }
        self.i += 1;
        self.ws()?;
        if is(self.t, self.i, close) { self.i += 1; self.depth -= 1; return Ok(()); }
        loop {
            if members { self.member()?; } else { self.value()?; }
            self.ws()?;
            if is(self.t, self.i, close) { self.i += 1; self.depth -= 1; return Ok(()); }
            if !is(self.t, self.i, b',') {
                let close = close as char;
                return self.fail(if self.ended() { format!("Expected '{close}' but the file ended") } else { format!("Expected ',' or '{close}'") });
            }
            let comma = self.i;
            self.i += 1;
            self.ws()?;
            if is(self.t, self.i, close) {
                if !self.loose { return self.fail_at("Trailing commas are not allowed in JSON", comma, 1); }
                self.i += 1;
                self.depth -= 1;
                return Ok(());
            }
        }
    }

    fn member(&mut self) -> Step {
        self.ws()?;
        if !is(self.t, self.i, b'"') {
            if self.ended() { return self.fail("Expected a property name but the file ended"); }
            let c = self.t[self.i];
            let named = c == b'\'' as u16 || c == b'$' as u16 || is_word(c);
            return self.fail(if named { "Property names need double quotes" } else { "Expected a property name" });
        }
        self.str()?;
        self.ws()?;
        if !is(self.t, self.i, b':') { return self.fail("Expected ':' after the property name"); }
        self.i += 1;
        self.value()
    }

    fn value(&mut self) -> Step {
        self.ws()?;
        let t = self.t;
        if is(t, self.i, b'{') { return self.list(b'}', true); }
        if is(t, self.i, b'[') { return self.list(b']', false); }
        if is(t, self.i, b'"') { return self.str(); }
        if let Some(w) = ["true", "false", "null"].into_iter().find(|w| starts_with(t, self.i, w)) { self.i += w.len(); return Ok(()); }
        let n = self.number();
        if n > 0 { self.i += n; return Ok(()); }
        if is(t, self.i, b'\'') { return self.fail("Strings need double quotes in JSON"); }
        if self.ended() { return self.fail("Expected a value but the file ended"); }
        self.fail(format!("Unexpected '{}'", char_at(t, self.i)))
    }

    /// The length of the number at `i` (`-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?`), or 0.
    fn number(&self) -> usize {
        let t = self.t;
        let mut j = self.i;
        if is(t, j, b'-') { j += 1; }
        if is(t, j, b'0') { j += 1; }
        else if is_digit(at(t, j)) { while is_digit(at(t, j)) { j += 1; } }
        else { return 0; }
        if is(t, j, b'.') && is_digit(at(t, j + 1)) { j += 2; while is_digit(at(t, j)) { j += 1; } }
        if is(t, j, b'e') || is(t, j, b'E') {
            let mut k = j + 1;
            if is(t, k, b'+') || is(t, k, b'-') { k += 1; }
            if is_digit(at(t, k)) { while is_digit(at(t, k)) { k += 1; } j = k; }
        }
        j - self.i
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lint::units;

    fn first(s: &str, loose: bool) -> Option<(usize, usize, String)> { check(&units(s), loose).into_iter().next().map(|d| (d.at, d.len, d.msg)) }

    #[test] fn good_json() {
        for s in ["", "  ", "{}", "[]", "{\"a\": [1, -2.5e3, true, null, \"x\\\"y\"]}", "0", "\"s\""] { assert_eq!(first(s, false), None, "{s}"); }
    }
    #[test] fn mistakes() {
        assert_eq!(first("{\"a\": 1,}", false), Some((7, 1, "Trailing commas are not allowed in JSON".into())));
        assert_eq!(first("{\"a\": 1,}", true), None);
        assert_eq!(first("{a: 1}", false), Some((1, 1, "Property names need double quotes".into())));
        assert_eq!(first("{\"a\" 1}", false), Some((5, 1, "Expected ':' after the property name".into())));
        assert_eq!(first("[1 2]", false), Some((3, 1, "Expected ',' or ']'".into())));
        assert_eq!(first("[1", false), Some((2, 1, "Expected ']' but the file ended".into())));
        assert_eq!(first("['x']", false), Some((1, 1, "Strings need double quotes in JSON".into())));
        assert_eq!(first("\"abc", false), Some((0, 4, "String is never closed (missing \")".into())));
        assert_eq!(first("1 2", false), Some((2, 1, "Unexpected text after the end of the JSON".into())));
        assert_eq!(first("[😀]", false), Some((1, 1, "Unexpected '😀'".into())));
        assert_eq!(first("[", false), Some((1, 1, "Expected a value but the file ended".into())));
        assert_eq!(first("// c\n{} /* x", true), Some((8, 2, "Comment is never closed (missing */)".into())));
        assert_eq!(first("-", false), Some((0, 1, "Unexpected '-'".into())));
    }
    #[test] fn deep_nesting_is_not_checked_and_does_not_overflow() {
        assert_eq!(first(&"[".repeat(200_000), false), None);
        assert_eq!(first(&format!("{}1,{}", "[".repeat(500), "]".repeat(500)), false), Some((501, 1, "Trailing commas are not allowed in JSON".into())));
    }
}
