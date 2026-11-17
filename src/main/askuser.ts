// Questions an agent asks the user: a card with buttons in the chat, and the answer that goes back to the agent.
// Plain functions and one small class with no Electron, so test/askuser.test.js can cover them.
import * as crypto from 'node:crypto';

export interface AskOption { label: string; description: string }
// `plan`: a plan for the user to approve (propose_plan). Its card has Approve and a box to ask for changes.
export interface Question { question: string; options: AskOption[]; multiSelect: boolean; plan?: string }
// What the card sends back: the options clicked and what was typed in "Other". Null: closed without an answer.
export interface Reply { picked?: unknown; other?: unknown }
export type QuestionEvent =
  | { t: 'question'; id: string; question: string; options: AskOption[]; multiSelect: boolean; plan?: string }
  | { t: 'question-end'; id: string };

const MAX_OPTIONS = 6;
const MAX_QUESTION = 600;
const MAX_LABEL = 80;
const MAX_DESCRIPTION = 200;
const MAX_OTHER = 2000;
const MAX_PLAN = 12000;
const APPROVE = 'Approve';
const NO_ANSWER = 'The user closed the question without answering. Don\'t ask it again: use your best judgment, or say in your final message what you needed to know.';
const NO_APPROVAL = 'The user did not approve the plan. Don\'t make the changes: stop here and say in one line that the plan is waiting for their OK.';

const oneLine = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// What an agent sent, tidied into a question. The errors are written for the agent to read and try again.
function normalizeQuestion(input: unknown): Question {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const question = String(o.question ?? '').trim().slice(0, MAX_QUESTION);
  if (!question) throw new Error('question is empty. Ask one short question.');
  const raw = o.options == null ? [] : o.options;
  if (!Array.isArray(raw)) throw new Error('options must be a list, like [{"label": "Yes", "description": "…"}].');
  if (raw.length > MAX_OPTIONS) throw new Error(`Give at most ${MAX_OPTIONS} options. The user can always type another answer.`);
  const options: AskOption[] = [];
  for (const item of raw) {
    const opt = (item && typeof item === 'object' ? item : { label: item }) as Record<string, unknown>;
    const label = oneLine(opt.label, MAX_LABEL);
    if (!label) throw new Error('Every option needs a label.');
    if (options.some(x => x.label.toLowerCase() === label.toLowerCase())) continue; // the same choice twice
    options.push({ label, description: oneLine(opt.description, MAX_DESCRIPTION) });
  }
  return { question, options, multiSelect: (o.multiSelect === true || o.multi_select === true) && options.length > 1 };
}

// A plan an agent wants approved before it changes files: a question whose one option is Approve.
function normalizePlan(input: unknown): Question {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const plan = String(o.plan ?? '').trim();
  if (!plan) throw new Error('plan is empty. Write the plan as a short numbered list.');
  if (plan.length > MAX_PLAN) throw new Error(`The plan is too long. Keep it under ${MAX_PLAN} characters.`);
  return { question: 'Approve this plan?', options: [{ label: APPROVE, description: '' }], multiSelect: false, plan };
}
function planReplyText(reply: Reply | null | undefined): string {
  if (!reply || typeof reply !== 'object') return NO_APPROVAL;
  const other = typeof reply.other === 'string' ? reply.other.trim().slice(0, MAX_OTHER) : '';
  if (other) return `The user wants changes to the plan: ${JSON.stringify(other)}. Change the plan and call propose_plan again. Don't change files until they approve.`;
  const ok = Array.isArray(reply.picked) && reply.picked.map(String).includes(APPROVE);
  return ok ? 'The user approved the plan. Make the changes now, then say what you changed.' : NO_APPROVAL;
}

// The answer as the agent reads it. Only labels the question offered count; anything else the card sent is dropped.
function replyText(q: Question, reply: Reply | null | undefined): string {
  if (q.plan != null) return planReplyText(reply);
  if (!reply || typeof reply !== 'object') return NO_ANSWER;
  const sent = Array.isArray(reply.picked) ? reply.picked.map(String) : [];
  let picked = q.options.map(o => o.label).filter(l => sent.includes(l));
  if (!q.multiSelect) picked = picked.slice(0, 1);
  const other = typeof reply.other === 'string' ? reply.other.trim().slice(0, MAX_OTHER) : '';
  if (!picked.length && !other) return NO_ANSWER;
  if (!picked.length) return `The user answered: ${JSON.stringify(other)}`;
  const chose = `The user chose: ${picked.map(l => JSON.stringify(l)).join(', ')}.`;
  return other ? `${chose} They also wrote: ${JSON.stringify(other)}` : chose;
}

// The questions waiting for an answer. Each belongs to a run: stopping the run (its abort signal, or cancelRun)
// closes its questions as unanswered, so nothing waits for ever.
class QuestionDesk {
  #open = new Map<string, { runId: number; q: Question; settle: (reply: Reply | null, ended: boolean) => void }>();
  #newId: () => string;

  constructor(newId: () => string = () => crypto.randomUUID()) { this.#newId = newId; }

  get size(): number { return this.#open.size; }

  // Shows the question (through `emit`) and resolves with the text of the answer.
  ask(runId: number, q: Question, emit: (ev: QuestionEvent) => void, signal?: AbortSignal): Promise<string> {
    return this.askReply(runId, q, emit, signal).then(reply => replyText(q, reply));
  }

  // The same card, resolving with what the card sent (null: closed or ended unanswered). agentic tasks' own
  // questions (approve a plan, run a step, what to do when stuck) read the clicked option rather than a sentence.
  askReply(runId: number, q: Question, emit: (ev: QuestionEvent) => void, signal?: AbortSignal): Promise<Reply | null> {
    if (signal?.aborted) return Promise.resolve(null);
    const id = this.#newId();
    return new Promise<Reply | null>(resolve => {
      const onAbort = () => this.cancel(id);
      this.#open.set(id, {
        runId, q,
        settle: (reply, ended) => {
          this.#open.delete(id);
          signal?.removeEventListener('abort', onAbort);
          if (ended) emit({ t: 'question-end', id }); // the card stops taking clicks
          resolve(reply);
        },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      emit({ t: 'question', id, ...q });
    });
  }

  // The user's answer from the card. False when the question is no longer waiting (answered, or its run ended).
  answer(id: string, reply: Reply | null | undefined): boolean {
    const entry = this.#open.get(id);
    if (!entry) return false;
    entry.settle(reply ?? null, false);
    return true;
  }

  cancel(id: string): void { this.#open.get(id)?.settle(null, true); }

  cancelRun(runId: number): void {
    for (const [id, entry] of [...this.#open]) if (entry.runId === runId) this.cancel(id);
  }
}

export { normalizeQuestion, normalizePlan, replyText, QuestionDesk, NO_ANSWER, NO_APPROVAL, MAX_OPTIONS };
