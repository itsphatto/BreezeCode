// A source map (version 3) reader, for debugging code that was compiled first (.jsx and .tsx files, which the
// debugger runs as the JavaScript tsc wrote). It maps both ways: a line in the source to where it lives in the
// generated file (to set a breakpoint) and a position in the generated file back to the source (to show where the
// program stopped). All line and column numbers here are 0-based, as in the map and in CDP.
import * as path from 'node:path';

interface Segment { gl: number; gc: number; src: number; sl: number; sc: number }
export interface Position { line: number; col: number }
export interface Origin extends Position { source: string }

const B64 = new Map<string, number>(Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', (c, i) => [c, i]));

// The VLQ numbers of one `mappings` group (the part between two commas).
function vlq(text: string): number[] | null {
  const out: number[] = [];
  let value = 0, shift = 0;
  for (const ch of text) {
    const d = B64.get(ch);
    if (d === undefined) return null;
    value += (d & 31) * 2 ** shift; // not <<, which would wrap at 32 bits
    if (d & 32) { shift += 5; continue; }
    out.push(value % 2 ? -Math.floor(value / 2) : value / 2);
    value = 0; shift = 0;
  }
  return shift ? null : out;
}

// Paths are compared as written by the OS: case-insensitive on Windows.
const keyOf = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

class SourceMap {
  sources: string[];
  private flat: Segment[];   // by generated position
  private bySource: Map<number, Map<number, Segment>> = new Map(); // source → source line → its first segment in the generated file

  private constructor(sources: string[], flat: Segment[]) {
    this.sources = sources;
    this.flat = flat;
    for (const seg of flat) {
      let lines = this.bySource.get(seg.src);
      if (!lines) this.bySource.set(seg.src, lines = new Map());
      const have = lines.get(seg.sl);
      if (!have || seg.gl < have.gl || (seg.gl === have.gl && seg.gc < have.gc)) lines.set(seg.sl, seg);
    }
  }

  // `file` is where the map lives: its `sources` are relative to that folder (and to `sourceRoot`, if there is one).
  // Null for anything that isn't a usable map.
  static parse(json: string, file: string): SourceMap | null {
    let raw: { version?: number; sources?: unknown; sourceRoot?: unknown; mappings?: unknown };
    try { raw = JSON.parse(json); } catch { return null; }
    if (!raw || raw.version !== 3 || !Array.isArray(raw.sources) || typeof raw.mappings !== 'string') return null;
    const dir = path.dirname(file);
    const root = typeof raw.sourceRoot === 'string' ? raw.sourceRoot : '';
    const sources = raw.sources.map(s => path.resolve(dir, root, String(s)));
    const flat: Segment[] = [];
    let src = 0, sl = 0, sc = 0;
    let gl = 0;
    for (const group of raw.mappings.split(';')) {
      let gc = 0;
      if (group) for (const piece of group.split(',')) {
        const f = vlq(piece);
        if (!f || ![1, 4, 5].includes(f.length)) return null;
        gc += f[0];
        if (f.length === 1) continue; // a position with no source
        src += f[1]; sl += f[2]; sc += f[3];
        if (src < 0 || src >= sources.length || sl < 0 || sc < 0 || gc < 0) return null;
        flat.push({ gl, gc, src, sl, sc });
      }
      gl++;
    }
    return new SourceMap(sources, flat);
  }

  has(source: string): boolean {
    const k = keyOf(path.resolve(source));
    return this.sources.some(s => keyOf(s) === k);
  }

  // Where the program is in the source when it is at (line, col) of the generated file: the segment at or before
  // it. Before the first segment (the "use strict" and require lines tsc adds) it is the first one.
  original(line: number, col: number): Origin | null {
    const f = this.flat;
    if (!f.length) return null;
    let lo = 0, hi = f.length; // the first segment after (line, col)
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (f[mid].gl < line || (f[mid].gl === line && f[mid].gc <= col)) lo = mid + 1; else hi = mid;
    }
    const seg = f[Math.max(0, lo - 1)];
    return { source: this.sources[seg.src], line: seg.sl, col: seg.sc };
  }

  // The first place in the generated file that runs `line` of `source`; null when that line has no code of its own
  // (a blank line, a comment, a type), so a breakpoint there stays unverified rather than moving.
  generated(source: string, line: number): Position | null {
    const k = keyOf(path.resolve(source));
    const idx = this.sources.findIndex(s => keyOf(s) === k);
    const seg = idx < 0 ? undefined : this.bySource.get(idx)?.get(line);
    return seg ? { line: seg.gl, col: seg.gc } : null;
  }
}

export { SourceMap, keyOf };
