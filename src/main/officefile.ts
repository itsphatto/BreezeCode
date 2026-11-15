// Word, PowerPoint and Excel files, and PDFs, as text the editor can show and save (main.ts fs:readFile / fs:writeFile).
// A .docx/.pptx/.xlsx is a zip of XML parts: its text is every XML part, each after a "breeze part" line, and saving
// zips them back, keeping the pictures and other binary parts as they were. A .pdf's text is its objects, with
// compressed streams inflated and binary ones as hex (ASCIIHexDecode), so the text is itself a PDF; saving compresses
// the streams again and writes a fresh cross-reference table.
import * as zlib from 'node:zlib';

const OFFICE_FILE = /\.(docx|pptx|xlsx)$/i;
const TEXT_PART = /\.(xml|rels|vml)$/i;
const MARK = (name: string) => `<!-- breeze part: ${name} -->`;
const MARK_RE = /^<!-- breeze part: (.+?) -->\r?$/gm;
const HEADER = '<!-- Breeze shows this file as its XML parts, each after a "breeze part" line. Saving zips them back; pictures and other binary parts are kept. -->\n';

/* ----- Zip ----- */
interface ZipEntry { name: string; method: number; crc: number; size: number; data: Buffer; } // data: as stored (compressed)

function readZip(buf: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd === -1) throw new Error('it is not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('its zip directory is damaged');
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    if (csize === 0xffffffff || local === 0xffffffff) throw new Error('it is a zip64 file, which Breeze does not read');
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out.push({ name, method, crc, size, data: buf.subarray(start, start + csize) });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}
function unzipEntry(e: ZipEntry): Buffer {
  if (e.method === 0) return e.data;
  if (e.method === 8) return zlib.inflateRawSync(e.data);
  throw new Error(`${e.name} is compressed in a way Breeze does not read`);
}
const storedEntry = (name: string, raw: Buffer): ZipEntry => ({ name, method: 8, crc: zlib.crc32(raw), size: raw.length, data: zlib.deflateRawSync(raw) });

function writeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(e.method, 8); head.writeUInt32LE(0x00210000, 10); // 1980-01-01
    head.writeUInt32LE(e.crc >>> 0, 14); head.writeUInt32LE(e.data.length, 18); head.writeUInt32LE(e.size, 22);
    head.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(e.method, 10); cen.writeUInt32LE(0x00210000, 12);
    cen.writeUInt32LE(e.crc >>> 0, 16); cen.writeUInt32LE(e.data.length, 20); cen.writeUInt32LE(e.size, 24);
    cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(off, 42);
    locals.push(head, name, e.data);
    centrals.push(cen, name);
    off += 30 + name.length + e.data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, dir, end]);
}

/* ----- Office files ----- */
// One element per line, indented: Office writes each part on one line. A line break goes only between two tags with
// nothing between them, and never inside an empty element (<w:t></w:t>), so the text in it is unchanged; whitespace
// between elements means nothing in these parts. Running it on its own output changes nothing.
function prettyXml(xml: string): string {
  let depth = 0, out = '';
  const re = /<[^>]+>|[^<]+/g;
  let prev = '';
  for (const m of xml.matchAll(re)) {
    const tok = m[0];
    const isTag = tok[0] === '<';
    const closing = isTag && tok[1] === '/';
    const opening = isTag && !closing && !/^<[?!]/.test(tok) && !tok.endsWith('/>');
    if (isTag && prev.endsWith('>') && !(closing && /^<[^/?!][^>]*[^/]>$|^<[^/?!]>$/.test(prev))) {
      if (closing) depth = Math.max(0, depth - 1);
      out += '\n' + '  '.repeat(depth);
    } else if (closing) depth = Math.max(0, depth - 1);
    out += tok;
    if (opening) depth++;
    prev = tok;
  }
  return out;
}
const partRank = (name: string) => /^(word\/document|xl\/workbook|ppt\/presentation)\.xml$/.test(name) ? 0
  : /^(xl\/worksheets\/|xl\/sharedStrings|ppt\/slides\/slide)/.test(name) ? 1 : 2;
const natural = new Intl.Collator('en', { numeric: true }).compare;

