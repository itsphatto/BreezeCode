// A question at the end of an agent's reply ("Which gap should I close first?"), turned into answers the user can
// click instead of typing (teams.ts followUpCard). Pure text work, no DOM and no globals from other files, so
// test/followup.test.js can load it.
// The answers come from a short list next to the question, from "A, or B?" in the question itself, or are Yes / No
// for a question that asks whether to go ahead. An open question ("What should it be called?") gets no card.

interface FollowUp { question: string; options: string[] }

const FOLLOW_MAX = 4;          // answers shown
const FOLLOW_LABEL_MAX = 60;   // characters in one answer
const LIST_ITEM = /^\s*(?:[-*+•]|\d{1,2}[.)])\s+(.+)$/;
// Questions that ask whether to go ahead, answered with Yes or No.
const YES_NO = /^(?:want me to|do you want|would you like|should i|shall i|can i|may i|ready to|ok(?:ay)? to|proceed|continue|go ahead|is that|does that|sound good|good to go|want (?:it|that|this)|is this|are you|did that|does this)\b/i;

// Markdown marks off, spaces squeezed.
function plainText(s: string): string {
  return s.replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim();
}

// One list item as a button label: its bold lead ("**Go debugging** — adds a debugger"), else the part before a
// dash or colon. Null when nothing short enough is left.
function optionLabel(item: string): string | null {
  const bold = /^\s*\*\*(.+?)\*\*/.exec(item)?.[1];
  let label = plainText(bold ?? item.split(/\s+[—–-]\s+|:\s/)[0]);
  label = label.replace(/[.:;,]+$/, '').trim();
  if (!label) return null;
  if (label.length > FOLLOW_LABEL_MAX) {
    const cut = label.slice(0, FOLLOW_LABEL_MAX);
    label = `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 30)).trim()}…`;
  }
  return label;
}

// The list's items, or null when the block isn't a list of 2 to FOLLOW_MAX short-enough items.
function listOptions(block: string[] | undefined): string[] | null {
  if (!block?.length || !block.every(l => LIST_ITEM.test(l))) return null;
  if (block.length < 2 || block.length > FOLLOW_MAX) return null;
  const labels = block.map(l => optionLabel(LIST_ITEM.exec(l)![1]));
  if (labels.some(l => !l)) return null;
  const unique = [...new Set(labels as string[])];
  return unique.length === labels.length ? unique : null;
}

// "Fix the tests first, or ship it as is?" -> both halves. Only for a short question with one "or" in it.
function inlineOptions(question: string): string[] | null {
  const body = question.replace(/\?$/, '');
  const parts = body.split(/,?\s+or\s+/i);
  if (parts.length !== 2 || /\bor\b/i.test(parts[1])) return null;
  // The lead-in that both halves share ("Want me to", "Should I") stays off the first answer.
  let first = parts[0].replace(/^(?:want me to|do you want me to|should i|shall i|would you like me to|which (?:one|do you want|should i do)[^:,]*[:,]?|do you prefer|prefer)\s+/i, '');
  first = first.replace(/^(?:either\s+)/i, '');
  const second = parts[1];
  const labels = [first, second].map(p => optionLabel(p.charAt(0).toUpperCase() + p.slice(1)));
  if (labels.some(l => !l || l.length > 40 || l.split(' ').length > 7)) return null;
  return labels as string[];
}

// The reply's last question and its answers, or null when it doesn't end with one that has answers to pick.
function findFollowUp(text: string): FollowUp | null {
  if (!text) return null;
  // Code blocks never hold the question; one still open (a cut-off reply) means no card.
  const fences = text.match(/^```/gm)?.length ?? 0;
  if (fences % 2) return null;
  const blocks = text.replace(/^```[\s\S]*?^```\s*$/gm, '').split(/\n\s*\n/)
    .map(b => b.split('\n').map(l => l.trimEnd()).filter(l => l.trim()))
    .filter(b => b.length);
  if (!blocks.length) return null;

  // The question, the list after it: "Which should I do first?\n\n- A\n- B" (or the list right under the question).
  const last = blocks[blocks.length - 1];
  const listAfter = (lines: string[]) => listOptions(lines);
  const tailList = listAfter(last);
  if (tailList) {
    const q = blocks[blocks.length - 2];
    const qLine = q && q[q.length - 1];
    if (qLine && plainText(qLine).endsWith('?') && !LIST_ITEM.test(qLine)) return { question: lastSentence(plainText(qLine)), options: tailList };
  }
  const listStart = last.findIndex(l => LIST_ITEM.test(l));
  if (listStart > 0 && last.slice(listStart).every(l => LIST_ITEM.test(l))) {
    const qLine = last[listStart - 1];
    const opts = listOptions(last.slice(listStart));
    if (opts && plainText(qLine).endsWith('?')) return { question: lastSentence(plainText(qLine)), options: opts };
  }

  // The reply ends with the question itself.
  const end = plainText(last[last.length - 1]);
  if (!end.endsWith('?') || LIST_ITEM.test(last[last.length - 1])) return null;
  const question = lastSentence(end);
  // The list just above it: "- A\n- B\n\nWhich one first?"
  const above = last.length > 1 ? last.slice(0, -1) : blocks[blocks.length - 2];
  const aboveList = /\b(which|what|pick|choose|prefer|first|next|option)\b/i.test(question) ? listOptions(above) : null;
  if (aboveList) return { question, options: aboveList };
  const inline = inlineOptions(question);
  if (inline) return { question, options: inline };
  if (YES_NO.test(question) || goAhead(question)) return { question, options: ['Yes', 'No'] };
  return null;
}

// A short question that isn't open ("Run the backfill script?", "Commit it?"): no what/which/how, no "any".
function goAhead(question: string): boolean {
  const words = question.split(/\s+/);
  return words.length >= 2 && words.length <= 14 && !/^(?:what|which|where|when|who|whom|whose|why|how|any|anything|thoughts|ideas|questions)\b/i.test(question);
}

// The last sentence of a line: "Done. Run the tests now?" -> "Run the tests now?"
function lastSentence(line: string): string {
  const m = /(?:^|[.!?]\s+)([^.!?]*\?)$/.exec(line);
  const s = (m?.[1] ?? line).trim();
  return s.replace(/^(?:next|question|so)\s*:\s*/i, '');
}
