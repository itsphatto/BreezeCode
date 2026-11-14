// Pure text and layout logic for Explain with Agents (explain.ts). No DOM, no globals from other files.

// The most selected code sent to the agent; the rest is left out and the prompt says so.
const EXPLAIN_MAX = 12000;
const EXPLAIN_AROUND = 20; // lines of context on each side of the selection

type ExplainInput = { path: string; lang: string; first: number; last: number; code: string; before: string; after: string };

function explainPrompt(o: ExplainInput): string {
  const cut = o.code.length > EXPLAIN_MAX;
  const code = cut ? o.code.slice(0, EXPLAIN_MAX) : o.code;
  const where = o.first === o.last ? `line ${o.first}` : `lines ${o.first}-${o.last}`;
  const parts = [
    `Explain this ${o.lang} code from ${o.path} (${where}) to a developer reading it for the first time.`,
    'Keep it short and easy to understand: plain, simple words, under 80 words, in 2-4 sentences or up to 4 short bullets.',
    'Start with what it does in one sentence, then how, then one thing that is easy to miss (only if there is one).',
    'Explain any jargon you use. No headings, no preamble, no summary at the end.',
    'Do not rewrite the code or suggest edits unless something is clearly a bug. Do not use any tools.',
    '',
    `Selected code${cut ? ' (cut)' : ''}:`,
    '```',
    code,
    '```',
  ];
  if (o.before.trim()) parts.push('', 'Code just above it, for context:', '```', o.before, '```');
  if (o.after.trim()) parts.push('', 'Code just below it, for context:', '```', o.after, '```');
  return parts.join('\n');
}

// The 1-based first and last lines of text.slice(start, end), and up to `lines` lines on each side of them.
// A selection that ends right after a line break doesn't take in the line below.
function explainContext(text: string, start: number, end: number, lines = EXPLAIN_AROUND): { before: string; after: string; first: number; last: number } {
  const lineAt = (off: number) => { let n = 0; for (let i = 0; i < off; i++) if (text.charCodeAt(i) === 10) n++; return n; };
  const stop = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const first = lineAt(start), last = lineAt(stop);
  const all = text.split('\n');
  return {
    before: all.slice(Math.max(0, first - lines), first).join('\n'),
    after: all.slice(last + 1, last + 1 + lines).join('\n'),
    first: first + 1,
    last: last + 1,
  };
}

// Where a w×h card goes for a right-click at (x, y) in a vw×vh window: 12px below the point, or 12px above it when
// there is no room below, and always inside an 8px margin.
function placeCard(x: number, y: number, w: number, h: number, vw: number, vh: number): { left: number; top: number } {
  const m = 8;
  let top = y + 12;
  if (top + h > vh - m) top = y - h - 12 >= m ? y - h - 12 : Math.max(m, Math.min(top, vh - h - m));
  return { left: Math.max(m, Math.min(x, vw - w - m)), top };
}

// The agents' reply renderer (md() in agents.ts) knows bold and code but not headings: a "## Heading" line becomes
// "**Heading**". Lines inside ``` fences are code and stay as they are.
function tidyExplain(reply: string): string {
  let inFence = false;
  return reply.split('\n').map(line => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return line; }
    const h = inFence ? null : /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    return h ? `**${h[1]}**` : line;
  }).join('\n');
}

// What Ask puts in a new agent chat's message box: where the code is, and the code itself when it is short (longer
// code the agent reads from the file). The user types their question after it.
const ASK_MAX_LINES = 40;
function askDraft(o: { path: string; first: number; last: number; code: string }): string {
  const where = o.first === o.last ? `line ${o.first}` : `lines ${o.first}–${o.last}`;
  const code = o.code.endsWith('\n') ? o.code : `${o.code}\n`;
  const short = code.split('\n').length - 1 <= ASK_MAX_LINES;
  return `About ${o.path} ${where}:\n${short ? `\`\`\`\n${code}\`\`\`\n` : ''}\n`;
}
