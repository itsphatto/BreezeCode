// The agentic brain behind Breeze Space's tasks: it turns a goal into steps, hands each step to one of the agents Breeze already runs
// (Claude, Codex, Antigravity, the local model), checks the result, retries, and asks when it is stuck.
// It also keeps the queue, the schedules and the trigger limits. No Electron here: main.ts passes in how to run a
// step, ask the user and save, so test/agentcore.test.js can drive it with fakes.
import * as crypto from 'node:crypto';
import { ControlLevel, isControlLevel } from './deviceguard';

export type TaskStatus = 'planning' | 'awaiting' | 'queued' | 'running' | 'paused' | 'waiting' | 'done' | 'failed' | 'cancelled';
export type StepStatus = 'todo' | 'running' | 'done' | 'failed' | 'skipped';
export interface Step { id: number; title: string; detail?: string; status: StepStatus; tries: number; note?: string }
export type Schedule = { kind: 'daily'; at: string } | { kind: 'every'; hours: number };
export type TriggerKind = 'save' | 'commit' | 'testFail' | 'prComment';
export const TRIGGER_KINDS: TriggerKind[] = ['save', 'commit', 'testFail', 'prComment'];
export interface Trigger { kind: TriggerKind; match?: string }
export interface LogLine { at: number; text: string }
export interface Task {
  id: string; goal: string; project: string; agent: string;
  control: ControlLevel; device: boolean;
  steps: Step[]; status: TaskStatus; log: LogLine[];
  createdAt: number; updatedAt: number; order: number;
  schedule?: Schedule | null; trigger?: Trigger | null;
  nextRunAt?: number | null; lastRunAt?: number | null;
  unattended?: boolean;      // this run was started by a schedule or trigger
  session?: string | null;   // the agent's conversation, so later steps remember earlier ones
  error?: string | null;
  replans?: number;
}
export interface NewTask { goal: string; project: string; agent: string; control?: unknown; device?: unknown; schedule?: unknown; trigger?: unknown }

export const MAX_STEPS = 12;
export const MAX_RETRIES = 2;
export const MAX_REPLANS = 3;
export const PER_PROJECT = 1;
export const TOTAL_RUNNING = 2;
export const TRIGGER_DEBOUNCE_MS = 5000;
export const TRIGGER_CAP_PER_HOUR = 10;
const MAX_LOG = 200;
const MAX_GOAL = 4000;

/* ----- Input checks ----- */
export function cleanSchedule(v: unknown): Schedule | null {
  const s = v as Partial<Schedule> | null;
  if (!s || typeof s !== 'object') return null;
  if (s.kind === 'daily' && typeof (s as { at?: unknown }).at === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test((s as { at: string }).at)) return { kind: 'daily', at: (s as { at: string }).at };
  const hours = Number((s as { hours?: unknown }).hours);
  if (s.kind === 'every' && Number.isFinite(hours) && hours >= 1 && hours <= 168) return { kind: 'every', hours: Math.round(hours) };
  return null;
}
export function cleanTrigger(v: unknown): Trigger | null {
  const t = v as Partial<Trigger> | null;
  if (!t || typeof t !== 'object' || !TRIGGER_KINDS.includes(t.kind as TriggerKind)) return null;
  const match = typeof t.match === 'string' ? t.match.trim().slice(0, 200) : '';
  return match ? { kind: t.kind as TriggerKind, match } : { kind: t.kind as TriggerKind };
}

