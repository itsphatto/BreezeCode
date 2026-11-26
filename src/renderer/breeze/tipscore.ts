// Pure logic for the first-run tips (tips.ts draws them): which tip each screen has, which ones were closed, and
// where a bubble sits beside its control. No DOM, no globals from other files.

type TipId = 'editor' | 'scm' | 'board' | 'debug' | 'agents';
// `text` has one **bold** part; `action` is the label of the bubble's button.
interface TipDef { id: TipId; target: string; text: string; action: string }
interface TipsState { seen: TipId[]; skipped: boolean }
interface TipRect { left: number; top: number; width: number; height: number }
interface TipSize { width: number; height: number }

const TIPS: TipDef[] = [
  { id: 'editor', target: '#ide .agents .composer-box', text: 'Ask an **agent** to write or change code here.', action: 'Try it' },
  { id: 'scm', target: '#scmGenMsg', text: 'Let the agent write your **commit message**.', action: 'Generate' },
  { id: 'board', target: '#boardSideNew', text: 'Each **chat** runs its own agent in a box of its own.', action: 'New chat' },
  { id: 'debug', target: '#dbgGo', text: 'Start your program and **pause** at breakpoints.', action: 'Start' },
  { id: 'agents', target: '#pickList', text: 'Pick which **AI agent** Breeze uses.', action: 'Got it' },
];

// What was stored, made safe: anything unexpected counts as nothing seen.
function tipsState(raw: unknown): TipsState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { seen?: unknown; skipped?: unknown };
  const ids = new Set<string>(TIPS.map(t => t.id));
  const seen = Array.isArray(r.seen) ? r.seen.filter((id): id is TipId => typeof id === 'string' && ids.has(id)) : [];
  return { seen: [...new Set(seen)], skipped: r.skipped === true };
}

// Tips start once setup is done, show once each, and none after Skip all tips.
function shouldOffer(s: TipsState, id: TipId, onboarded: boolean): boolean {
  return onboarded && !s.skipped && !s.seen.includes(id);
}

function markSeen(s: TipsState, id: TipId): TipsState {
  return { seen: s.seen.includes(id) ? [...s.seen] : [...s.seen, id], skipped: s.skipped };
}

// Above the control when it fits (else below), centred on it, kept 8px inside the window. arrowX: where the pointer
// sits along the bubble, at the control's centre but never closer than 16px to the bubble's corners.
const TIP_GAP = 10, TIP_MARGIN = 8, TIP_ARROW_INSET = 16;
function placeTip(target: TipRect, bubble: TipSize, view: TipSize): { left: number; top: number; side: 'above' | 'below'; arrowX: number } {
  const centre = target.left + target.width / 2;
  const maxLeft = view.width - TIP_MARGIN - bubble.width;
  const left = Math.max(TIP_MARGIN, Math.min(centre - bubble.width / 2, maxLeft));
  const above = target.top - TIP_GAP - bubble.height;
  const side = above >= TIP_MARGIN ? 'above' : 'below';
  // Below a tall control in a short window it would run off the bottom: kept in, over the control's lower part.
  const below = Math.max(TIP_MARGIN, Math.min(target.top + target.height + TIP_GAP, view.height - TIP_MARGIN - bubble.height));
  const top = side === 'above' ? above : below;
  const arrowX = Math.max(TIP_ARROW_INSET, Math.min(centre - left, bubble.width - TIP_ARROW_INSET));
  return { left, top, side, arrowX };
}

// Worth pointing at: wholly inside the window and at least 8px each way (a closed side panel squeezes its prompt to a
// few pixels at the window's edge, and a bubble there would point at nothing).
const TIP_MIN_SIZE = 8;
function tipTargetVisible(r: TipRect, view: TipSize): boolean {
  return r.width >= TIP_MIN_SIZE && r.height >= TIP_MIN_SIZE
    && r.left >= 0 && r.top >= 0 && r.left + r.width <= view.width && r.top + r.height <= view.height;
}

// What an offered or open bubble should do as the page changes under it: its screen was left (close, not counted as
// seen), its screen is still fading in or a dialog covers it (hide for now), or show.
function tipSceneAction(s: { settling: boolean; leaving: boolean; dialogOver: boolean }): 'show' | 'wait' | 'close' {
  if (s.leaving) return 'close';
  return s.settling || s.dialogOver ? 'wait' : 'show';
}

// Escape closes the tip only when nothing else wants it: no menu open, no dialog over the tip's screen, and not typing
// in a field (where Escape closes autocomplete, the find bar or a search).
function tipTakesEscape(s: { menuOpen: boolean; dialogOver: boolean; typing: boolean }): boolean {
  return !s.menuOpen && !s.dialogOver && !s.typing;
}
