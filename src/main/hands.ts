// Breeze Agent's hands: the breeze-hands sidecar (hands/, built into runtime/) that moves the mouse and types.
// It speaks the document engine's JSON lines, so it uses the same client (engine.ts). The kill switch ends the
// process, which stops every click and keystroke at once; the next request starts it again.
import { Engine } from './engine';

export const HANDS_NOT_BUILT = "Device Control's mouse and keyboard aren't built. Run npm run build:engine";

export class Hands {
  #engine: Engine;
  constructor(exe: string) {
    this.#engine = new Engine({ exe, journalDir: '', args: [], notBuilt: HANDS_NOT_BUILT });
  }
  request(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> { return this.#engine.request(op, args); }
  get running(): boolean { return this.#engine.running; }
  kill(): void { this.#engine.stop(); }
}