function officeToText(buf: Buffer): string {
  const parts = readZip(buf).filter(e => TEXT_PART.test(e.name))
    .sort((a, b) => partRank(a.name) - partRank(b.name) || natural(a.name, b.name));
  return HEADER + parts.map(e => `${MARK(e.name)}\n${prettyXml(unzipEntry(e).toString('utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n'))}\n`).join('');
}
// `original`: the file as it is on disk, whose binary parts are kept. A text part missing from `text` is left out.
function textToOffice(text: string, original: Buffer | null): Buffer {
  const marks = [...text.matchAll(MARK_RE)];
  if (!marks.length) throw new Error('it has no "breeze part" lines, so Breeze can\'t tell its parts apart');
  const parts = new Map<string, string>();
  marks.forEach((m, i) => {
    const name = m[1].trim();
    if (!name || name.startsWith('/') || name.split('/').includes('..')) throw new Error(`"${name}" is not a part name`);
    const start = (m.index as number) + m[0].length + 1, end = i + 1 < marks.length ? (marks[i + 1].index as number) : text.length;
    parts.set(name, text.slice(start, end).replace(/\r\n?/g, '\n').replace(/\n$/, ''));
  });
  const out: ZipEntry[] = [];
  for (const e of original ? readZip(original) : []) {
    if (!TEXT_PART.test(e.name)) out.push(e);
    else if (parts.has(e.name)) { out.push(storedEntry(e.name, Buffer.from(parts.get(e.name) as string, 'utf8'))); parts.delete(e.name); }
  }
  for (const [name, xml] of parts) out.push(storedEntry(name, Buffer.from(xml, 'utf8')));
  // [Content_Types].xml first, as Office writes it.
  out.sort((a, b) => Number(b.name === '[Content_Types].xml') - Number(a.name === '[Content_Types].xml'));
  return writeZip(out);
}
// Pictures in an Office file, for its document view: part name → data URL.
const MEDIA_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml' };
function officeMedia(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let total = 0;
  for (const e of readZip(buf)) {
    const type = MEDIA_TYPES[e.name.split('.').pop()?.toLowerCase() ?? ''];
    if (!type || (total += e.size) > 40 * 1024 * 1024) continue;
    out[e.name] = `data:${type};base64,${unzipEntry(e).toString('base64')}`;
  }
  return out;
}

/* ----- PDF ----- */
// Strings here are latin1: one character per byte.
interface PdfObj { num: number; gen: number; body: string; data?: string; } // body: the object, or a stream's dictionary

