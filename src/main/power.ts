// Power saver: decides when Breeze drops its decorative work (blur, looping animations, idle timers).
// Auto turns it on while the machine runs on battery, or always on low-end hardware. Electron's powerMonitor is
// passed in, so this file runs without Electron (test/power.test.js).

export type PowerMode = 'auto' | 'on' | 'off';
export type PowerReason = 'forced' | 'battery' | 'lowend' | null;
export interface PowerState {
  mode: PowerMode;
  saver: boolean;
  onBattery: boolean;
  lowEnd: boolean;
  reason: PowerReason; // why saver is on; null while it is off
}
// The part of Electron's powerMonitor this needs.
export interface PowerSource {
  isOnBatteryPower(): boolean;
  on(event: 'on-battery' | 'on-ac', cb: () => void): unknown;
}

export const POWER_MODES: readonly PowerMode[] = ['auto', 'on', 'off'];
export const LOW_END_CPUS = 4;
export const LOW_END_MEM = 8 * 1024 ** 3; // an "8 GB" machine reports a little under this

export const asPowerMode = (v: unknown): PowerMode => POWER_MODES.find(m => m === v) ?? 'auto';

export function isLowEnd(cpus: number, totalMem: number): boolean {
  return cpus <= LOW_END_CPUS || totalMem <= LOW_END_MEM;
}

export function resolvePower(mode: PowerMode, onBattery: boolean, lowEnd: boolean): PowerState {
  const reason: PowerReason = mode === 'on' ? 'forced'
    : mode === 'off' ? null
    : onBattery ? 'battery'
    : lowEnd ? 'lowend'
    : null;
  return { mode, saver: reason !== null, onBattery, lowEnd, reason };
}

export class PowerService {
  private mode: PowerMode;
  private onBattery = false;
  private readonly lowEnd: boolean;
  private readonly listeners = new Set<(s: PowerState) => void>();
  private last: PowerState;

  constructor(opts: { mode?: unknown; cpus: number; totalMem: number }) {
    this.mode = asPowerMode(opts.mode);
    this.lowEnd = isLowEnd(opts.cpus, opts.totalMem);
    this.last = this.state();
  }

  state(): PowerState {
    return resolvePower(this.mode, this.onBattery, this.lowEnd);
  }

  // Once the app is ready: powerMonitor can't be read before that.
  watch(source: PowerSource): void {
    const read = (fallback: boolean) => { try { return source.isOnBatteryPower(); } catch { return fallback; } };
    this.onBattery = read(false);
    source.on('on-battery', () => { this.onBattery = true; this.emit(); });
    source.on('on-ac', () => { this.onBattery = false; this.emit(); });
    this.emit();
  }

  setMode(mode: unknown): PowerState {
    this.mode = asPowerMode(mode);
    this.emit();
    return this.state();
  }

  // Runs `cb` on every change of the state, and returns how to stop.
  onChange(cb: (s: PowerState) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private emit(): void {
    const next = this.state();
    const same = next.mode === this.last.mode && next.saver === this.last.saver && next.onBattery === this.last.onBattery && next.reason === this.last.reason;
    this.last = next;
    if (same) return;
    for (const cb of this.listeners) cb(next);
  }
}
