const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { officeToText, textToOffice, pdfToText, textToPdf, prettyXml, readZip, writeZip, storedEntry, unzipEntry } = require('../src/main/officefile');

const docx = () => writeZip([
  storedEntry('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types xmlns="x"><Default Extension="png" ContentType="image/png"/></Types>')),
  storedEntry('word/document.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:document xmlns:w="w"><w:body><w:p><w:r><w:t xml:space="preserve"> Hi </w:t></w:r><w:r><w:t></w:t></w:r></w:p></w:body></w:document>')),
  { name: 'word/media/image1.png', method: 0, crc: zlib.crc32(Buffer.from([1, 2, 3])), size: 3, data: Buffer.from([1, 2, 3]) },
]);

test('prettyXml breaks only between tags, and twice is once', () => {
  const x = '<a><b> x </b><c></c><d/><e>t</e></a>';
  const p = prettyXml(x);
  assert.equal(p, '<a>\n  <b> x </b>\n  <c></c>\n  <d/>\n  <e>t</e>\n</a>');
  assert.equal(prettyXml(p), p);
});

test('an Office file opens as its XML parts and saves back with its binary parts', () => {
  const orig = docx();
  const text = officeToText(orig);
  assert.match(text, /<!-- breeze part: word\/document\.xml -->\n<\?xml[^\n]*\?>\n<w:document/);
  assert.ok(text.indexOf('word/document.xml') < text.indexOf('[Content_Types].xml'), 'the document comes first');
  assert.ok(!text.includes('image1.png -->'), 'binary parts stay out of the text');
  const edited = text.replace('> Hi <', '>Hello<');
  const saved = textToOffice(edited, orig);
  const entries = readZip(saved);
  assert.equal(entries[0].name, '[Content_Types].xml');
  assert.deepEqual([...unzipEntry(entries.find(e => e.name === 'word/media/image1.png'))], [1, 2, 3]);
  assert.match(unzipEntry(entries.find(e => e.name === 'word/document.xml')).toString(), /<w:t xml:space="preserve">Hello<\/w:t>/);
  assert.equal(officeToText(saved), edited, 'reading what was saved gives the same text');
});

test('a part left out of the text is left out of the file', () => {
  const orig = docx();
  const text = officeToText(orig).replace(/<!-- breeze part: \[Content_Types\]\.xml -->\n[^]*?(?=<!-- breeze part|$)/, '');
  assert.deepEqual(readZip(textToOffice(text, orig)).map(e => e.name).sort(), ['word/document.xml', 'word/media/image1.png']);
  assert.throws(() => textToOffice('no marks', orig), /breeze part/);
  assert.throws(() => textToOffice('<!-- breeze part: ../x.xml -->\n<a/>', orig), /not a part name/);
});

// A PDF with a compressed page, a compressed (binary) font and its objects packed in an object stream.
function pdf() {
  const content = zlib.deflateSync(Buffer.from('BT /F1 24 Tf 72 700 Td (Hello) Tj ET'));
  const font = zlib.deflateSync(Buffer.from([0, 1, 2, 255, 13, 10]));
  const cat = '<< /Type /Catalog /Pages 2 0 R >>', pages = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  const packed = `1 0 2 ${cat.length} `, objs = cat + pages;
  const objstm = zlib.deflateSync(Buffer.from(packed + objs));
  const parts = [
    '%PDF-1.5\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`, content, '\nendstream\nendobj\n',
    `5 0 obj\n<< /Length 6 0 R /Filter /FlateDecode >>\nstream\n`, font, '\nendstream\nendobj\n',
    `6 0 obj\n${font.length}\nendobj\n`,
    `7 0 obj\n<< /Type /ObjStm /N 2 /First ${packed.length} /Length ${objstm.length} /Filter /FlateDecode >>\nstream\n`, objstm, '\nendstream\nendobj\n',
    '8 0 obj\n<< /Type /XRef /Root 1 0 R /Size 9 /W [1 2 1] /Length 0 >>\nstream\n\nendstream\nendobj\nstartxref\n0\n%%EOF\n',
  ];
  return Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p, 'latin1')));
}

test('a PDF opens as its objects, readable, and saves as a PDF that opens the same', () => {
  const text = pdfToText(pdf());
  assert.match(text, /^%PDF-1\.5\n/);
  assert.match(text, /1 0 obj\n<< \/Type \/Catalog \/Pages 2 0 R >>\nendobj/, 'packed objects are objects of their own');
  assert.match(text, /4 0 obj\n<< \/Length 36 >>\nstream\nBT \/F1 24 Tf 72 700 Td \(Hello\) Tj ET\nendstream/, 'the page is inflated');
  const fontHex = zlib.deflateSync(Buffer.from([0, 1, 2, 255, 13, 10])).toString('hex');
  assert.match(text, /5 0 obj\n<< \/Length \d+ \/Filter \[\/ASCIIHexDecode \/FlateDecode\] >>\nstream\n/, 'binary data is hex, still compressed');
  assert.ok(text.includes(`stream\n${fontHex}>\nendstream`));
  assert.ok(!/\/Type \/(XRef|ObjStm)/.test(text));
  assert.match(text, /trailer\n<< \/Root 1 0 R >>\n$/);
  const saved = textToPdf(text.replace('(Hello)', '(Hello, world)'));
  const s = saved.toString('latin1');
  assert.match(s, /^%PDF-1\.5\n/);
  assert.match(s, /trailer\n<< \/Root 1 0 R \/Size 7 >>\nstartxref\n(\d+)\n%%EOF\n$/);
  const xrefAt = Number(/startxref\n(\d+)/.exec(s)[1]);
  assert.ok(s.startsWith('xref\n0 7\n', xrefAt));
  // Every listed offset points at its object.
  const rows = s.slice(xrefAt).split('\n').slice(2, 9);
  rows.forEach((r, n) => { if (r.includes(' n')) assert.ok(s.startsWith(`${n} 0 obj`, Number(r.slice(0, 10))), `object ${n}`); });
  const again = pdfToText(saved);
  assert.match(again, /\(Hello, world\) Tj/);
  assert.ok(again.includes(`stream\n${fontHex}>\nendstream`), 'the font came back byte for byte');
  assert.equal(pdfToText(textToPdf(again)), again, 'saving and reading again changes nothing');
});

test('an encrypted PDF is not read as text', () => {
  const enc = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R /Encrypt 2 0 R >>\n', 'latin1');
  assert.throws(() => pdfToText(enc), /encrypted/);
});

test('a new empty Office file or PDF reads as a blank document that saves back the same', () => {
  const { blankDocFile, docFileToText, textToDocFile } = require('../src/main/officefile');
  for (const ext of ['docx', 'xlsx', 'pptx', 'pdf']) {
    const path = `new.${ext}`, blank = blankDocFile(path);
    const text = docFileToText(path, Buffer.alloc(0));
    assert.equal(text, docFileToText(path, blank), `${ext}: an empty file reads as the blank one`);
    assert.equal(docFileToText(path, textToDocFile(path, text, blank)), text, `${ext}: saving changes nothing`);
  }
  assert.match(docFileToText('new.docx', Buffer.alloc(0)), /<!-- breeze part: word\/document\.xml -->\n[^]*<w:body>/);
  assert.match(docFileToText('new.pdf', Buffer.alloc(0)), /\/Type \/Page /);
});