const WS = /[\0\t\n\f\r ]/;
// The end of the PDF value starting at `i` (after any whitespace).
function valueEnd(s: string, i: number): number {
  while (WS.test(s[i] ?? '')) i++;
  const c = s[i];
  if (c === '/') { i++; while (i < s.length && !/[\0\t\n\f\r ()<>[\]{}/%]/.test(s[i])) i++; return i; }
  if (c === '(') {
    let depth = 0;
    for (; i < s.length; i++) {
      if (s[i] === '\\') { i++; continue; }
      if (s[i] === '(') depth++;
      else if (s[i] === ')' && --depth === 0) return i + 1;
    }
    return i;
  }
  if (c === '<' && s[i + 1] !== '<') return s.indexOf('>', i) + 1 || s.length;
  if (c === '<' || c === '[') {
    const close = c === '<' ? '>>' : ']';
    i += c === '<' ? 2 : 1;
    for (;;) {
      while (WS.test(s[i] ?? '') || s[i] === '%') { if (s[i] === '%') while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++; else i++; }
      if (i >= s.length) return i;
      if (s.startsWith(close, i)) return i + close.length;
      i = valueEnd(s, i);
    }
  }
  const tok = /^[^\0\t\n\f\r ()<>[\]{}/%]+/.exec(s.slice(i, i + 64));
  i += tok ? tok[0].length : 1;
  const ref = /^\s+\d+\s+R(?![^\0\t\n\f\r ()<>[\]{}/%])/.exec(s.slice(i, i + 32));
  return tok && /^\d+$/.test(tok[0]) && ref ? i + ref[0].length : i;
}
// A dictionary's own keys (not its nested dictionaries'): name → [value start, value end].
function dictKeys(d: string): Map<string, [number, number]> {
  const keys = new Map<string, [number, number]>();
  let i = d.indexOf('<<');
  if (i === -1) return keys;
  i += 2;
  for (;;) {
    while (WS.test(d[i] ?? '')) i++;
    if (i >= d.length || d.startsWith('>>', i)) return keys;
    const k = valueEnd(d, i);
    const name = d.slice(i, k).trim();
    const v = valueEnd(d, k);
    if (v <= k) return keys;
    keys.set(name, [k, v]);
    i = v;
  }
}
const dictGet = (d: string, key: string) => { const r = dictKeys(d).get(key); return r ? d.slice(r[0], r[1]).trim() : undefined; };
function dictSet(d: string, key: string, value: string | null): string {
  const r = dictKeys(d).get(key);
  if (r) {
    const kStart = r[0] - key.length;
    return value == null ? d.slice(0, kStart).replace(/\s+$/, '') + d.slice(r[1]) : d.slice(0, r[0]) + ' ' + value + d.slice(r[1]);
  }
  if (value == null) return d;
  const end = d.lastIndexOf('>>'), head = d.slice(0, end).replace(/\s*$/, '');
  return `${head} ${key} ${value}${d.slice(head.length)}`; // the space before >> stays, so removing it again gives d back
}
// A filter or decode-parms value as a list ("/A" → ["/A"], "[/A /B]" → ["/A", "/B"]).
function pdfList(v: string | undefined): string[] {
  if (!v) return [];
  if (!v.startsWith('[')) return [v];
  const out: string[] = [];
  for (let i = 1; ;) {
    while (WS.test(v[i] ?? '')) i++;
    if (i >= v.length || v[i] === ']') return out;
    const e = valueEnd(v, i);
    out.push(v.slice(i, e).trim());
    i = e;
  }
}
const asPdfList = (xs: string[]) => xs.length === 1 ? xs[0] : `[${xs.join(' ')}]`;

// Every object in file order (a later one with the same number replaces an earlier one, as an update does), and the
// trailer dictionaries (classic, or a cross-reference stream's).
function scanPdf(s: string): { objs: PdfObj[]; trailers: string[] } {
  const objs: PdfObj[] = [], trailers: string[] = [];
  const re = /(\d+)\s+(\d+)\s+obj\b|trailer\s*(?=<<)/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (!m[1]) { const e = valueEnd(s, re.lastIndex); trailers.push(s.slice(re.lastIndex, e)); re.lastIndex = e; continue; }
    const start = re.lastIndex;
    const end = valueEnd(s, start);
    const after = /^\s*(stream\r?\n|endobj)/.exec(s.slice(end, end + 16));
    const obj: PdfObj = { num: Number(m[1]), gen: Number(m[2]), body: s.slice(start, end).trim() };
    if (after?.[1].startsWith('stream')) {
      const ds = end + after[0].length;
      const len = Number(/^\d+$/.test(dictGet(obj.body, '/Length') ?? '') ? dictGet(obj.body, '/Length') : NaN);
      let de = Number.isFinite(len) && /^\s*endstream/.test(s.slice(ds + len, ds + len + 16)) ? ds + len : s.indexOf('endstream', ds);
      if (de === -1) de = s.length;
      const dataEnd = Number.isFinite(len) && de === ds + len ? de : de - (/\r\n$/.test(s.slice(de - 2, de)) ? 2 : /[\r\n]$/.test(s[de - 1]) ? 1 : 0);
      obj.data = s.slice(ds, Math.max(ds, dataEnd));
      const close = s.indexOf('endobj', de);
      re.lastIndex = close === -1 ? s.length : close + 6;
    } else re.lastIndex = after ? end + after[0].length : end;
    objs.push(obj);
  }
  return { objs, trailers };
}
// Text the editor can hold as it is: no control characters but tabs and line feeds (a byte past 127 is one character).
const TEXTY = /^[\t\n\x20-\x7e\x80-\xff]*$/;
// A stream's text with its line ends as line feeds, when that makes it readable. Drawing commands mean the same either
// way (a line end inside a string reads as a line feed too).
const asText = (data: string): string | null => { const t = data.replace(/\r\n?/g, '\n'); return TEXTY.test(t) ? t : null; };
const inflate = (data: string): string | null => {
  const b = Buffer.from(data, 'latin1');
  try { return zlib.inflateSync(b).toString('latin1'); } catch { /* not zlib-wrapped */ }
  try { return zlib.inflateRawSync(b).toString('latin1'); } catch { return null; }
};
const toHex = (data: string) => (Buffer.from(data, 'latin1').toString('hex').match(/.{1,128}/g) ?? []).join('\n') + '>';

