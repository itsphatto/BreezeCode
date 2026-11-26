//! HTML (and strict XML/SVG): every element that needs a closing tag gets one, in the right order,
//! and the CSS and JavaScript inside <style> and <script> are checked on the way (the page's
//! `MarkupChecker`).

use super::code;
use super::{diag, index_of, is, is_space, is_word, starts_with, text, RawDiag};

const VOID_TAGS: [&str; 14] = ["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"];
const OPTIONAL_END: [&str; 21] = ["html", "head", "body", "p", "li", "dt", "dd", "option", "optgroup", "tr", "td", "th", "thead", "tbody", "tfoot", "colgroup", "caption", "rb", "rt", "rtc", "rp"];
const RAW_TAGS: [&str; 4] = ["script", "style", "textarea", "title"];
const JS_TYPES: [&str; 3] = ["module", "text/javascript", "application/javascript"];

pub fn check(t: &[u16], xml: bool) -> Vec<RawDiag> {
    let mut c = Checker { t, xml, out: Vec::new(), stack: Vec::new(), next: 0 };
    while let Some(m) = c.next_markup() { if !c.token(&m) { break; } }
    for s in std::mem::take(&mut c.stack) {
        if c.needs_end(&s.name) { c.out.push(diag(s.at, s.len, format!("<{}> is never closed", s.name))); }
    }
    c.out
}

/// One match of `<!--|<!\[CDATA\[|<[!?]|<\/?([A-Za-z][\w:.-]*)`: where it starts, its length, and
/// the tag name when it is a tag.
struct Markup { index: usize, len: usize, name: Option<(usize, usize)> }

struct OpenTag { name: String, at: usize, len: usize }

struct Checker<'a> {
    t: &'a [u16],
    xml: bool,
    out: Vec<RawDiag>,
    stack: Vec<OpenTag>,
    /// Where the next match is looked for (the page's `re.lastIndex`).
    next: usize,
}

fn is_letter(c: Option<u16>) -> bool { c.is_some_and(|c| c < 128 && (c as u8).is_ascii_alphabetic()) }
fn is_name_char(c: u16) -> bool { is_word(c) || c == b':' as u16 || c == b'.' as u16 || c == b'-' as u16 }

impl Checker<'_> {
    fn next_markup(&mut self) -> Option<Markup> {
        let t = self.t;
        let mut p = self.next;
        while p < t.len() {
            if t[p] == b'<' as u16 {
                if starts_with(t, p, "<!--") { return Some(Markup { index: p, len: 4, name: None }); }
                if starts_with(t, p, "<![CDATA[") { return Some(Markup { index: p, len: 9, name: None }); }
                if is(t, p + 1, b'!') || is(t, p + 1, b'?') { return Some(Markup { index: p, len: 2, name: None }); }
                let from = if is(t, p + 1, b'/') && is_letter(t.get(p + 2).copied()) { p + 2 }
                    else if is_letter(t.get(p + 1).copied()) { p + 1 } else { p = p + 1; continue; };
                let mut e = from + 1;
                while e < t.len() && is_name_char(t[e]) { e += 1; }
                return Some(Markup { index: p, len: e - p, name: Some((from, e)) });
            }
            p += 1;
        }
        None
    }

    fn needs_end(&self, name: &str) -> bool { self.xml || !OPTIONAL_END.contains(&name) }
    fn is_void(&self, name: &str) -> bool { !self.xml && VOID_TAGS.contains(&name) }

    /// Handles one match; false stops the scan (the rest of the file is unreadable).
    fn token(&mut self, m: &Markup) -> bool {
        let t = self.t;
        if starts_with(t, m.index, "<!--") && m.len == 4 { return self.skip_to(m, "-->", "Comment"); }
        if m.len == 9 && m.name.is_none() && starts_with(t, m.index, "<![CDATA[") { return self.skip_to(m, "]]>", "CDATA section"); }
        let Some((from, to)) = m.name else { return self.skip_to(m, ">", "Tag") };
        let Some(end) = self.tag_end(m, from, to) else { return true };
        let raw = text(&t[from..to]);
        let name = if self.xml { raw.clone() } else { raw.to_ascii_lowercase() };
        let tag = OpenTag { name, at: m.index, len: end + 1 - m.index };
        self.next = end + 1;
        if is(t, m.index + 1, b'/') { self.close_tag(tag, &raw); }
        else { self.open_tag(tag, m.len, m.index + m.len, end); }
        true
    }

    fn skip_to(&mut self, m: &Markup, end: &str, what: &str) -> bool {
        match index_of(self.t, end, m.index + m.len) {
            None => { self.out.push(diag(m.index, m.len, format!("{what} is never closed (missing {end})"))); false }
            Some(e) => { self.next = e + end.len(); true }
        }
    }

    /// The tag's '>', skipping quoted attribute values; None (and a problem) when there is none.
    fn tag_end(&mut self, m: &Markup, from: usize, to: usize) -> Option<usize> {
        let t = self.t;
        let mut j = m.index + m.len;
        let mut q: Option<u16> = None;
        while j < t.len() {
            let c = t[j];
            if let Some(open) = q { if c == open { q = None; } }
            else if c == b'"' as u16 || c == b'\'' as u16 { q = Some(c); }
            else if c == b'>' as u16 || c == b'<' as u16 { break; }
            j += 1;
        }
        if is(t, j, b'>') { return Some(j); }
        let msg = match q {
            Some(q) => format!("Attribute value is never closed (missing {})", q as u8 as char),
            None => format!("<{}> tag is never closed (missing >)", text(&t[from..to])),
        };
        self.out.push(diag(m.index, m.len, msg));
        self.next = j;
        None
    }

    fn close_tag(&mut self, tag: OpenTag, raw: &str) {
        if self.is_void(&tag.name) { self.out.push(diag(tag.at, tag.len, format!("<{raw}> never takes a closing tag"))); return; }
        let Some(k) = self.stack.iter().rposition(|s| s.name == tag.name) else {
            self.out.push(diag(tag.at, tag.len, format!("Unexpected </{raw}>: no <{raw}> is open here")));
            return;
        };
        for s in self.stack.split_off(k).into_iter().skip(1) {
            if self.needs_end(&s.name) {
                self.out.push(diag(s.at, s.len, format!("<{0}> is never closed (expected </{0}> before </{raw}>)", s.name)));
            }
        }
    }

    /// `attrs` is `attr_from..attr_to`: the text between the tag's name and its '>'.
    fn open_tag(&mut self, tag: OpenTag, name_len: usize, attr_from: usize, attr_to: usize) {
        let attrs = &self.t[attr_from..attr_to];
        if attrs.last() == Some(&(b'/' as u16)) || self.is_void(&tag.name) { return; }
        let raw_text = !self.xml && RAW_TAGS.contains(&tag.name.as_str());
        let name = tag.name.clone();
        self.stack.push(OpenTag { name: tag.name, at: tag.at, len: name_len });
        if raw_text { self.raw_text(&name, attrs); }
    }

    /// <script>, <style>…: skip to the closing tag, checking the code inside on the way.
    fn raw_text(&mut self, name: &str, attrs: &[u16]) {
        let t = self.t;
        let from = self.next;
        let close = format!("</{name}");
        let Some(end) = (from..t.len()).find(|&k| ascii_eq_ignore_case(t, k, &close)) else {
            self.next = t.len();   // reported as never closed
            return;
        };
        let ty = type_attr(attrs);
        let opts = match name {
            "style" => Some(code::CSS),
            "script" if ty.as_deref().is_none_or(|ty| JS_TYPES.contains(&ty)) => Some(code::JS),
            _ => None,
        };
        if let Some(opts) = opts {
            for d in code::scan(&t[from..end], opts).diags { self.out.push(RawDiag { at: d.at + from, ..d }); }
        }
        self.next = end;
    }
}

