// Serves the project to the preview iframe from breeze-preview://project/<path>.
// Chromium won't let a sandboxed frame load file:// stylesheets, scripts or images, so the preview has its own
// scheme. The frame keeps allow-same-origin (preview.ts): its origin is then breeze-preview://project, still not
// Breeze's file:// page, and without it every CORS load (fonts, module scripts, fetch, workers) and storage failed.
const { net } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pathToFileURL } = require('node:url');
const { PREVIEW_INSPECTOR } = require('./previewInspector');

const PREVIEW_SCHEME = 'breeze-preview';
const PREVIEW_PRIVILEGES = { standard: true, secure: true, supportFetchAPI: true, stream: true };
// Pages scroll without a scrollbar in the preview, like the rest of Breeze (the sandboxed frame can't be styled from
// outside), and get the right-click element inspector (previewInspector.js).
const PREVIEW_STYLE = '<style data-breeze-preview>html,body{scrollbar-width:none}::-webkit-scrollbar{display:none;width:0;height:0}</style>' + PREVIEW_INSPECTOR;
// Goes right after <head> (or <html>) so the doctype stays first and the page keeps standards mode.
function withPreviewExtras(html) {
  const at = /<head\b[^>]*>/i.exec(html) || /<html\b[^>]*>/i.exec(html);
  return at ? html.slice(0, at.index + at[0].length) + PREVIEW_STYLE + html.slice(at.index + at[0].length) : html + PREVIEW_STYLE;
}

// `resolveIn(rel)` maps a project-relative path to an absolute one, throwing when it leaves the project.
function createPreviewHandler(resolveIn) {
  return async function servePreview(req) {
    try {
      const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '');
      let abs = resolveIn(rel);
      if ((await fsp.stat(abs)).isDirectory()) abs = resolveIn(path.join(rel, 'index.html')); // it may be a link too
      const res = await net.fetch(pathToFileURL(abs).href);
      const type = res.headers.get('content-type') || 'application/octet-stream';
      const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
      if (/text\/html/i.test(type)) return new Response(withPreviewExtras(await res.text()), { status: res.status, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
      // Video and audio seek with byte ranges; without a 206 answer they can only play from the start.
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') || '');
      if (range && (range[1] || range[2])) {
        res.body?.cancel().catch(() => {});
        const { size } = await fsp.stat(abs);
        const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
        const stream = Readable.toWeb(fs.createReadStream(abs, { start, end }));
        return new Response(stream, { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) } });
      }
      return new Response(res.body, { status: res.status, headers });
    } catch {
      return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    }
  };
}

module.exports = { PREVIEW_SCHEME, PREVIEW_PRIVILEGES, createPreviewHandler, withPreviewExtras };
