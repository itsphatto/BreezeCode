// Power saver, page side. Main decides when it is on (src/main/power.ts: on battery, on low-end hardware, or as
// Settings → General → Performance says) and the page follows: data-power="saver" on <html> turns the blur and the
// looping animations off (breeze.css), and decorative timers rest. Plugged in on an ordinary machine, nothing changes.

let powerInfo: PowerInfo = { mode: 'auto', saver: false, onBattery: false, lowEnd: false, reason: null };
const powerSaver = (): boolean => powerInfo.saver;

// Decoration (rotating greetings, drifting skies, hover shows) rests under the saver, and whenever nobody is
// looking: the window hidden, or another window in front. A frame inside the page having focus still counts as here.
let pageFocused = document.hasFocus();
const decorResting = (): boolean => powerInfo.saver || document.hidden || !pageFocused;

const decorWatchers = new Set<() => void>();
// Runs `cb` whenever decorResting() may have changed.
function onDecorChange(cb: () => void): void {
  decorWatchers.add(cb);
}
function decorChanged(): void {
  for (const cb of decorWatchers) { try { cb(); } catch (e) { console.error(e); } }
}

// A setInterval for decorative work: it exists only while decoration isn't resting, so a resting page has no timer
// waking it. `saverMs` keeps it going under the saver at that slower pace instead (it still stops when unseen).
const decorTimers = new Set<{ id: TimeoutId | undefined; every: number }>();
function decorInterval(fn: () => void, ms: number, saverMs?: number): () => void {
  const t: { id: TimeoutId | undefined; every: number } = { id: undefined, every: 0 };
  const sync = () => {
    const unseen = document.hidden || !pageFocused;
    const every = unseen ? 0 : powerInfo.saver ? saverMs ?? 0 : ms;
    if (every === t.every) return;
    clearInterval(t.id);
    t.every = every;
    t.id = every ? setInterval(fn, every) : undefined;
    if (every) decorTimers.add(t); else decorTimers.delete(t);
  };
  onDecorChange(sync);
  sync();
  return () => { decorWatchers.delete(sync); clearInterval(t.id); decorTimers.delete(t); t.id = undefined; t.every = 0; };
}

function applyPower(info: PowerInfo): void {
  const was = powerInfo.saver;
  powerInfo = info;
  if (info.saver) document.documentElement.dataset.power = 'saver';
  else delete document.documentElement.dataset.power;
  if (was !== info.saver) decorChanged();
  document.dispatchEvent(new CustomEvent('powerchange'));
}
function setPowerMode(mode: PowerMode): void {
  background(api.power.setMode(mode).then(applyPower));
}

const focusChanged = () => {
  const now = document.hasFocus();
  if (now === pageFocused) return;
  pageFocused = now;
  decorChanged();
};
window.addEventListener('focus', focusChanged);
// Focus moving into a frame of the page blurs the window first; ask again once it has landed.
window.addEventListener('blur', () => setTimeout(focusChanged, 0));
document.addEventListener('visibilitychange', decorChanged);

api.power.onChange(applyPower);
background(api.power.get().then(applyPower));
