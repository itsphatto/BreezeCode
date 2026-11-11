// Telling a binary file from text without reading all of it (main.js fs:readFile).
const fsp = require('node:fs/promises');

// How much of the start of a file is looked at, as git does: a NUL byte there means binary.
const SNIFF_BYTES = 8000;

// True when the first SNIFF_BYTES of the file hold a NUL byte. Reads only that much, through a file handle, so a
// 1 GB archive costs one small read.
async function looksBinary(abs) {
  const fh = await fsp.open(abs, 'r');
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, SNIFF_BYTES, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await fh.close();
  }
}

module.exports = { looksBinary, SNIFF_BYTES };