/// Whether `t` holds `pat` (ASCII) at `i`, ignoring ASCII case.
fn ascii_eq_ignore_case(t: &[u16], i: usize, pat: &str) -> bool {
    let p = pat.as_bytes();
    i + p.len() <= t.len() && t[i..i + p.len()].iter().zip(p).all(|(&a, &b)| a < 128 && (a as u8).eq_ignore_ascii_case(&b))
}

/// The value of a `type=` attribute, lowercased: `\btype\s*=\s*["']?([^"'\s>]+)` (any case).
fn type_attr(attrs: &[u16]) -> Option<String> {
    for p in 0..attrs.len() {
        if !ascii_eq_ignore_case(attrs, p, "type") || (p > 0 && is_word(attrs[p - 1])) { continue; }
        let mut j = p + 4;
        while j < attrs.len() && is_space(attrs[j]) { j += 1; }
        if !is(attrs, j, b'=') { continue; }
        j += 1;
        while j < attrs.len() && is_space(attrs[j]) { j += 1; }
        if is(attrs, j, b'"') || is(attrs, j, b'\'') { j += 1; }
        let v = j;
        while j < attrs.len() && !is_space(attrs[j]) && ![b'"', b'\'', b'>'].iter().any(|&c| attrs[j] == c as u16) { j += 1; }
        if j > v { return Some(text(&attrs[v..j]).to_lowercase()); }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lint::units;

    fn msgs(s: &str, xml: bool) -> Vec<(usize, usize, String)> { check(&units(s), xml).into_iter().map(|d| (d.at, d.len, d.msg)).collect() }

    #[test] fn good_markup() {
        assert_eq!(msgs("<!doctype html><html><body><p>a<br><img src='x>'><li>b</body></html>", false), vec![]);
        assert_eq!(msgs("<a><!-- <b> --><![CDATA[<c>]]><?x y?><d/></a>", true), vec![]);
        assert_eq!(msgs("<DIV></div>", false), vec![]);
    }
    #[test] fn tag_mistakes() {
        assert_eq!(msgs("<div><span></div>", false), vec![(5, 5, "<span> is never closed (expected </span> before </div>)".into())]);
        assert_eq!(msgs("</div>", false), vec![(0, 6, "Unexpected </div>: no <div> is open here".into())]);
        assert_eq!(msgs("<br></br>", false), vec![(4, 5, "<br> never takes a closing tag".into())]);
        assert_eq!(msgs("<div", false), vec![(0, 4, "<div> tag is never closed (missing >)".into())]);
        assert_eq!(msgs("<a href=\"x>", false), vec![(0, 2, "Attribute value is never closed (missing \")".into())]);
        assert_eq!(msgs("<!-- x", false), vec![(0, 4, "Comment is never closed (missing -->)".into())]);
        assert_eq!(msgs("<A></a>", true), vec![(3, 4, "Unexpected </a>: no <a> is open here".into()), (0, 2, "<A> is never closed".into())]);
    }
    #[test] fn scripts_and_styles_are_checked() {
        assert_eq!(msgs("<script>f(</script>", false), vec![(9, 1, "'(' is never closed".into())]);
        assert_eq!(msgs("<script type=\"text/template\">f(</script>", false), vec![]);
        assert_eq!(msgs("<SCRIPT TYPE=Module>f(</Script>", false), vec![(21, 1, "'(' is never closed".into())]);
        assert_eq!(msgs("<style>a { b: 'c }</style>", false), vec![(14, 4, "String is never closed (missing ')".into()), (9, 1, "'{' is never closed".into())]);
        assert_eq!(msgs("<script>f(", false), vec![(0, 7, "<script> is never closed".into())]);
    }
}
