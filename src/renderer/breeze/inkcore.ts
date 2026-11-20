/* ================= Ink that reads on its background (settings.ts tunePicture) ================= */
// Colours are [r, g, b] in 0–255, as the page paints them; contrast is WCAG's.

// A CSS colour as [r, g, b]: #rgb, #rrggbb or rgb()/rgba(). null for anything else.
function inkParse(css: string): number[] | null {
  const s = css.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, '$&$&') : hex[1];
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  }
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(s);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}
// One channel's share of the light it gives off.
const inkLinear = (c: number) => { const v = c / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; };
// Relative luminance of a colour.
const inkLum = (rgb: number[]) => .2126 * inkLinear(rgb[0]) + .7152 * inkLinear(rgb[1]) + .0722 * inkLinear(rgb[2]);
// Contrast ratio between two luminances, 1 to 21.
const inkRatio = (a: number, b: number) => (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
// `rgb` mixed `t` of the way toward white (when it is the lighter of it and the background) or black.
const inkMixed = (rgb: number[], bg: number, t: number) => { const to = inkLum(rgb) >= bg ? 255 : 0; return rgb.map(c => Math.round(c + (to - c) * t)); };
// How far `rgb` must move toward white (or black) to read `min`:1 on a background of luminance `bg`: 0 when it already
// does, 1 for all the way, Infinity when even that won't.
function inkMix(rgb: number[], bg: number, min = 4.5): number {
  if (inkRatio(inkLum(rgb), bg) >= min) return 0;
  if (inkRatio(inkLum(inkMixed(rgb, bg, 1)), bg) < min) return Infinity;
  let lo = 0, hi = 1;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (inkRatio(inkLum(inkMixed(rgb, bg, mid)), bg) >= min) hi = mid; else lo = mid;
  }
  return hi;
}
// The colour nearest `rgb` that reads `min`:1 on `bg`: itself if it already does, else moved toward white or black
// only as far as it must, keeping what it can of its hue. White or black when nothing short of that reads.
function inkFor(rgb: number[], bg: number, min = 4.5): number[] {
  const t = inkMix(rgb, bg, min);
  return t === 0 ? rgb : inkMixed(rgb, bg, Math.min(t, 1));
}