/* ----- Plans and verdicts ----- */
// The steps in an agent's plan: a JSON array (of strings or {title, detail}) wherever it is in the reply, else a
// numbered or bulleted list. At most MAX_STEPS.
export function parsePlan(text: string): { title: string; detail?: string }[] {
  const tidy = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const fromArray = (arr: unknown[]) => arr.map(x => (typeof x === 'string' ? { title: tidy(x) }
    : x && typeof x === 'object' ? { title: tidy((x as Record<string, unknown>).title ?? (x as Record<string, unknown>).step ?? (x as Record<string, unknown>).name), detail: tidy((x as Record<string, unknown>).detail ?? (x as Record<string, unknown>).description) || undefined }
    : { title: '' })).filter(s => s.title).slice(0, MAX_STEPS);
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(m => m[1]);
  const bare = text.match(/\[[\s\S]*\]/)?.[0];
  for (const raw of [...blocks, bare].filter(Boolean) as string[]) {
    try {
      const j = JSON.parse(raw.trim());
      const arr = Array.isArray(j) ? j : Array.isArray(j?.steps) ? j.steps : null;
      if (arr) { const steps = fromArray(arr); if (steps.length) return steps; }
    } catch { /* not JSON: try the next */ }
  }
  const list = text.split('\n').map(l => /^\s*(?:\d+[.)]|[-*•])\s+(.+)$/.exec(l)?.[1]).filter(Boolean) as string[];
  return list.map(l => ({ title: tidy(l.replace(/\*\*/g, '')) })).filter(s => s.title).slice(0, MAX_STEPS);
}

// Whether a step's reply says it finished: a last STEP_DONE or STEP_FAILED: <why> line wins, else how the run ended.
export function parseVerdict(text: string, runOk: boolean): { ok: boolean; note: string } {
  const lines = text.trim().split('\n').reverse();
  for (const l of lines) {
    const m = /^\s*\**\s*STEP[_ ](DONE|FAILED)\**\s*:?\s*(.*)$/i.exec(l);
    if (m) return { ok: m[1].toUpperCase() === 'DONE', note: m[2].trim().slice(0, 300) };
  }
  return { ok: runOk, note: runOk ? '' : 'The agent stopped before finishing.' };
}

