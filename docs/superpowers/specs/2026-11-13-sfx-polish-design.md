# SFX polish — design (small change)

**Why:** Breeze's synthesized sounds work but read as raw beeps. Goal: make them feel warmer, cohesive and
"breezy" without adding audio files or changing any call site.

**Goals**
1. Richer voice: lowpass filter + faint detuned second oscillator on every blip; a short noise "tap" on click-type sounds.
2. One key: every pitch snaps to D-major pentatonic (D E F# A B), so overlapping sounds never clash.
3. Space: a generated (no-file) short reverb send plus a gentle compressor on the output.
4. Stereo: sounds pan slightly toward where the click/focus happened (±0.35); unrelated sounds sit centre.
5. Less fatigue: quieter hovers, velocity variation on typing ticks.

**Non-goals:** sampled audio, sound packs, new events, settings UI changes.
**Anti-goals:** louder overall level; reverb smearing fast ticks (ambient sounds stay dry); extra latency.

**Approaches considered:** (A) tune the synth in place — picked: zero assets, all in `sound.ts`;
(B) sampled files — heavier, loses tunability; (C) selectable packs — later follow-up, triples tuning work.

**Scope:** `src/renderer/breeze/sound.ts` only. Public API (`play`, `toggle`, `setVolume`, `on`, `volume`) unchanged.
