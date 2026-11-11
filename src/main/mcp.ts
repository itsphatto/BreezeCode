// MCP servers connected in Breeze: kept in Breeze's own state and handed to each Claude Code run with --mcp-config,
// so Claude Code's own config files are never edited. A server is a command Breeze starts (stdio) or a URL (http).
// The servers Claude Code already has set up are read too, so the Skills view can show them beside Breeze's.
import * as fs from 'node:fs';
import * as path from 'node:path';

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_KEY = /^[A-Za-z0-9-]{1,128}$/;

// A command line split into words: whitespace separates them, and "double" or 'single' quotes keep spaces in one.
function splitCommand(line: unknown): string[] {
  const out: string[] = [];
  let word = '', quote = '', has = false;
  for (const ch of String(line ?? '')) {
    if (quote) { if (ch === quote) quote = ''; else word += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (has) out.push(word); word = ''; has = false; continue; }
    word += ch; has = true;
  }
  if (quote) throw new Error('A quote in the command is never closed');
  if (has) out.push(word);
  return out;
}

// "KEY=value" (env) or "Name: value" (headers) lines into an object; blank lines are skipped.
function parsePairs(text: unknown, sep: string, keyRe: RegExp, what: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const i = line.indexOf(sep);
    const key = i > 0 ? line.slice(0, i).trim() : '';
    if (!keyRe.test(key)) throw new Error(`"${line}" isn't a ${what} (use ${what === 'header' ? 'Name: value' : 'NAME=value'})`);
    out[key] = line.slice(i + 1).trim();
  }
  return out;
}

// What the Connect dialog sent, checked and tidied into a stored server.
export interface McpServer {
  name: string;
  type?: 'http' | 'stdio' | 'sse';
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}
interface ServerInput { name?: unknown; type?: unknown; url?: unknown; headers?: unknown; command?: unknown; env?: unknown }

function normalizeServer(input: ServerInput | null | undefined, existing: McpServer[] = []): McpServer {
  const name = String(input?.name ?? '').trim();
  if (!NAME.test(name)) throw new Error('Name it with letters, numbers, - or _ (no spaces)');
  if (existing.some(s => s.name.toLowerCase() === name.toLowerCase())) throw new Error(`There's already a server called ${name}`);
  if (input?.type === 'http') {
    let url: URL;
    try { url = new URL(String(input.url ?? '').trim()); } catch { throw new Error('That URL isn\'t valid'); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The URL must start with https:// or http://');
    return { name, type: 'http', url: url.href, headers: parsePairs(input.headers, ':', HEADER_KEY, 'header') };
  }
  const [command, ...args] = splitCommand(input?.command);
  if (!command) throw new Error('Enter the command that starts the server, like npx -y @modelcontextprotocol/server-github');
  return { name, type: 'stdio', command, args, env: parsePairs(input?.env, '=', ENV_KEY, 'variable') };
}

// The servers in Claude Code's --mcp-config format.
function claudeMcpConfig(servers: McpServer[]) {
  const mcpServers: Record<string, unknown> = {};
  for (const s of servers) {
    mcpServers[s.name] = s.type === 'http'
      ? { type: 'http', url: s.url, ...(Object.keys(s.headers ?? {}).length ? { headers: s.headers } : {}) }
      : { type: 'stdio', command: s.command, args: s.args ?? [], ...(Object.keys(s.env ?? {}).length ? { env: s.env } : {}) };
  }
  return { mcpServers };
}

// Shown in the list: what a server runs or where it connects. Env and header values (often keys) are left out.
function serverDetail(s: Partial<McpServer>): string {
  if (s.type === 'http' || s.type === 'sse' || s.url) return s.url ?? '';
  return [s.command, ...(s.args ?? [])].filter(Boolean).join(' ');
}

// The servers Claude Code has set up itself: user ones and this project's local ones in .claude.json, and the
// project's shared .mcp.json. Read only.
function claudeConfigured({ claudeJson, root }: { claudeJson: string; root?: string }) {
  const read = (f: string) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const out: { name: string; scope: string; type: string; detail: string }[] = [];
  const add = (servers: Record<string, Partial<McpServer>> | undefined, scope: string) => {
    for (const [name, s] of Object.entries(servers ?? {})) out.push({ name, scope, type: s?.url ? 'http' : 'stdio', detail: serverDetail(s ?? {}) });
  };
  const cfg = read(claudeJson);
  add(cfg?.mcpServers, 'user');
  if (root) {
    const key = Object.keys(cfg?.projects ?? {}).find(k => path.resolve(k).toLowerCase() === path.resolve(root).toLowerCase());
    if (key) add(cfg.projects[key].mcpServers, 'local');
    add(read(path.join(root, '.mcp.json'))?.mcpServers, 'project');
  }
  return out;
}

export { splitCommand, parsePairs, normalizeServer, claudeMcpConfig, serverDetail, claudeConfigured };