function pdfToText(buf: Buffer): string {
  const s = buf.toString('latin1');
  const version = /^%PDF-(\d\.\d)/.exec(s)?.[1];
  if (!version) throw new Error('it is not a PDF');
  const { objs, trailers } = scanPdf(s);
  const byNum = new Map<number, PdfObj>();
  for (const o of objs) {
    const type = dictGet(o.body, '/Type');
    if (type === '/XRef') { trailers.push(o.body); continue; }
    if (type === '/ObjStm' && o.data != null) {
      // Objects packed in a stream become objects of their own, so a plain cross-reference table can list them.
      const filters = pdfList(dictGet(o.body, '/Filter'));
      const data = filters.length === 0 ? o.data : filters.length === 1 && filters[0] === '/FlateDecode' && !dictGet(o.body, '/DecodeParms') ? inflate(o.data) : null;
      if (data == null) throw new Error('it packs objects in a way Breeze does not read');
      const first = Number(dictGet(o.body, '/First')), nums = data.slice(0, first).trim().split(/\s+/).map(Number);
      for (let k = 0; k + 1 < nums.length; k += 2) {
        const from = first + nums[k + 1], to = k + 3 < nums.length ? first + nums[k + 3] : data.length;
        byNum.set(nums[k], { num: nums[k], gen: 0, body: data.slice(from, to).trim() });
      }
      continue;
    }
    byNum.set(o.num, o);
  }
  if (trailers.some(t => dictGet(t, '/Encrypt'))) throw new Error('it is encrypted');
  const keep = ['/Root', '/Info', '/ID'].map(k => [k, trailers.map(t => dictGet(t, k)).filter(Boolean).at(-1)]).filter(([, v]) => v);
  if (!keep.some(([k]) => k === '/Root')) throw new Error('it has no document catalog');
  let out = `%PDF-${version}\n`;
  for (const o of [...byNum.values()].sort((a, b) => a.num - b.num)) {
    let body = o.body.replace(/\r\n?/g, '\n');
    if (o.data == null) { out += `${o.num} ${o.gen} obj\n${body}\nendobj\n\n`; continue; }
    let data = o.data;
    let filters = pdfList(dictGet(body, '/Filter'));
    const parms = dictGet(body, '/DecodeParms');
    // Inflated only when that makes it readable (a page's drawing commands); a picture or a font stays compressed.
    if (filters.length === 1 && filters[0] === '/FlateDecode' && !parms) {
      const plain = inflate(data), text = plain == null ? null : asText(plain);
      if (text != null) { data = text; filters = []; body = dictSet(body, '/Filter', null); }
    } else if (!filters.length) data = asText(data) ?? data;
    if (!TEXTY.test(data)) {
      if (filters.some(f => !f.startsWith('/'))) throw new Error('a stream names its filter indirectly');
      data = toHex(data);
      body = dictSet(body, '/Filter', asPdfList(['/ASCIIHexDecode', ...filters]));
      if (parms) body = dictSet(body, '/DecodeParms', asPdfList(['null', ...pdfList(parms)]));
    }
    body = dictSet(body, '/Length', String(data.length));
    out += `${o.num} ${o.gen} obj\n${body}\nstream\n${data}\nendstream\nendobj\n\n`;
  }
  return out + `trailer\n<< ${keep.map(([k, v]) => `${k} ${v}`).join(' ')} >>\n`;
}

