// Pure Markdown helpers for agent replies (md() in agents.ts). No DOM, no globals from other files.

type MdPart = { text: string } | { info: string; code: string };

// Splits a reply into text and fenced code blocks. A fence is ``` at the start of a line (up to 3 spaces in front), as
// in Markdown: backticks in the middle of a sentence are text. An unclosed fence (the reply was cut off) still counts.
function splitFences(text: string): MdPart[] {
  const out: MdPart[] = [];
  const open = /^ {0,3}```([^`]*)$/, close = /^ {0,3}```\s*$/;
  let textStart = 0, info: string | null = null, codeStart = 0;
  for (let at = 0; at <= text.length;) {
    let end = text.indexOf('\n', at);
    if (end < 0) end = text.length;
    const line = text.slice(at, end);
    if (info === null) {
      const m = open.exec(line);
      if (m) {
        if (at > textStart) out.push({ text: text.slice(textStart, at) });
        info = m[1].trim();
        codeStart = end + 1;
      }
    } else if (close.test(line)) {
      out.push({ info, code: text.slice(codeStart, Math.max(codeStart, at - 1)) });
      info = null;
      textStart = end;
    }
    at = end + 1;
  }
  if (info !== null) out.push({ info, code: text.slice(Math.min(codeStart, text.length)).replace(/\n$/, '') });
  else if (textStart < text.length) out.push({ text: text.slice(textStart) });
  return out;
}

// Inline code in text that is already HTML-escaped: `x`, or ``a`b`` and ``` x ``` (a run of backticks closed by a run
// of the same length, on one line), as Markdown reads them. The text inside is trimmed.
function codeSpans(escaped: string): string {
  return escaped.replace(/(?<!`)(`+)(?!`)([^\n]*?[^`\n][^\n]*?)(?<!`)\1(?!`)/g, (_m: string, _ticks: string, code: string) => `<code>${code.trim()}</code>`);
}
