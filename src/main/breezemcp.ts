// The MCP server Breeze hosts itself, so agents that run as a command line (Claude Code, Codex) can reach the same
// tools the local model has: asking the user a question, showing a picture, capturing the preview.
// It listens on this computer only. Each run gets its own address with a random token in it, which stops working
// when the run ends. No Electron here: main.ts passes `call`, which does the work of a tool.
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { isLocalHost } from './guard';

export const BREEZE_MCP = 'breeze';
export interface McpTool { name: string; description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> }
// What a tool gives back: text for the agent, and optionally a picture it can look at.
export interface ToolReply { text: string; isError?: boolean; image?: { data: string; mimeType: string } }
export type ToolCall = (runId: number, name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<ToolReply>;

const ASK_USER: McpTool = {
  name: 'ask_user',
  description: 'Ask the user one question and wait for the answer. It shows as a card with a button for each option and a box for another answer. Use it when the request is unclear and a wrong guess would waste work.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'One short question' },
      options: { type: 'array', description: '2 to 4 answers to pick from (6 at most)', items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string', description: 'What picking it means' } }, required: ['label'] } },
      multiSelect: { type: 'boolean', description: 'Let the user pick more than one option' },
    },
    required: ['question'],
  },
  annotations: { readOnlyHint: true },
};
const BREEZE_TOOLS: McpTool[] = [ASK_USER];

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY = 1024 * 1024;
const KEEPALIVE_MS = 15000;

interface RpcMessage { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> }
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

// One JSON-RPC message in, its reply out. Null for a notification, which gets no reply.
async function handleRpc(msg: RpcMessage | null | undefined, tools: McpTool[], call: (name: string, args: Record<string, unknown>) => Promise<ToolReply>): Promise<Record<string, unknown> | null> {
  if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return rpcError(msg?.id, -32600, 'Not a JSON-RPC request');
  if (msg.id === undefined || msg.id === null) return null;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
  if (msg.method === 'initialize') {
    const asked = String(msg.params?.protocolVersion ?? '');
    return ok({ protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0], capabilities: { tools: {} }, serverInfo: { name: BREEZE_MCP, title: 'Breeze (built in)', version: '1.0.0' } });
  }
  if (msg.method === 'ping') return ok({});
  if (msg.method === 'tools/list') return ok({ tools });
  if (msg.method === 'tools/call') {
    const name = String(msg.params?.name ?? '');
    if (!tools.some(t => t.name === name)) return rpcError(msg.id, -32602, `There is no tool called ${name}`);
    const args = msg.params?.arguments;
    let reply: ToolReply;
    // A tool that fails answers with the reason, so the agent can read it and try something else.
    try { reply = await call(name, args && typeof args === 'object' ? args as Record<string, unknown> : {}); }
    catch (err) { reply = { text: (err as Error).message, isError: true }; }
    const content: Record<string, unknown>[] = [{ type: 'text', text: reply.text }];
    if (reply.image) content.push({ type: 'image', data: reply.image.data, mimeType: reply.image.mimeType });
    return ok({ content, isError: reply.isError === true });
  }
  return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
}

class BreezeMcpServer {
  #tools: McpTool[];
  #call: ToolCall;
  #server: http.Server | null = null;
  #port = 0;
  #runs = new Map<string, number>(); // token -> run id

  constructor({ tools = BREEZE_TOOLS, call }: { tools?: McpTool[]; call: ToolCall }) {
    this.#tools = tools;
    this.#call = call;
  }

  // Starts listening the first time it is needed; resolves with the port.
  listen(): Promise<number> {
    if (this.#server) return Promise.resolve(this.#port);
    return new Promise<number>((resolve, reject) => {
      const server = http.createServer((req, res) => { this.#serve(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.#server = server;
        this.#port = (server.address() as AddressInfo).port;
        server.unref(); // never keeps the app open
        resolve(this.#port);
      });
    });
  }

  // The address one run connects to, or null before listen(). Hex and digits only, so it passes through a shell as is.
  open(runId: number): string | null {
    if (!this.#server) return null;
    this.close(runId);
    const token = crypto.randomBytes(24).toString('hex');
    this.#runs.set(token, runId);
    return `http://127.0.0.1:${this.#port}/mcp/${token}`;
  }

  close(runId: number): void {
    for (const [token, id] of [...this.#runs]) if (id === runId) this.#runs.delete(token);
  }

  stop(): void {
    this.#server?.close();
    this.#server?.closeAllConnections();
    this.#server = null;
    this.#runs.clear();
  }

  async #serve(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const plain = (status: number, text: string) => { res.writeHead(status, { 'Content-Type': 'text/plain' }); res.end(text); };
    // Only this computer may ask (guard.isLocalHost), and only with a live run's token.
    if (!isLocalHost(req.headers.host, this.#port)) return plain(403, 'Forbidden');
    const token = /^\/mcp\/([0-9a-f]{48})$/.exec((req.url ?? '').split('?')[0])?.[1];
    const runId = token ? this.#runs.get(token) : undefined;
    if (runId === undefined) return plain(404, 'Not found');
    if (req.method === 'DELETE') return plain(200, ''); // the client ending its session
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST, DELETE' }); res.end(); return; }

    let body = '';
    req.setEncoding('utf8');
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY) return plain(413, 'Too large');
    }
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rpcError(null, -32700, 'Parse error')));
      return;
    }
    const batch = Array.isArray(parsed);
    const messages = (batch ? parsed : [parsed]) as RpcMessage[];

    // A tool call can wait on the user for minutes. Its reply goes out as an event stream with a comment line now and
    // then, so the client's own timeouts (no headers yet, a silent connection) don't end the wait.
    const slow = messages.some(m => m?.method === 'tools/call');
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); }); // the agent gave up or was stopped
    let beat: ReturnType<typeof setInterval> | undefined;
    if (slow) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(': waiting\n\n');
      beat = setInterval(() => res.write(': waiting\n\n'), KEEPALIVE_MS);
    }
    const replies: Record<string, unknown>[] = [];
    try {
      for (const m of messages) {
        const reply = await handleRpc(m, this.#tools, (name, args) => this.#call(runId, name, args, abort.signal));
        if (reply) replies.push(reply);
      }
    } finally { clearInterval(beat); }
    if (slow) {
      for (const r of replies) res.write(`event: message\ndata: ${JSON.stringify(r)}\n\n`);
      res.end();
    } else if (!replies.length) {
      res.writeHead(202);
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(batch ? replies : replies[0]));
    }
  }
}

export { BREEZE_TOOLS, handleRpc, BreezeMcpServer };
