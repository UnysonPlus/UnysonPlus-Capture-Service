// Regenerate ../font-index.json — the offline Google-Fonts shape index used by the visual font matcher.
//
// Pipeline: download-fonts.py fetches TTFs (per families.txt) into ./fonts, then this script (a) reads each
// font's real family name via opentype.js, (b) renders probe glyphs through the SAME headless-browser canvas
// measurement engine as font-match/match.mjs, and (c) writes the z-normalised index. Keeping ONE measurement
// engine for both the index and the runtime query is what makes cross-modal matching valid (a font measured
// from its file and the same font measured from its live rendering yield the same vector).
//
// Usage (from this build/ dir):
//   python download-fonts.py          # fills ./fonts with ~130 TTFs
//   npm i opentype.js playwright      # dev-only deps (not needed at capture runtime)
//   node build-index.mjs              # writes ../font-index.json
//
// Add/remove families in families.txt to widen coverage; every free font a heading could be substituted TO
// should be in the index. The matcher is only as good as the catalogue it can pick from.
import { chromium } from 'playwright';
import opentype from 'opentype.js';
import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TTF_DIR = path.join(HERE, 'fonts');
const OUT = path.join(HERE, '..', 'font-index.json');
const FEATURES = ['widthRatio', 'xHeightRat', 'weight', 'contrast', 'serif', 'round'];
const WEIGHTS = { widthRatio: 1.4, xHeightRat: 1.0, weight: 0.8, contrast: 1.0, serif: 1.6, round: 0.8 };

const pick = (o) => o && (o.en || Object.values(o)[0]);
function familyName(file) {
  try {
    const fo = opentype.parse(fs.readFileSync(path.join(TTF_DIR, file)));
    const w = fo.names.windows || {}, m = fo.names.macintosh || {};
    return pick(w.preferredFamily) || pick(m.preferredFamily) || pick(w.fontFamily) || pick(m.fontFamily) || file.replace(/\.ttf$/i, '');
  } catch { return file.replace(/\.ttf$/i, ''); }
}

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

const files = fs.readdirSync(TTF_DIR).filter((f) => f.endsWith('.ttf'));
const names = Object.fromEntries(files.map((f) => [f, familyName(f)]));
const browser = await chromium.launch(); const page = await browser.newPage();
const index = []; const BATCH = 25;
for (let i = 0; i < files.length; i += BATCH) {
  const chunk = files.slice(i, i + BATCH);
  const faces = chunk.map((f) => { const b64 = fs.readFileSync(path.join(TTF_DIR, f)).toString('base64'); return `@font-face{font-family:"${names[f]}";src:url(data:font/ttf;base64,${b64}) format("truetype");}`; }).join('\n');
  await page.setContent('<!doctype html><style>' + faces + '</style><body>' + chunk.map((f) => `<span style="font-family:'${names[f]}'">Hxno</span>`).join('') + '</body>');
  await page.evaluate(async (fams) => { await Promise.all(fams.map((f) => document.fonts.load('300px "' + f + '"'))); await document.fonts.ready; }, chunk.map((f) => names[f]));
  for (const f of chunk) { const v = await page.evaluate(pageMeasure, names[f]); if (v && v.widthRatio > 0) index.push({ name: names[f], v }); }
  process.stdout.write(`  measured ${Math.min(i + BATCH, files.length)}/${files.length}\r`);
}
await browser.close();
const stats = { m: {}, s: {} };
for (const k of FEATURES) { const a = index.map((x) => x.v[k]); const mu = a.reduce((p, c) => p + c, 0) / a.length; const sd = Math.sqrt(a.reduce((p, c) => p + (c - mu) ** 2, 0) / a.length) || 1; stats.m[k] = mu; stats.s[k] = sd; }
const seen = new Set(); const uniq = index.filter((x) => (seen.has(x.name) ? false : (seen.add(x.name), true)));
fs.writeFileSync(OUT, JSON.stringify({ version: 1, built: new Date().toISOString().slice(0, 10), features: FEATURES, weights: WEIGHTS, stats, index: uniq }, null, 0));
console.log(`\nINDEX BUILT: ${uniq.length} fonts -> ${OUT}`);
