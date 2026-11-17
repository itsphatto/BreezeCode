// Breeze Space decides, per message, whether it is a chat reply or an agentic task (plan → steps → checks), and
// reads "every morning" or "when tests fail" into a schedule or trigger. Rules only: instant, free and the same
// every time. `/task` and `/chat` at the start of a message override it. No Electron, so
// test/agentintent.test.js can cover it.
import type { Schedule, Trigger } from './agentcore';

export interface Intent { agentic: boolean; goal: string; schedule: Schedule | null; trigger: Trigger | null; why: string }

const QUESTION_START = /^(?:what|why|how|who|whom|whose|where|when|which|is|are|was|were|am|can|could|would|will|does|do|did|should|shall|may|might|explain|tell me|describe|show me|what's|whats|how's)\b/i;
// Verbs that mean doing work. Three different ones in a message is several jobs.
const ACTIONS = ['fix', 'add', 'update', 'upgrade', 'refactor', 'migrate', 'run', 'test', 'deploy', 'create', 'build', 'write', 'remove',
  'delete', 'rename', 'move', 'clean', 'install', 'implement', 'review', 'commit', 'push', 'send', 'reply', 'archive', 'organize',
  'organise', 'summarize', 'summarise', 'generate', 'check', 'scan', 'download', 'upload', 'publish', 'release', 'bump', 'translate',
  'document', 'lint', 'format', 'convert', 'merge', 'split', 'replace', 'backup', 'sync', 'label', 'sort', 'post', 'notify', 'monitor'];
const SEQUENCE = /\b(?:and then|then|after that|afterwards|once (?:that|done|it)|finally|next,|step by step|followed by)\b/i;
const BIG_JOB = /\b(?:refactor|migrate|set ?up|implement|build (?:a|an|the|me)|port|rewrite|overhaul|audit|go through|fix (?:all|every)|update (?:all|every)|clean ?up (?:all|the whole)|across (?:the )?(?:project|codebase|repo))\b/i;
// Mail, chat and calendar chores: each one is several tool calls on a connected service.
const SERVICE = /\b(?:e-?mails?|inbox|gmail|outlook|discord|slack|telegram|calendar|notion|jira|linear|github issues?|pull requests?|prs?)\b/i;
const SERVICE_ACT = /\b(?:check|read|go through|delete|remove|clean|reply|respond|send|archive|label|sort|summari[sz]e|triage|moderate|post|schedule|close|merge|review)\b/i;
const PARALLEL = /\b(?:in parallel|at the same time|simultaneously|multiple agents|several agents)\b/i;

const pad = (n: number) => String(n).padStart(2, '0');
// "7", "7:30", "7pm", "19:00" → "HH:MM", or null.
function clock(h: string, m: string | undefined, ap: string | undefined): string | null {
  let hour = Number(h);
  const min = m ? Number(m) : 0;
  if (ap) { const pm = ap.toLowerCase() === 'pm'; if (hour === 12) hour = pm ? 12 : 0; else if (pm) hour += 12; }
  return hour >= 0 && hour <= 23 && min >= 0 && min <= 59 ? `${pad(hour)}:${pad(min)}` : null;
}

// The schedule or trigger a message asks for, if any.
export function readWhen(text: string): { schedule: Schedule | null; trigger: Trigger | null } {
  const t = text.toLowerCase();
  if (/\bwhen(?:ever)?\s+(?:the\s+)?(?:tests?|ci|the build)\s+(?:fails?|breaks?|go(?:es)? red)\b|\bon (?:test|build) failures?\b/.test(t)) return { schedule: null, trigger: { kind: 'testFail' } };
  const saved = /\bwhen(?:ever)?\s+(?:i\s+save|(?:a|any)\s+file\s+(?:is\s+)?(?:saved|changes?)|[\w./*-]+(?:\s+files?)?\s+(?:is|are)\s+saved)\b|\bon save\b/.exec(t);
  if (saved) {
    const glob = /([\w./-]*\*[\w./*-]*|[\w-]+\.\w{1,6})(?:\s+files?)?\s+(?:is|are)\s+saved/.exec(t)?.[1];
    return { schedule: null, trigger: glob ? { kind: 'save', match: glob } : { kind: 'save' } };
  }
  const every = /\bevery\s+(\d{1,3})\s*(?:hours?|hrs?|h)\b/.exec(t);
  if (every) { const hours = Number(every[1]); if (hours >= 1 && hours <= 168) return { schedule: { kind: 'every', hours }, trigger: null }; }
  if (/\b(?:every|each)\s+hour\b|\bhourly\b/.test(t)) return { schedule: { kind: 'every', hours: 1 }, trigger: null };
  const at = /\b(?:every\s+(?:day|morning|evening|night|weekday)|daily|each\s+(?:day|morning))\b[^.\n]*?\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(t)
    ?? /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+(?:every\s+(?:day|morning|evening|night)|daily|each\s+day)\b/.exec(t);
  if (at) { const c = clock(at[1], at[2], at[3]); if (c) return { schedule: { kind: 'daily', at: c }, trigger: null }; }
  if (/\b(?:every|each)\s+morning\b/.test(t)) return { schedule: { kind: 'daily', at: '09:00' }, trigger: null };
  if (/\b(?:every|each)\s+evening\b/.test(t)) return { schedule: { kind: 'daily', at: '18:00' }, trigger: null };
  if (/\b(?:every|each)\s+night\b|\bnightly\b/.test(t)) return { schedule: { kind: 'daily', at: '21:00' }, trigger: null };
  if (/\b(?:every|each)\s+day\b|\bdaily\b/.test(t)) return { schedule: { kind: 'daily', at: '09:00' }, trigger: null };
  return { schedule: null, trigger: null };
}

export function detectIntent(raw: string): Intent {
  const text = String(raw ?? '').trim();
  const override = /^\/(task|chat)\b\s*/i.exec(text);
  const goal = override ? text.slice(override[0].length).trim() : text;
  const { schedule, trigger } = readWhen(goal);
  const out = (agentic: boolean, why: string): Intent => ({ agentic, goal, schedule: agentic ? schedule : null, trigger: agentic ? trigger : null, why });
  if (!goal) return out(false, 'empty');
  if (override) return out(override[1].toLowerCase() === 'task', `/${override[1].toLowerCase()}`);
  if (schedule || trigger) return out(true, schedule ? 'schedule' : 'trigger');
  const lower = goal.toLowerCase();
  const steps = goal.split('\n').filter(l => /^\s*(?:\d+[.)]|[-*•])\s+\S/.test(l)).length;
  if (steps >= 2) return out(true, 'list of steps');
  const verbs = new Set(ACTIONS.filter(v => new RegExp(`\\b${v}(?:e?s|ed|ing)?\\b`, 'i').test(lower)));
  const question = QUESTION_START.test(goal) || (/\?\s*$/.test(goal) && goal.length < 240);
  // A plain question stays a chat, unless it clearly hands over a sequence of work.
  if (question && !SEQUENCE.test(goal) && verbs.size < 3) return out(false, 'question');
  if (PARALLEL.test(goal) && verbs.size >= 1) return out(true, 'parallel work');
  if (SEQUENCE.test(goal) && verbs.size >= 2) return out(true, 'sequence');
  if (verbs.size >= 3) return out(true, 'several jobs');
  if (SERVICE.test(goal) && SERVICE_ACT.test(goal)) return out(true, 'connected service');
  if (BIG_JOB.test(goal) && goal.length >= 25) return out(true, 'big job');
  return out(false, 'chat');
}
