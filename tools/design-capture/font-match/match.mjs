// Self-owned visual font matcher for the Site Converter.
//
// When a source site sets type in a LICENSED / self-hosted face we can't legally rehost (Neutraface,
// Gotham, Söhne…), the converter must render headings/body in the nearest FREE font. The curated map
// (PHP google_lookalike) handles the ~40 famous names; this fills the long tail: it MEASURES the source
// font as it renders on the source page (the source browser already has it loaded — no font file needed)
// and finds the nearest Google font by shape.
//
// The measurement engine is a headless-browser canvas — identical to the one that built font-index.json
// from the Google font files — so a font measured from its file and the same font measured from its live
// rendering yield the same vector (the property that makes cross-modal matching valid). Deterministic,
// offline, no ML, no third-party model. Index: font-index.json (built by scratchpad build-index.mjs).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let IDX = null;
function idx() {
  if (IDX) return IDX;
  try { IDX = JSON.parse(readFileSync(join(HERE, 'font-index.json'), 'utf8')); }
  catch { IDX = { features: [], weights: {}, stats: { m: {}, s: {} }, index: [] }; }
  return IDX;
}

// The measurement function, run INSIDE the page via page.evaluate. Rasterizes probe glyphs of `family`
// (which must already be loaded on the page) and returns a 6-D shape vector, or null if the font isn't
// available / renders nothing.
function pageMeasure(family) {
  const S = 300, cv = document.createElement('canvas'); cv.width = 900; cv.height = 500;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const draw = (ch) => { ctx.clearRect(0, 0, cv.width, cv.height); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height); ctx.fillStyle = '#000'; ctx.textBaseline = 'alphabetic'; ctx.font = S + 'px "' + family + '"'; ctx.fillText(ch, 40, 380); return ctx.getImageData(0, 0, cv.width, cv.height); };
  const bbox = (im) => { const { data, width, height } = im; let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1; for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { if (data[(y * width + x) * 4] < 128) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } } return x1 < 0 ? null : { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 }; };
  const inkFrac = (im, b) => { const { data, width } = im; let n = 0, t = 0; for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) { t++; if (data[(y * width + x) * 4] < 128) n++; } return n / t; };
  const colRun = (im, b, x) => { const { data, width } = im; let max = 0, c = 0; for (let y = b.y0; y <= b.y1; y++) { if (data[(y * width + x) * 4] < 128) { c++; if (c > max) max = c; } else c = 0; } return max; };
  const rowRun = (im, b, y) => { const { data, width } = im; let max = 0, c = 0; for (let x = b.x0; x <= b.x1; x++) { if (data[(y * width + x) * 4] < 128) { c++; if (c > max) max = c; } else c = 0; } return max; };
  const rowWidth = (im, b, y) => { const { data, width } = im; let a = 1e9, z = -1; for (let x = b.x0; x <= b.x1; x++) { if (data[(y * width + x) * 4] < 128) { if (x < a) a = x; if (x > z) z = x; } } return z < 0 ? 0 : z - a + 1; };
  const bH = bbox(draw('H')); if (!bH) return null; const capH = bH.h || 1;
  const bx = bbox(draw('x')); const imn = draw('n'), bn = bbox(imn); const advN = ctx.measureText('nnnnnnnn').width / 8;
  const imO = draw('O'), bO = bbox(imO); const imI = draw('I'), bI = bbox(imI); const bo = bbox(draw('o'));
  let contrast = 1; if (bO) { const midY = (bO.y0 + bO.y1 >> 1), midX = (bO.x0 + bO.x1 >> 1); const stem = rowRun(imO, bO, midY), hair = colRun(imO, bO, midX); contrast = hair > 0 ? stem / hair : 1; }
  let serif = 1; if (bI) { const topW = rowWidth(imI, bI, bI.y0 + Math.max(1, (bI.h * 0.06 | 0))), midW = rowWidth(imI, bI, (bI.y0 + bI.y1 >> 1)); serif = midW > 0 ? topW / midW : 1; }
  return { widthRatio: advN / capH, xHeightRat: bx ? bx.h / capH : 0, weight: bn ? inkFrac(imn, bn) : 0, contrast, serif, round: bo ? bo.w / bo.h : 0 };
}

function nearest(vector, k = 5) {
  const { features, weights, stats, index } = idx();
  if (!vector || !index.length) return [];
  const d = (a, b) => { let s = 0; for (const f of features) { const za = (a[f] - stats.m[f]) / stats.s[f], zb = (b[f] - stats.m[f]) / stats.s[f]; s += (weights[f] || 1) * (za - zb) ** 2; } return Math.sqrt(s); };
  return index.map((e) => ({ name: e.name, dist: +d(vector, e.v).toFixed(3) })).sort((a, b) => a.dist - b.dist).slice(0, k);
}

// The primary API. Measures `family` as it renders on `page`, returns the nearest free fonts. Best-effort:
// returns null (never throws) when the family is empty, not loaded on the page, or renders nothing — the
// caller then simply omits a visual suggestion and the curated map / declared fallback stands.
export async function matchRenderedFont(page, family, k = 5) {
  const first = String(family || '').split(',')[0].replace(/^\s*['"]|['"]\s*$/g, '').trim();
  if (!first) return null;
  try {
    const loaded = await page.evaluate((f) => { try { return document.fonts.check('300px "' + f + '"'); } catch { return false; } }, first);
    const vector = await page.evaluate(pageMeasure, first);
    if (!vector || !(vector.widthRatio > 0)) return null;
    return { family: first, loaded, vector, matches: nearest(vector, k) };
  } catch { return null; }
}

export { nearest };
