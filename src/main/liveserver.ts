// Live Share's request handler: a small local-only static server for the open project. Files are read on each request,
// so a browser refresh always sees what is on disk; connected pages get a reload event after edits (main.ts).
// Plain Node with no Electron, so test/liveserver.test.js can run it.
//
// The port is fixed (2026), so the address alone is no secret: any web page could embed the files with <script>,
// <img> or <link>. Each session therefore serves under a random path, http://127.0.0.1:2026/<token>/. Visiting it sets
// an HttpOnly, SameSite=Strict cookie holding the token, so a project's root-relative URLs (src="/app.js") keep working:
// a request outside the token path is answered only with that cookie AND from the page's own origin (Sec-Fetch-Site
// same-origin or none, or no Fetch Metadata at all). SameSite alone isn't enough: another port on this computer is the
// same site. The reload stream answers only under the token path. Everything else is Not found.
import * as crypto from 'node:crypto';
import * as fsp from 'node:fs/promises';
import type * as http from 'node:http';
import * as path from 'node:path';
import { resolveUnder, agentBlocked, isLocalHost } from './guard';

const LIVE_RELOAD = '__breeze_live_reload';
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.wasm': 'application/wasm',
};
// 192 random bits, URL-safe.
const newLiveToken = (): string => crypto.randomBytes(24).toString('base64url');
const sameSecret = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
// The cookie's name carries the port: cookies don't keep ports apart, and other local servers share 127.0.0.1.
const cookieName = (port: number) => `breeze_live_${port}`;
function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of String(header || '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}
// Only the page's own requests: a top-level visit (none), the page loading its files (same-origin), or a browser that
// sends no Fetch Metadata (the SameSite cookie still has to be there).
const ownOrigin = (site: string | string[] | undefined) => site === undefined || site === 'same-origin' || site === 'none';

interface LiveOptions {
  port: number;
  token: string;
  root: () => string | null; // the folder being shared
  addClient: (res: http.ServerResponse) => void; // a page listening for reloads; main.ts removes it on close
}
function createLiveHandler({ port, token, root, addClient }: LiveOptions) {
  const prefix = `/${token}`;
  const cookie = cookieName(port);
  const reloadScript = `<script>(() => { const s = new EventSource('${prefix}/${LIVE_RELOAD}'); s.onmessage = () => location.reload(); })();</script>`;
  // Never embeddable by another origin, never leaking the token in a Referer, never sniffed into another type.
  const COMMON = { 'Cache-Control': 'no-store', 'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
  const answer = (res: http.ServerResponse, status: number, text: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...COMMON, 'Content-Type': 'text/plain; charset=utf-8', ...extra });
    res.end(text);
  };
  return async function serveLive(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!isLocalHost(req.headers.host, port)) return answer(res, 403, 'Forbidden');
    try {
      const base = root();
      if (!base) throw new Error('Not sharing');
      const pathname = new URL(req.url || '/', `http://127.0.0.1:${port}`).pathname;
      if (pathname === prefix) return answer(res, 302, 'Found', { Location: `${prefix}/` }); // relative URLs need the slash
      let rest: string;
      const viaToken = pathname.startsWith(`${prefix}/`);
      if (viaToken) rest = pathname.slice(prefix.length);
      else if (sameSecret(cookieValue(req.headers.cookie, cookie) ?? '', token) && ownOrigin(req.headers['sec-fetch-site'])) rest = pathname;
      else throw new Error('No token');
      // The token rides along on every answer under its path, so the page's root-relative loads find it.
      const setCookie: Record<string, string> = viaToken ? { 'Set-Cookie': `${cookie}=${token}; Path=/; HttpOnly; SameSite=Strict` } : {};
      if (viaToken && rest === `/${LIVE_RELOAD}`) {
        res.writeHead(200, { ...COMMON, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(': connected\n\n');
        addClient(res);
        return;
      }
      const decoded = decodeURIComponent(rest);
      const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
      let abs = resolveUnder(base, rel);
      let st = await fsp.stat(abs);
      if (st.isDirectory()) {
        abs = resolveUnder(base, path.join(rel, 'index.html'));
        st = await fsp.stat(abs);
      }
      if (!st.isFile()) throw new Error('Not a file');
      if (agentBlocked(base, abs)) throw new Error('Not shared'); // .env files and .git stay private: answered as Not found
      const type = MIME_TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream';
      let body: Buffer = await fsp.readFile(abs);
      if (type.startsWith('text/html')) {
        const html = body.toString('utf8');
        body = Buffer.from(/<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, `${reloadScript}</body>`) : html + reloadScript);
      }
      res.writeHead(200, { ...COMMON, 'Content-Type': type, ...setCookie });
      res.end(body);
    } catch {
      answer(res, 404, 'Not found');
    }
  };
}

export { createLiveHandler, newLiveToken, LIVE_RELOAD, MIME_TYPES };
