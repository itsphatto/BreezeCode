// The composer's mic: local speech-to-text with whisper.cpp (MIT). Breeze downloads the CPU build and an English model
// into its data folder on first use (pinned by SHA-256), then the page records 16 kHz mono WAV and main transcribes it
// offline. Nothing leaves the PC after the one-time download.
import { execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface Pinned { url: string; file: string; sha256: string; size: number }
const WHISPER_BIN: Partial<Record<string, Pinned>> = {
  'win32-x64': {
    url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5907/whisper-bin-x64.zip',
    file: 'whisper-bin-x64.zip', sha256: 'ecca07b277d943e9b9f4712856a144b857271a6b333104e511e1988e80db582b', size: 9168428,
  },
};
// small.en at 5-bit: close to full small.en accuracy at 190 MB; a few seconds of speech transcribes in about a second.
const MODEL: Pinned = {
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q5_1.bin',
  file: 'ggml-small.en-q5_1.bin', sha256: 'bfdff4894dcb76bbf647d56263ea2a96645423f1669176f4844a1bf8e478ad30', size: 190098681,
};

export type DictateProgress = (done: number, total: number) => void;

export class Dictation {
  private install: Promise<void> | null = null;
  constructor(private readonly dir: string) {}

  get supported(): boolean { return !!WHISPER_BIN[`${process.platform}-${process.arch}`]; }
  private get modelPath(): string { return path.join(this.dir, MODEL.file); }

  // whisper-cli.exe wherever the zip put it (Release\ in current builds).
  private cli(): string | null {
    const walk = (d: string, depth: number): string | null => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return null; }
      for (const e of entries) if (e.isFile() && e.name.toLowerCase() === 'whisper-cli.exe') return path.join(d, e.name);
      if (depth > 0) for (const e of entries) if (e.isDirectory()) { const hit = walk(path.join(d, e.name), depth - 1); if (hit) return hit; }
      return null;
    };
    return walk(path.join(this.dir, 'bin'), 2);
  }

  ready(): boolean { return this.supported && !!this.cli() && fs.existsSync(this.modelPath); }

  // Downloads whatever is missing. One install at a time; a second call joins the first.
  ensure(progress: DictateProgress): Promise<void> {
    if (!this.supported) return Promise.reject(new Error('Voice typing runs on Windows x64 for now'));
    if (this.ready()) return Promise.resolve();
    this.install ??= (async () => {
      const bin = WHISPER_BIN[`${process.platform}-${process.arch}`]!;
      const needBin = !this.cli(), needModel = !fs.existsSync(this.modelPath);
      const total = (needBin ? bin.size : 0) + (needModel ? MODEL.size : 0);
      let base = 0;
      fs.mkdirSync(this.dir, { recursive: true });
      if (needBin) {
        const zip = path.join(this.dir, bin.file);
        await download(bin, zip, n => progress(base + n, total));
        base += bin.size;
        const binDir = path.join(this.dir, 'bin');
        fs.rmSync(binDir, { recursive: true, force: true });
        fs.mkdirSync(binDir, { recursive: true });
        // Windows 10+ ships a bsdtar that reads zip.
        const tar = path.join(process.env.SystemRoot || String.raw`C:\Windows`, 'System32', 'tar.exe');
        await new Promise<void>((resolve, reject) => execFile(tar, ['-xf', zip, '-C', binDir], { windowsHide: true },
          e => (e ? reject(new Error(`Couldn't unpack whisper.cpp: ${e.message}`)) : resolve())));
        fs.rmSync(zip, { force: true });
        if (!this.cli()) throw new Error("whisper-cli wasn't in the download");
      }
      if (needModel) await download(MODEL, this.modelPath, n => progress(base + n, total));
      progress(total, total);
    })().finally(() => { this.install = null; });
    return this.install;
  }

  // 16 kHz mono 16-bit WAV in, plain text out.
  async transcribe(wav: Uint8Array): Promise<string> {
    const cli = this.cli();
    if (!cli || !fs.existsSync(this.modelPath)) throw new Error('Voice typing isn’t set up yet');
    if (wav.byteLength < 44 || wav.byteLength > 64 * 1024 * 1024) throw new Error('That recording can’t be read');
    const file = path.join(os.tmpdir(), `breeze-dictate-${crypto.randomUUID()}.wav`);
    fs.writeFileSync(file, wav);
    try {
      const threads = String(Math.max(1, Math.min(8, os.availableParallelism() - 1)));
      const out = await new Promise<string>((resolve, reject) => execFile(cli,
        ['-m', this.modelPath, '-f', file, '-l', 'en', '-t', threads, '-nt', '-np', '-sns'],
        { windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, cwd: path.dirname(cli) },
        (e, stdout) => (e ? reject(new Error(`Transcription failed: ${e.message}`)) : resolve(stdout))));
      return cleanTranscript(out);
    } finally { fs.rmSync(file, { force: true }); }
  }
}

// whisper prints one line per segment and marks silence or noise as [BLANK_AUDIO], (music) and the like.
export function cleanTranscript(raw: string): string {
  return raw.split(/\r?\n/)
    .map(l => l.replace(/\[[^\]]*\]|\([^)]*\)/g, '').trim())
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

// Streams to <dest>.part while hashing; only a file whose hash matches is moved into place.
async function download(pin: Pinned, dest: string, onBytes: (n: number) => void): Promise<void> {
  const res = await fetch(pin.url);
  if (!res.ok || !res.body) throw new Error(`The download failed (${res.status})`);
  const part = `${dest}.part`;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(part);
  let n = 0, last = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      if (!out.write(value)) await new Promise<void>(r => out.once('drain', () => r()));
      n += value.byteLength;
      if (n - last > 512 * 1024) { last = n; onBytes(n); }
    }
  } finally { await new Promise<void>(r => out.end(() => r())); }
  if (hash.digest('hex') !== pin.sha256) {
    fs.rmSync(part, { force: true });
    throw new Error("The download didn't match the expected file, so it wasn't used");
  }
  fs.renameSync(part, dest);
}
