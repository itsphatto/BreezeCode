// Serves the project to the preview iframe from breeze-preview://project/<path>.
// Chromium won't let a sandboxed frame load file:// stylesheets, scripts or images, so the preview has its own
// scheme. The frame keeps allow-same-origin (preview.ts): its origin is then breeze-preview://project, still not
// Breeze's file:// page, and without it every CORS load (fonts, module scripts, fetch, workers) and storage failed.
import { net } from 'electron';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { PREVIEW_INSPECTOR } from './previewInspector';
import { markdownPage } from './markdown';
import { agentBlocked } from './guard';

const PREVIEW_SCHEME = 'breeze-preview';
const PREVIEW_PRIVILEGES = { standard: true, secure: true, supportFetchAPI: true, stream: true };
// Pages scroll without a scrollbar in the preview, like the rest of Breeze (the sandboxed frame can't be styled from
// outside), and get the right-click element inspector (previewInspector.js).
const PREVIEW_STYLE = '<style data-breeze-preview>html,body{scrollbar-width:none}::-webkit-scrollbar{display:none;width:0;height:0}</style>' + PREVIEW_INSPECTOR;
// Goes right after <head> (or <html>) so the doctype stays first and the page keeps standards mode.
function withPreviewExtras(html: string): string {
  const at = /<head\b[^>]*>/i.exec(html) || /<html\b[^>]*>/i.exec(html);
  return at ? html.slice(0, at.index + at[0].length) + PREVIEW_STYLE + html.slice(at.index + at[0].length) : html + PREVIEW_STYLE;
}

// An artifact (a page or drawing an agent wrote in its reply, agents.ts) shows in a sandboxed frame from
// breeze-preview://artifact/. This page asks the chat for the artifact and writes it in, so it keeps this response's
// policy: inline code and a few CDNs run, nothing else loads, and the frame has no origin to reach Breeze or the
// project with.
const ARTIFACT_CDNS = 'https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com';
const ARTIFACT_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' blob: ${ARTIFACT_CDNS} https://cdn.tailwindcss.com https://code.jquery.com`,
  `style-src 'unsafe-inline' ${ARTIFACT_CDNS} https://fonts.googleapis.com`,
  `font-src data: ${ARTIFACT_CDNS} https://fonts.gstatic.com`,
  'img-src data: blob:', 'media-src data: blob:', `connect-src ${ARTIFACT_CDNS}`, 'worker-src blob:',
  "form-action 'none'", "base-uri 'none'",
].join('; ');
// It gets { artifact: code, kind } and builds the page itself, so the chat and check_artifact (main.ts) draw the same
// thing: an HTML artifact as written; a drawing filling its frame on white, whatever size it gives itself; a Mermaid
// diagram drawn by Mermaid from a CDN the policy allows. A diagram Mermaid can't parse shows its message and the
// source, not Mermaid's bare "Syntax error" bomb.
const ARTIFACT_LOADER = `<!doctype html><meta charset="utf-8"><script>
const STYLE = '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#fff}body{box-sizing:border-box;padding:16px}svg{display:block;width:100%;height:100%}</style>';
const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function drawMermaid() {
  const src = document.querySelector('.mermaid').textContent;
  mermaid.initialize({ startOnLoad: false, theme: 'neutral', suppressErrorRendering: true });
  mermaid.run().catch(e => {
    const p = document.createElement('pre');
    p.style.cssText = 'margin:0;font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;color:#333';
    p.textContent = 'Mermaid couldn\\u2019t draw this diagram:\\n' + (e && (e.message || e.str) || e) + '\\n\\n' + src;
    document.body.replaceChildren(p);
  });
}
const page = (kind, code) => kind === 'svg' ? STYLE + code
  : kind === 'mermaid' ? STYLE + '<style>.mermaid{margin:0;height:100%;display:flex;justify-content:center}</style><pre class="mermaid">' + esc(code)
    + '</pre><script src="https://cdn.jsdelivr.net/npm/mermaid@11.12.0/dist/mermaid.min.js"><\\/script><script>(' + drawMermaid + ')()<\\/script>'
  : code;
let done = false;
addEventListener('message', e => {
  if (done || e.source !== parent || typeof e.data?.artifact !== 'string') return;
  done = true;
  document.open(); document.write(page(e.data.kind, e.data.artifact)); document.close();
});
parent.postMessage({ artifactReady: true }, '*');
</script>`;
const artifactLoader = () => new Response(ARTIFACT_LOADER, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': ARTIFACT_CSP, 'Cache-Control': 'no-store' } });

// `resolveIn(rel)` maps a project-relative path to an absolute one, throwing when it leaves the project.
// .env files and .git are answered as Not found, like Live Share (agentBlocked, guard.ts): checked on the path as asked
// and again on the file finally served (a folder's index.html, a link, a short name or a trailing dot that Windows drops).
function createPreviewHandler(resolveIn: (rel: string) => string) {
  const refuse = (abs: string) => { if (agentBlocked(resolveIn(''), abs)) throw new Error('Not served'); };
  return async function servePreview(req: Request): Promise<Response> {
    if (new URL(req.url).host === 'artifact') return artifactLoader();
    try {
      const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '');
      let abs = resolveIn(rel);
      refuse(abs);
      let st = await fsp.stat(abs);
      if (st.isDirectory()) { abs = resolveIn(path.join(rel, 'index.html')); st = await fsp.stat(abs); } // it may be a link too
      if (!st.isFile()) throw new Error('Not a file');
      refuse(abs);
      // A Markdown file shows rendered, as a page; its images and links resolve from where it is, like on GitHub.
      if (/\.(md|markdown)$/i.test(abs)) {
        const page = markdownPage(await fsp.readFile(abs, 'utf8'), path.basename(abs));
        return new Response(withPreviewExtras(page), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
      }
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
        const stream = Readable.toWeb(fs.createReadStream(abs, { start, end })) as ReadableStream;
        return new Response(stream, { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) } });
      }
      return new Response(res.body, { status: res.status, headers });
    } catch {
      return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    }
  };
}

export { PREVIEW_SCHEME, PREVIEW_PRIVILEGES, createPreviewHandler, withPreviewExtras };
