const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { codexTurnTokens, codexLogFile, codexStep } = require('../src/main/codexusage.js');

// Numbers from two real `codex exec` runs on one thread: the second reports the thread's running total.
const first = { input_tokens: 19247, cached_input_tokens: 0, output_tokens: 13, reasoning_output_tokens: 0 };
const second = { input_tokens: 38515, cached_input_tokens: 0, output_tokens: 38, reasoning_output_tokens: 11 };

test('a resumed turn counts only its own tokens', () => {
  assert.equal(codexTurnTokens(first, null), 19260);
  assert.equal(codexTurnTokens(second, first), 19293);
  assert.equal(codexTurnTokens(undefined, first), 0);
});

test('reasoning tokens are already inside output tokens', () => {
  assert.deepEqual(codexStep(second, first), { input: 19268, cacheRead: 0, output: 25 });
  assert.deepEqual(codexStep({ ...first, cached_input_tokens: 19000 }, null), { input: 247, cacheRead: 19000, output: 13 });
});

test('a chat started weeks ago is still found by the date in its id', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const ms = Date.now() - 40 * 86_400_000, hex = ms.toString(16).padStart(12, '0');
  const id = `${hex.slice(0, 8)}-${hex.slice(8)}-7db0-8943-6df0895abaa1`;
  const d = new Date(ms);
  const dir = path.join(base, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-x-${id}.jsonl`);
  fs.writeFileSync(file, '');
  assert.equal(codexLogFile(base, id), file);
  assert.equal(codexLogFile(base, 'missing'), null);
});
