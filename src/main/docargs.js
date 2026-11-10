// Checks for what the page sends the text engine (main.js "doc:" channels). The page is untrusted, so every value is
// checked here before it reaches the engine. Each function returns a clean value or throws Error('Bad request').
const MAX_INT = 2 ** 31 - 1;
const MAX_COUNT = 5000;
const MAX_TEXT = 52428800; // 100 MB as UTF-16 code units (2 bytes each)
const MAX_QUERY = 1000;
const KINDS = ['type', 'delete', 'paste', 'other'];

const bad = () => new Error('Bad request');
const int = (v, min, max) => {
  if (!Number.isInteger(v) || v < min || v > max) throw bad();
  return v;
};

const docId = v => int(v, 1, MAX_INT);
const docLine = v => int(v, 0, MAX_INT);
const docCount = v => int(v, 0, MAX_COUNT);
// Only line and col are copied, so nothing else the page attached travels on.
function docPos(v) {
  if (!v || typeof v !== 'object') throw bad();
  return { line: docLine(v.line), col: docLine(v.col) };
}
function docText(v) {
  if (typeof v !== 'string' || v.length > MAX_TEXT) throw bad();
  return v;
}
function docQuery(v) {
  if (typeof v !== 'string' || v.length < 1 || v.length > MAX_QUERY || /[\r\n]/.test(v)) throw bad();
  return v;
}
function docKind(v) {
  if (!KINDS.includes(v)) throw bad();
  return v;
}

module.exports = { docId, docPos, docLine, docCount, docText, docQuery, docKind };
