// Checks for what the page sends the text engine (main.js "doc:" channels). The page is untrusted, so every value is
// checked here before it reaches the engine. Each function returns a clean value or throws Error('Bad request').
const MAX_INT = 2 ** 31 - 1;
const MAX_COUNT = 5000;
const MAX_TEXT = 52428800; // UTF-16 code units (string length): 50 Mi units, which is 100 MiB in memory at 2 bytes each
const MAX_QUERY = 1000;
const KINDS = ['type', 'delete', 'paste', 'other'];

const bad = () => new Error('Bad request');
const int = (v: unknown, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw bad();
  return v;
};

const docId = (v: unknown) => int(v, 1, MAX_INT);
const docLine = (v: unknown) => int(v, 0, MAX_INT);
const docCount = (v: unknown) => int(v, 0, MAX_COUNT);
// Only line and col are copied, so nothing else the page attached travels on.
function docPos(v: unknown): { line: number; col: number } {
  if (!v || typeof v !== 'object') throw bad();
  const p = v as { line?: unknown; col?: unknown };
  return { line: docLine(p.line), col: docLine(p.col) };
}
function docText(v: unknown): string {
  if (typeof v !== 'string' || v.length > MAX_TEXT) throw bad();
  return v;
}
function docQuery(v: unknown): string {
  if (typeof v !== 'string' || v.length < 1 || v.length > MAX_QUERY || /[\r\n]/.test(v)) throw bad();
  return v;
}
function docKind(v: unknown): string {
  if (typeof v !== 'string' || !KINDS.includes(v)) throw bad();
  return v;
}

export { docId, docPos, docLine, docCount, docText, docQuery, docKind };