// The reply as the chat shows it: the STEP_DONE / STEP_FAILED line is for the brain, not the reader.
export function stripStepMarkers(text: string): string {
  return text.split('\n').filter(l => !/^\s*\**\s*STEP[_ ](?:DONE|FAILED)\b/i.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

export function planPrompt(task: Task, memory: string, feedback?: string): string {
  return [
    'You are Breeze, planning an agentic task for the user. Do not change anything yet.',
    `Project folder: ${task.project}`,
    memory,
    `Goal: ${task.goal}`,
    feedback ? `The user asked for changes to your last plan: ${feedback}` : '',
    `Reply with only a JSON array of 1 to ${MAX_STEPS} steps, each {"title": "...", "detail": "..."}. Each step must be one`,
    'thing an agent can finish and check on its own. Order them so each builds on the last.',
  ].filter(Boolean).join('\n\n');
}

export function stepPrompt(task: Task, step: Step, memory: string): string {
  const done = task.steps.filter(s => s.status === 'done').map(s => `- ${s.title}`).join('\n');
  const rules = [
    'Stay inside the project folder unless a Breeze device tool lets you go further.',
    task.control === 'plan' || task.control === 'ask' ? 'Do not git push, publish or send anything outside this computer: use ask_user first.' : '',
    'Use the remember tool for lasting facts about the user or project that would help later tasks. Never remember secrets.',
    'When the step is finished and checked, end your reply with a line: STEP_DONE',
    'If you cannot finish it, end with: STEP_FAILED: <the reason in one line>',
  ].filter(Boolean);
  return [
    `You are Breeze, running step ${step.id} of ${task.steps.length} of a task.`,
    `Goal of the whole task: ${task.goal}`,
    memory,
    done ? `Already done:\n${done}` : '',
    `This step: ${step.title}${step.detail ? `\n${step.detail}` : ''}`,
    step.tries ? `The last try failed: ${step.note || 'no reason given'}. Try a different way.` : '',
    rules.join('\n'),
  ].filter(Boolean).join('\n\n');
}

/* ----- Schedules ----- */
// The next time a schedule fires after `from` (local time for daily).
export function nextRunAt(s: Schedule, from: number): number {
  if (s.kind === 'every') return from + s.hours * 3600000;
  const [h, m] = s.at.split(':').map(Number);
  const d = new Date(from);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  return d.getTime();
}
// Tasks whose schedule is due. A run missed while Breeze was closed fires once, not once per missed slot.
export function dueTasks(tasks: Task[], now: number): Task[] {
  return tasks.filter(t => t.schedule && t.status === 'waiting' && t.nextRunAt != null && t.nextRunAt <= now);
}

/* ----- Queue ----- */
// The queued tasks that may start now: in queue order, one per project, TOTAL_RUNNING across all.
export function pickRunnable(tasks: Task[], busy: Set<string>, limits = { perProject: PER_PROJECT, total: TOTAL_RUNNING }): Task[] {
  const active = tasks.filter(t => busy.has(t.id));
  const perProject = new Map<string, number>();
  for (const t of active) perProject.set(t.project, (perProject.get(t.project) ?? 0) + 1);
  const out: Task[] = [];
  for (const t of tasks.filter(x => x.status === 'queued' && !busy.has(x.id)).sort((a, b) => a.order - b.order)) {
    if (active.length + out.length >= limits.total) break;
    if ((perProject.get(t.project) ?? 0) >= limits.perProject) continue;
    perProject.set(t.project, (perProject.get(t.project) ?? 0) + 1);
    out.push(t);
  }
  return out;
}

/* ----- Triggers ----- */
export interface TriggerEvent { kind: TriggerKind; project: string; path?: string; text?: string }
// A glob-ish match: * matches within a name, ** across folders; a plain word matches anywhere in the path or text.
export function matchTrigger(task: Task, ev: TriggerEvent, samePath: (a: string, b: string) => boolean): boolean {
  const t = task.trigger;
  if (!t || t.kind !== ev.kind || !samePath(task.project, ev.project)) return false;
  if (!t.match) return true;
  const hay = (ev.path ?? ev.text ?? '').replace(/\\/g, '/');
  if (!/[*?]/.test(t.match)) return hay.toLowerCase().includes(t.match.toLowerCase());
  const re = new RegExp(`(^|/)${t.match.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*')}$`, 'i');
  return re.test(hay);
}
// Debounce plus a cap: a trigger that saves the file it watches can't set itself off forever.
export class TriggerLimiter {
  #fired = new Map<string, number[]>();
  #last = new Map<string, number>();
  allow(taskId: string, now: number): boolean {
    const last = this.#last.get(taskId) ?? -Infinity;
    if (now - last < TRIGGER_DEBOUNCE_MS) return false;
    const hour = (this.#fired.get(taskId) ?? []).filter(t => now - t < 3600000);
    if (hour.length >= TRIGGER_CAP_PER_HOUR) { this.#fired.set(taskId, hour); return false; }
    hour.push(now);
    this.#fired.set(taskId, hour);
    this.#last.set(taskId, now);
    return true;
  }
  firedThisHour(taskId: string, now: number): number { return (this.#fired.get(taskId) ?? []).filter(t => now - t < 3600000).length; }
}

/* ----- The orchestrator ----- */
export interface RunResult { ok: boolean; text: string; stopped?: boolean; session?: string | null }
export type Answer = { approve: true; feedback?: string } | { approve: false; feedback?: string; cancel?: boolean };
export interface CoreDeps {
  run(task: Task, prompt: string, mode: 'plan' | 'build', signal: AbortSignal): Promise<RunResult>;
  ask(task: Task, question: { kind: 'plan' | 'step' | 'stuck'; text: string }, signal: AbortSignal): Promise<Answer>;
  notify(task: Task, text: string): void;
  changed(task: Task): void;
  save(tasks: Task[]): void;
  memory(task: Task): string;
  now(): number;
}

export class AgentCore {
  #tasks: Task[] = [];
  #deps: CoreDeps;
  #busy = new Map<string, AbortController>();
  #marks = new Map<string, { ok: boolean; note: string }>(); // task_update calls during the running step
  readonly limiter = new TriggerLimiter();

  constructor(deps: CoreDeps, saved: Task[] = []) {
    this.#deps = deps;
    // Picked up where they were: anything that was running goes back in the queue, its running step to do.
    this.#tasks = saved.filter(t => t && typeof t.id === 'string' && typeof t.goal === 'string').map(t => {
      const steps = (t.steps ?? []).map(s => (s.status === 'running' ? { ...s, status: 'todo' as StepStatus } : s));
      const status: TaskStatus = ['running', 'planning', 'awaiting'].includes(t.status) ? 'queued' : t.status;
      return { ...t, control: isControlLevel(t.control) ? t.control : 'plan', steps, status, log: t.log ?? [] };
    });
  }

  list(): Task[] { return this.#tasks; }
  get(id: string): Task | undefined { return this.#tasks.find(t => t.id === id); }
  running(): string[] { return [...this.#busy.keys()]; }

  #touch(task: Task, line?: string): void {
    task.updatedAt = this.#deps.now();
    if (line) {
      task.log.push({ at: task.updatedAt, text: line.slice(0, 500) });
      if (task.log.length > MAX_LOG) task.log.splice(0, task.log.length - MAX_LOG);
    }
    this.#deps.changed(task);
    this.#deps.save(this.#tasks);
  }

  create(input: NewTask): Task {
    const goal = String(input.goal ?? '').trim().slice(0, MAX_GOAL);
    if (!goal) throw new Error('Say what the task should do.');
    if (!input.project) throw new Error('Pick a project for the task.');
    if (!input.agent) throw new Error('Pick an agent for the task.');
    const now = this.#deps.now();
    const schedule = cleanSchedule(input.schedule);
    const trigger = schedule ? null : cleanTrigger(input.trigger);
    const task: Task = {
      id: crypto.randomBytes(8).toString('hex'), goal, project: input.project, agent: input.agent,
      control: isControlLevel(input.control) ? input.control : 'plan', device: input.device === true,
      steps: [], status: schedule || trigger ? 'waiting' : 'queued', log: [], createdAt: now, updatedAt: now,
      order: Math.max(0, ...this.#tasks.map(t => t.order)) + 1, schedule, trigger,
      nextRunAt: schedule ? nextRunAt(schedule, now) : null, lastRunAt: null, session: null, error: null, replans: 0,
    };
    this.#tasks.push(task);
    this.#touch(task, schedule ? 'Scheduled.' : trigger ? 'Waiting for its trigger.' : 'Queued.');
    this.pump();
    return task;
  }

  // Starts what the queue allows.
  pump(): void {
    for (const t of pickRunnable(this.#tasks, new Set(this.#busy.keys()))) void this.#drive(t);
  }

  // Fires due schedules; call it every minute and at launch.
  tick(): void {
    const now = this.#deps.now();
    for (const t of dueTasks(this.#tasks, now)) this.#fire(t, 'Its schedule came round.');
    this.pump();
  }

  // A file was saved, a commit made, tests failed, a PR got a comment.
  trigger(ev: TriggerEvent, samePath: (a: string, b: string) => boolean): string[] {
    const fired: string[] = [];
    const now = this.#deps.now();
    for (const t of this.#tasks) {
      if (t.status !== 'waiting' || !matchTrigger(t, ev, samePath)) continue;
      if (!this.limiter.allow(t.id, now)) continue;
      this.#fire(t, `Triggered: ${ev.kind}${ev.path ? ` ${ev.path}` : ''}.`);
      fired.push(t.id);
    }
    this.pump();
    return fired;
  }

  #fire(t: Task, why: string): void {
    t.steps = [];
    t.session = null;
    t.error = null;
    t.replans = 0;
    t.unattended = true;
    t.status = 'queued';
    t.lastRunAt = this.#deps.now();
    if (t.schedule) t.nextRunAt = nextRunAt(t.schedule, t.lastRunAt);
    this.#touch(t, why);
  }

  runNow(id: string): void {
    const t = this.get(id);
    if (!t || this.#busy.has(id)) return;
    if (t.status === 'waiting') { this.#fire(t, 'Started by hand.'); t.unattended = false; }
    else if (['paused', 'failed', 'cancelled', 'done'].includes(t.status)) {
      if (t.status !== 'paused') for (const s of t.steps) if (s.status === 'failed') { s.status = 'todo'; s.tries = 0; }
      t.status = 'queued';
      t.unattended = false;
      this.#touch(t, 'Queued again.');
    }
    this.pump();
  }

  pause(id: string): void {
    const t = this.get(id);
    if (!t || ['done', 'cancelled', 'waiting'].includes(t.status)) return;
    this.#busy.get(id)?.abort();
    t.status = 'paused';
    for (const s of t.steps) if (s.status === 'running') s.status = 'todo';
    this.#touch(t, 'Paused.');
  }

  cancel(id: string): void {
    const t = this.get(id);
    if (!t) return;
    this.#busy.get(id)?.abort();
    for (const s of t.steps) if (s.status === 'running' || s.status === 'todo') s.status = 'skipped';
    t.status = 'cancelled';
    this.#touch(t, 'Cancelled.');
    this.pump();
  }

  remove(id: string): void {
    this.#busy.get(id)?.abort();
    this.#tasks = this.#tasks.filter(t => t.id !== id);
    this.#deps.save(this.#tasks);
    this.pump();
  }

  // Moves a task up or down the queue.
  reorder(id: string, delta: number): void {
    const queue = this.#tasks.filter(t => !['done', 'cancelled'].includes(t.status)).sort((a, b) => a.order - b.order);
    const i = queue.findIndex(t => t.id === id);
    const j = i + Math.sign(delta);
    if (i < 0 || j < 0 || j >= queue.length) return;
    [queue[i].order, queue[j].order] = [queue[j].order, queue[i].order];
    this.#deps.save(this.#tasks);
    this.#deps.changed(queue[i]);
    this.#deps.changed(queue[j]);
  }

  // The kill switch: everything running stops and pauses.
  stopAll(): number {
    const ids = [...this.#busy.keys()];
    for (const id of ids) this.pause(id);
    return ids.length;
  }

  // task_update from the agent: marks the running step done or failed (checked again by the verdict).
  mark(taskId: string, ok: boolean, note: string): void { this.#marks.set(taskId, { ok, note: note.slice(0, 300) }); }
  note(taskId: string, text: string): void { const t = this.get(taskId); if (t) this.#touch(t, text); }

  async #drive(task: Task): Promise<void> {
    const ac = new AbortController();
    this.#busy.set(task.id, ac);
    const { signal } = ac;
    const stopped = () => signal.aborted || task.status === 'paused' || task.status === 'cancelled';
    try {
      // 1. Plan, and get it approved when the level asks for that.
      let feedback: string | undefined;
      while (!task.steps.length) {
        task.status = 'planning';
        this.#touch(task, feedback ? 'Planning again with your changes.' : 'Planning.');
        const r = await this.#deps.run(task, planPrompt(task, this.#deps.memory(task), feedback), 'plan', signal);
        if (stopped()) return;
        if (r.session) task.session = r.session;
        const steps = parsePlan(r.text);
        if (!steps.length) return this.#fail(task, r.ok ? 'The agent did not give a plan.' : (r.text.trim().split('\n').pop() || 'Planning failed.'));
        task.steps = steps.map((s, i) => ({ id: i + 1, title: s.title, detail: s.detail, status: 'todo', tries: 0 }));
        if (task.control === 'plan' || task.control === 'ask') {
          task.status = 'awaiting';
          this.#touch(task, 'Waiting for you to approve the plan.');
          if (task.unattended) this.#deps.notify(task, 'A plan is waiting for your OK.');
          const a = await this.#deps.ask(task, { kind: 'plan', text: task.steps.map(s => `${s.id}. ${s.title}`).join('\n') }, signal);
          if (stopped()) return;
          if (!a.approve) {
            if (a.cancel || (task.replans ?? 0) >= MAX_REPLANS || !a.feedback) { task.status = 'cancelled'; task.steps.forEach(s => (s.status = 'skipped')); this.#touch(task, 'Plan turned down.'); return; }
            task.replans = (task.replans ?? 0) + 1;
            feedback = a.feedback;
            task.steps = [];
          }
        }
      }
      // 2. The steps, in order.
      for (const step of task.steps) {
        if (step.status === 'done' || step.status === 'skipped') continue;
        if (stopped()) return;
        if (task.control === 'ask') {
          task.status = 'awaiting';
          this.#touch(task, `Waiting for your OK on step ${step.id}.`);
          const a = await this.#deps.ask(task, { kind: 'step', text: `${step.id}. ${step.title}` }, signal);
          if (stopped()) return;
          if (!a.approve) {
            if (a.cancel) { this.cancel(task.id); return; }
            step.status = 'skipped';
            this.#touch(task, `Skipped step ${step.id}.`);
            continue;
          }
        }
        while (true) {
          task.status = 'running';
          step.status = 'running';
          this.#marks.delete(task.id);
          this.#touch(task, `Step ${step.id}: ${step.title}`);
          const r = await this.#deps.run(task, stepPrompt(task, step, this.#deps.memory(task)), 'build', signal);
          if (stopped()) return;
          if (r.session) task.session = r.session;
          const mark = this.#marks.get(task.id);
          const v = parseVerdict(r.text, r.ok && !r.stopped);
          const ok = v.ok && (mark ? mark.ok : true);
          if (ok) { step.status = 'done'; step.note = v.note || mark?.note || undefined; this.#touch(task, `Step ${step.id} done.`); break; }
          step.tries++;
          step.note = v.note || mark?.note || 'It did not finish.';
          if (step.tries <= MAX_RETRIES) { this.#touch(task, `Step ${step.id} failed (${step.note}). Trying again.`); continue; }
          step.status = 'failed';
          this.#touch(task, `Step ${step.id} failed: ${step.note}`);
          // Stuck: ask what to do, unless nobody is there and the level says not to wait.
          if (task.unattended && (task.control === 'auto' || task.control === 'full')) return this.#fail(task, `Step ${step.id} failed: ${step.note}`);
          task.status = 'awaiting';
          this.#deps.notify(task, `Stuck on step ${step.id}.`);
          const a = await this.#deps.ask(task, { kind: 'stuck', text: `Step ${step.id} failed ${step.tries} times: ${step.note}` }, signal);
          if (stopped()) return;
          if (a.approve) { step.status = 'todo'; step.tries = 0; if (a.feedback) step.detail = `${step.detail ?? ''}\nFrom the user: ${a.feedback}`.trim(); continue; }
          if (a.cancel) return this.#fail(task, `Stopped at step ${step.id}.`);
          step.status = 'skipped';
          break;
        }
      }
      // 3. Finished.
      const failed = task.steps.some(s => s.status === 'failed');
      if (failed) return this.#fail(task, 'Some steps failed.');
      this.#finish(task);
    } catch (err) {
      if (!stopped()) this.#fail(task, (err as Error).message);
    } finally {
      if (this.#busy.get(task.id) === ac) this.#busy.delete(task.id);
      this.pump();
    }
  }

  #finish(task: Task): void {
    const recurring = !!(task.schedule || task.trigger);
    task.status = recurring ? 'waiting' : 'done';
    task.unattended = false;
    this.#touch(task, 'Done.');
    this.#deps.notify(task, 'Done.');
  }

  #fail(task: Task, why: string): void {
    task.error = why;
    const recurring = !!(task.schedule || task.trigger);
    task.status = recurring ? 'waiting' : 'failed';
    task.unattended = false;
    this.#touch(task, why);
    this.#deps.notify(task, why);
  }
}
