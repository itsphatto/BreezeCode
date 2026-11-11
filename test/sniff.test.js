const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { looksBinary, SNIFF_BYTES } = require('../src/main/sniff');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-sniff-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const file = (name, buf) => { const p = path.join(dir, name); fs.writeFileSync(p, buf); return p; };

test('looksBinary: a NUL near the start is binary', async () => {
  assert.equal(await looksBinary(file('a.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x14]))), true);
});
test('looksBinary: text is not binary, including UTF-8 and an empty file', async () => {
  assert.equal(await looksBinary(file('a.txt', Buffer.from('hello\r\nwörld 😀\n'.repeat(2000)))), false);
  assert.equal(await looksBinary(file('empty.txt', Buffer.alloc(0))), false);
});
test('looksBinary: only the first SNIFF_BYTES count', async () => {
  const late = Buffer.alloc(SNIFF_BYTES + 10, 0x61); late[SNIFF_BYTES + 5] = 0;
  assert.equal(await looksBinary(file('late.txt', late)), false);
  const edge = Buffer.alloc(SNIFF_BYTES, 0x61); edge[SNIFF_BYTES - 1] = 0;
  assert.equal(await looksBinary(file('edge.bin', edge)), true);
});
test('looksBinary: looks only at the head of a large file', async () => {
  // 64 MB: a NUL-free head, then a tail of zero bytes (ftruncate fills with NUL). Text means the tail was never read.
  const p = path.join(dir, 'big.log');
  const fd = fs.openSync(p, 'w'); fs.writeSync(fd, Buffer.alloc(SNIFF_BYTES, 0x61)); fs.ftruncateSync(fd, 64 * 1024 * 1024); fs.closeSync(fd);
  assert.equal(await looksBinary(p), false);
});
test('looksBinary: a missing file rejects', async () => {
  await assert.rejects(looksBinary(path.join(dir, 'nope.bin')));
});
