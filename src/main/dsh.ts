// DeepSeek Harness (`dsh`), DeepSeek's own coding agent, run once per message in its headless mode: one JSON event per
// line on stdout, the prompt on stdin. Checked against dsh 0.2.2-rc.5, a developer preview that may change.
// Plain functions with no Electron, so test/dshagent.test.js can cover them.
import path from 'node:path';

type Loose = any; // dsh's JSON

// dsh sends DeepSeek each session's whole log unless told not to. Breeze's runs tell it not to.
export const DSH_PATCH = '- id: session-log-deepseek\n  config:\n    enabled: false\n';

// Headless can't ask the user, so whatever its sandbox doesn't allow is refused (`--approval-policy never`). Anything but
// Build is read-only whatever Full Access says.
export function dshArgs({ mode, full, patch, session }: { mode: string; full?: boolean; patch: string; session?: string | null }): string[] {
  const preset = mode !== 'build' ? 'read-only' : full ? 'danger-full-access' : 'workspace-write';
  // dsh's own flags end at the first one it doesn't know, so --profile and --patch come first.
  return ['--profile', 'headless', '--patch', patch, '--json', '--approval-policy', 'never', '--permission-mode', preset,
    ...(session ? ['--session-id', session] : []), '-'];
}

const DEEPSEEK_URL = 'https://api.deepseek.com/anthropic';
// Environment for a run. The key saved in Breeze is lent only when the user has given dsh none (`dshEnvFile`: the text
// of dsh's own .env), and with DeepSeek's address beside it, so nothing in the project can point it somewhere else.
export function dshEnv(env: Record<string, string | undefined>, savedKey: string | null | undefined, dshEnvFile = ''): Record<string, string> {
  const out: Record<string, string> = { DSH_TELEMETRY_DISABLED: '1' };
  const ownKey = env.DEEPSEEK_API_KEY || /^[ \t]*(?:export[ \t]+)?DEEPSEEK_API_KEY[ \t]*=/m.test(dshEnvFile);
  if (!savedKey || ownKey) return out;
  out.DEEPSEEK_API_KEY = savedKey;
  if (!env.DEEPSEEK_BASE_URL) out.DEEPSEEK_BASE_URL = DEEPSEEK_URL;
  return out;
}

// What to start. npm's Windows shim (dsh.cmd) needs a shell, which can't carry a path with a space, so the script it
// points at is run with node directly. Null when that script or node isn't there.
export function dshProgram(bin: string, node: string | null, exists: (file: string) => boolean): { command: string; first: string[] } | null {
  if (!/\.(?:cmd|bat)$/i.test(bin)) return { command: bin, first: [] };
  const script = path.join(path.dirname(bin), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  return node && exists(script) ? { command: node, first: [script] } : null;
}

// What one line means for the chat. Besides the run events Breeze sends the page, `output` is a command's output,
// `todos` a task list and `lastError` why the process is about to fail.
export type DshEvent = { t: string; [key: string]: Loose };
const REFUSED = new Set(['FS_SANDBOX_DENIED', 'SANDBOX_ESCALATION_REJECTED']);
const ERRORS: Record<string, string> = {
  MISSING_CREDENTIAL: 'DeepSeek CLI needs a DeepSeek API key. Paste one in the agent picker, or set DEEPSEEK_API_KEY.',
  TRANSPORT: "Couldn't reach DeepSeek. Check your internet connection.",
};
// Reads one run's lines in order. `rel` shortens a path for showing.
export function dshReader(rel: (p: string) => string): (d: Loose, mode: string) => DshEvent[] {
  const calls = new Map<string, { tool: string; input: Loose }>();
  let tokens = 0, lastText = '';
  const toolDone = (d: Loose): DshEvent[] => {
    const c = calls.get(d.callId);
    if (!c) return [];
    calls.delete(d.callId);
    const { tool, input } = c;
    const file = typeof input?.file_path === 'string' ? rel(input.file_path) : '';
    const shell = tool === 'pwsh' || tool === 'bash';
    const row = (kind: string, label: string): DshEvent => ({ t: 'tool', kind, label });
    if (d.status === 'error') {
      const what = shell ? `$ ${input?.command ?? ''}` : [tool, file].filter(Boolean).join(' ');
      return [row('tool', `${REFUSED.has(d.error?.code) ? 'Not allowed' : 'Failed'}: ${what}`)];
    }
    if (shell) return [row('run', `$ ${input?.command ?? ''}`), ...(d.result ? [{ t: 'output', text: String(d.result) }] : [])];
    if ((tool === 'edit' || tool === 'write') && file) {
      const created = tool === 'write' && /\bCreated file\b/.test(String(d.result ?? ''));
      return [row('edit', `${created ? 'Created' : 'Edited'} ${file}`), { t: 'file', path: file, created, written: true }];
    }
    if (tool === 'read' && file) return [row('read', `Read ${file}`)];
    if (tool === 'todo_write') return [{ t: 'todos', todos: input?.todos }];
    if (tool === 'web_search') return [row('web', `Searched the web for ${input?.query ?? ''}`)];
    if (tool === 'web_fetch') return [row('web', `Opened ${input?.url ?? 'a page'}`)];
    if (tool === 'grep' || tool === 'glob') return [row('search', `Searched for ${input?.pattern ?? ''}`)];
    return [row('tool', tool)];
  };
  const finish = (d: Loose, mode: string): DshEvent[] => {
    if (d.reason?.kind !== 'completed') {
      const e = d.reason?.error;
      return [{ t: 'error', text: ERRORS[e?.code] || e?.message || 'DeepSeek CLI stopped before it finished' }, { t: 'done', ok: false, tokens }];
    }
    const out: DshEvent[] = [];
    if (!lastText && d.text) { lastText = String(d.text); out.push({ t: 'text', text: lastText }); }
    if (mode === 'plan' && lastText) out.push({ t: 'plan', text: lastText });
    return [...out, { t: 'done', ok: true, tokens }];
  };
  return (d, mode) => {
    switch (d?.type) {
      case 'session': return [{ t: 'session', id: d.sessionId }];
      case 'text':
        if (!d.text) return [];
        lastText = String(d.text);
        return [{ t: 'text', text: lastText }];
      case 'status':
        if (d.usage) tokens += d.usage.totalTokens ?? (d.usage.inputTokens || 0) + (d.usage.outputTokens || 0);
        return [];
      case 'tool_call': calls.set(d.callId, { tool: String(d.tool ?? 'tool'), input: d.input }); return [];
      case 'tool_result': return toolDone(d);
      case 'error': return [{ t: 'lastError', text: String(d.message || 'DeepSeek CLI ran into an error') }];
      case 'final': return finish(d, mode);
      default: return []; // a type this version of Breeze doesn't know
    }
  };
}

// Why dsh failed before its first event, out of its stderr: its own sentence rather than the stack around it.
export function dshFailure(stderr: string): string | null {
  return /^(?:Error: )?dsh: (.+)$/m.exec(stderr)?.[1].trim() ?? null;
}