function textToPdf(text: string): Buffer {
  const s = Buffer.from(text, 'latin1').toString('latin1'); // characters past one byte can't be in a PDF as they are
  const version = /^%PDF-(\d\.\d)/.exec(s)?.[1] ?? '1.7';
  const { objs, trailers } = scanPdf(s);
  if (!objs.length) throw new Error('it has no objects');
  const chunks: Buffer[] = [Buffer.from(`%PDF-${version}\n%\xe2\xe3\xcf\xd3\n`, 'latin1')];
  let off = chunks[0].length;
  const offsets = new Map<number, [number, number]>();
  for (const o of objs) {
    let body = o.body, data = o.data != null ? Buffer.from(o.data, 'latin1') : null;
    if (data) {
      let filters = pdfList(dictGet(body, '/Filter'));
      let parms = pdfList(dictGet(body, '/DecodeParms'));
      const hexed = filters[0] === '/ASCIIHexDecode' || filters[0] === '/AHx';
      if (hexed) {
        const hex = data.toString('latin1').split('>')[0].replace(/[^0-9a-f]/gi, '');
        data = Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex');
        filters = filters.slice(1);
        if (parms.length > 1 || parms[0] === 'null') parms = parms.slice(1);
        body = dictSet(body, '/Filter', filters.length ? asPdfList(filters) : null);
        body = dictSet(body, '/DecodeParms', parms.length && parms.some(p => p !== 'null') ? asPdfList(parms) : null);
      }
      // Readable text is compressed again; hex that was never compressed (it was so in the file) stays as it was.
      if (!filters.length && !hexed) { data = zlib.deflateSync(data); body = dictSet(body, '/Filter', '/FlateDecode'); }
      body = dictSet(body, '/Length', String(data.length));
    }
    offsets.set(o.num, [off, o.gen]);
    const head = Buffer.from(`${o.num} ${o.gen} obj\n${body}\n${data ? 'stream\n' : ''}`, 'latin1');
    const tail = Buffer.from(data ? '\nendstream\nendobj\n' : 'endobj\n', 'latin1');
    chunks.push(head, ...(data ? [data] : []), tail);
    off += head.length + (data?.length ?? 0) + tail.length;
  }
  const size = [...offsets.keys()].reduce((a, n) => Math.max(a, n), 0) + 1;
  let xref = `xref\n0 ${size}\n`;
  for (let n = 0; n < size; n++) {
    const at = offsets.get(n);
    xref += at ? `${String(at[0]).padStart(10, '0')} ${String(at[1]).padStart(5, '0')} n\r\n` : `0000000000 ${n ? '00001' : '65535'} f\r\n`;
  }
  let trailer = trailers.at(-1) ?? '<< >>';
  for (const k of ['/Prev', '/XRefStm']) trailer = dictSet(trailer, k, null);
  trailer = dictSet(trailer, '/Size', String(size));
  chunks.push(Buffer.from(`${xref}trailer\n${trailer}\nstartxref\n${off}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(chunks);
}

/* ----- New, empty files ----- */
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = {
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
};
const types = (parts: [string, string][]) => `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${parts.map(([part, type]) => `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}"/>`).join('')}</Types>`;
const rels = (list: [string, string][]) => `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map(([type, target], i) => `<Relationship Id="rId${i + 1}" Type="${NS.r}/${type}" Target="${target}"/>`).join('')}</Relationships>`;
const emptyTree = '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>';
const textBox = (id: number, name: string, y: number, cy: number, pt: number) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="838200" y="${y}"/><a:ext cx="10515600" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/><a:p><a:endParaRPr lang="en-US" sz="${pt * 100}"/></a:p></p:txBody></p:sp>`;
const THEME = `${XML_DECL}<a:theme xmlns:a="${NS.a}" name="Office"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst>${'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${'<a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'.repeat(3)}</a:lnStyleLst><a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
const CLR_MAP = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';
const BLANK_OFFICE: Record<string, Record<string, string>> = {
  docx: {
    '[Content_Types].xml': types([['word/document.xml', 'wordprocessingml.document.main+xml']]),
    '_rels/.rels': rels([['officeDocument', 'word/document.xml']]),
    'word/document.xml': `${XML_DECL}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  },
  xlsx: {
    '[Content_Types].xml': types([['xl/workbook.xml', 'spreadsheetml.sheet.main+xml'], ['xl/worksheets/sheet1.xml', 'spreadsheetml.worksheet+xml']]),
    '_rels/.rels': rels([['officeDocument', 'xl/workbook.xml']]),
    'xl/workbook.xml': `${XML_DECL}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${NS.r}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': rels([['worksheet', 'worksheets/sheet1.xml']]),
    'xl/worksheets/sheet1.xml': `${XML_DECL}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`,
  },
  pptx: {
    '[Content_Types].xml': types([
      ['ppt/presentation.xml', 'presentationml.presentation.main+xml'], ['ppt/slideMasters/slideMaster1.xml', 'presentationml.slideMaster+xml'],
      ['ppt/slideLayouts/slideLayout1.xml', 'presentationml.slideLayout+xml'], ['ppt/slides/slide1.xml', 'presentationml.slide+xml'], ['ppt/theme/theme1.xml', 'theme+xml'],
    ]),
    '_rels/.rels': rels([['officeDocument', 'ppt/presentation.xml']]),
    'ppt/presentation.xml': `${XML_DECL}<p:presentation xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels([['slideMaster', 'slideMasters/slideMaster1.xml'], ['slide', 'slides/slide1.xml'], ['theme', 'theme/theme1.xml']]),
    'ppt/slideMasters/slideMaster1.xml': `${XML_DECL}<p:sldMaster xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}"><p:cSld>${emptyTree}</p:spTree></p:cSld>${CLR_MAP}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels([['slideLayout', '../slideLayouts/slideLayout1.xml'], ['theme', '../theme/theme1.xml']]),
    'ppt/slideLayouts/slideLayout1.xml': `${XML_DECL}<p:sldLayout xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}" type="blank"><p:cSld name="Blank">${emptyTree}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels([['slideMaster', '../slideMasters/slideMaster1.xml']]),
    'ppt/slides/slide1.xml': `${XML_DECL}<p:sld xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}"><p:cSld>${emptyTree}${textBox(2, 'Title', 1122363, 1200000, 44)}${textBox(3, 'Text', 2600000, 3500000, 24)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
    'ppt/slides/_rels/slide1.xml.rels': rels([['slideLayout', '../slideLayouts/slideLayout1.xml']]),
    'ppt/theme/theme1.xml': THEME,
  },
};
// One blank Letter page, with Helvetica ready as /F1 for text drawn in its page stream.
const BLANK_PDF = `%PDF-1.7
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj

2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj

3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>
endobj

4 0 obj
<< /Length 0 >>
stream

endstream
endobj

trailer
<< /Root 1 0 R >>
`;
// A new empty document of the file's type, which Word, Excel, PowerPoint or a PDF reader opens.
function blankDocFile(abs: string): Buffer {
  const parts = BLANK_OFFICE[abs.split('.').pop()?.toLowerCase() ?? ''];
  return parts ? writeZip(Object.entries(parts).map(([name, xml]) => storedEntry(name, Buffer.from(xml, 'utf8')))) : textToPdf(BLANK_PDF);
}

/* ----- What main.ts calls ----- */
// A PDF is shown as text while its text fits the editor (binary streams as hex make it up to twice the file);
// a bigger one opens in the viewer only.
const PDF_TEXT_MAX = 50 * 1024 * 1024;
const isDocFile = (abs: string) => OFFICE_FILE.test(abs) || /\.pdf$/i.test(abs);
// The file's text, or null when Breeze can't show it as text (an encrypted or very large PDF opens in the viewer).
// An empty file (just made) reads as a blank document, which saving writes.
function docFileToText(abs: string, buf: Buffer): string | null {
  if (!buf.length) buf = blankDocFile(abs);
  if (OFFICE_FILE.test(abs)) return officeToText(buf);
  if (buf.length > PDF_TEXT_MAX / 2) return null;
  try { const text = pdfToText(buf); return text.length <= PDF_TEXT_MAX ? text : null; } catch { return null; }
}
function textToDocFile(abs: string, text: string, original: Buffer | null): Buffer {
  return OFFICE_FILE.test(abs) ? textToOffice(text, original) : textToPdf(text);
}

export { isDocFile, docFileToText, textToDocFile, blankDocFile, officeMedia, officeToText, textToOffice, pdfToText, textToPdf, prettyXml, readZip, writeZip, storedEntry, unzipEntry };
