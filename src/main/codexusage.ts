// Codex's token numbers: a thread's running totals, and its session log (rollout-*-<thread id>.jsonl, filed under
// sessions/YYYY/MM/DD by the day the thread started). Plain functions, so test/codexusage.test.js can cover them.
// `output_tokens` already includes the reasoning tokens, and `input_tokens` the cached ones.
import fs from 'node:fs';
import path from 'node:path';

export interface CodexUsage { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number }

// What was used between two running totals (`before` null: since the thread started).
export function codexStep(now: CodexUsage, before: CodexUsage | null): { input: number; cacheRead: number; output: number } {
  const grew = (k: keyof CodexUsage) => Math.max(0, (now[k] || 0) - (before?.[k] || 0));
  const cacheRead = grew('cached_input_tokens');
  return { input: Math.max(0, grew('input_tokens') - cacheRead), cacheRead, output: grew('output_tokens') };
}

// `codex exec` ends a turn with the thread's running total, so a resumed chat's earlier turns are taken off.
export function codexTurnTokens(usage: CodexUsage | undefined, before: CodexUsage | null): number {
  const s = codexStep(usage || {}, before);
  return s.input + s.cacheRead + s.output;
}

// A thread id is a UUIDv7, which starts with the time it was made. Else the last few days' folders are searched.
export function codexLogFile(base: string, thread: string): string | null {
  const made = /^([0-9a-f]{8})-([0-9a-f]{4})-7/i.exec(thread);
  const days = [...(made ? [parseInt(made[1]! + made[2]!, 16)] : []), ...[0, 1, 2].map(back => Date.now() - back * 86_400_000)];
  for (const ms of days) {
    const d = new Date(ms);
    const dir = path.join(base, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    const name = fs.existsSync(dir) && fs.readdirSync(dir).find(n => n.endsWith(`${thread}.jsonl`));
    if (name) return path.join(dir, name);
  }
  return null;
}
