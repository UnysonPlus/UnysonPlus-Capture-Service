// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// refine-visual.mjs — the self-verify → AI-fix loop.
//
// Convert deterministically (already done), then: render SOURCE + CONVERTED, measure pixel drift, ask the AI
// for CSS that closes the gap (scoped to the converted page's REAL selectors), inject that CSS into a fresh
// render of the converted page, and re-measure. Keep the CSS ONLY if drift actually dropped. So the AI can
// only ever *improve* fidelity (measured) — never make it worse. Returns the before/after drift + the CSS,
// which the caller (WordPress) persists into the child theme.

import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { refineVisualCss } from './to-ai.mjs';

const CHROME = process.env.CHROME || process.env.CHROME_PATH ||
  'C:/Program Files/Google/Chrome/Application/chrome.exe';

async function render(browser, url, width, injectCss) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(1400);
    await page.evaluate(async () => {
      await new Promise((r) => { let y = 0; const i = setInterval(() => { window.scrollTo(0, y); y += window.innerHeight; if (y > document.body.scrollHeight) { clearInterval(i); r(); } }, 55); });
    }).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    if (injectCss) { await page.addStyleTag({ content: injectCss }).catch(() => {}); }
    await page.waitForTimeout(350);
    const png = PNG.sync.read(await page.screenshot({ fullPage: true }));
    const html = await page.content().catch(() => '');

    // A MAP OF THE PAGE: where each meaningful block sits vertically, with its markup. Built here, while
    // the page is still open, so the caller can later send the AI the region that is actually WRONG instead
    // of the first 45,000 characters of the document -- on a 342KB page that opening slice is about an
    // eighth of it, and everything below the fold was invisible to the model it was asking to fix the page.
    const regions = await page.evaluate(() => {
      const out = [];
      const walk = (el, depth) => {
        if (depth > 6 || out.length > 400) return;
        for (const kid of el.children) {
          const tag = kid.tagName.toLowerCase();
          if (tag === 'script' || tag === 'style' || tag === 'noscript') continue;
          const r = kid.getBoundingClientRect();
          const top = r.top + window.scrollY;
          if (r.height >= 40 && r.width >= 80) {
            out.push({ y0: Math.round(top), y1: Math.round(top + r.height), html: kid.outerHTML.slice(0, 4000) });
          }
          walk(kid, depth + 1);
        }
      };
      walk(document.body, 0);
      return out;
    }).catch(() => []);

    return { png, html, regions };
  } finally { await page.close(); }
}

function crop(png, w, h) {
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const si = (png.width * y + x) << 2, di = (w * y + x) << 2;
    out.data[di] = png.data[si]; out.data[di + 1] = png.data[si + 1];
    out.data[di + 2] = png.data[si + 2]; out.data[di + 3] = png.data[si + 3];
  }
  return out;
}

// Overall drift % between two full-page PNGs (compared over the overlapping region).
function driftPct(a, b, threshold = 0.1) {
  const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height);
  const ca = crop(a, w, h), cb = crop(b, w, h);
  const mismatched = pixelmatch(ca.data, cb.data, null, w, h, { threshold });
  return Math.round((mismatched / (w * h)) * 1000) / 10;
}

/**
 * Per-band drift, so the loop can aim at the region that is actually wrong.
 *
 * One page-wide percentage says "these pages differ" and nothing about WHERE, which is why the refine loop
 * used to hand the model the top of the document and hope. A real measurement on a real conversion: band 1
 * at 88%, band 7 at 94.6%, band 9 at 1.5% -- the page was not uniformly wrong, and the worst region was not
 * the one the opening slice contained.
 */
function bandRows(a, b, bands = 12, threshold = 0.1) {
  const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height);
  const ca = crop(a, w, h), cb = crop(b, w, h);
  const step = Math.ceil(h / bands);
  const rows = [];
  for (let i = 0; i < bands; i++) {
    const y0 = i * step, y1 = Math.min((i + 1) * step, h);
    if (y0 >= h) break;
    const bh = y1 - y0;
    const pa = Buffer.alloc(w * bh * 4), pb = Buffer.alloc(w * bh * 4);
    ca.data.copy(pa, 0, y0 * w * 4, y1 * w * 4);
    cb.data.copy(pb, 0, y0 * w * 4, y1 * w * 4);
    const mismatched = pixelmatch(pa, pb, null, w, bh, { threshold });
    rows.push({ band: i + 1, y0, y1, drift_pct: Math.round((mismatched / (w * bh)) * 1000) / 10 });
  }
  return rows;
}

/** The markup of everything that overlaps a vertical range, capped so the prompt stays affordable. */
function regionMarkup(regions, y0, y1, cap = 18000) {
  let out = '';
  for (const r of regions || []) {
    if (r.y1 < y0 || r.y0 > y1) continue;
    if (out.length + r.html.length > cap) break;
    out += r.html + '\n';
  }
  return out.trim();
}

/**
 * @param {{ sourceUrl:string, convertedUrl:string, width?:number }} o
 * @returns {Promise<{ before_drift_pct:number, after_drift_pct:number, improved:boolean, css:string, backend:string }>}
 */
export async function refineVisual({ sourceUrl, convertedUrl, width = 1440, rounds = 3 }) {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const src = await render(browser, sourceUrl, width);
    const first = await render(browser, convertedUrl, width);
    const before = driftPct(src.png, first.png);

    let cssAccum = '', current = before, roundsRun = 0, lastError = '';
    let conv = first;
    const aimed = [];
    for (let i = 0; i < rounds; i++) {
      let newCss = '';

      // AIM AT THE WORST REGION, not at the top of the document.
      //
      // The model never sees pixels -- it gets markup and a number -- so handing it the first 45,000
      // characters meant that on any page longer than a couple of screens it was asked to fix a gap it
      // could not see. Measured on a real conversion: the rendered source is 342,952 bytes, so the opening
      // slice was about an eighth of the page, while the worst bands sat at 88% and 94.6% well below it.
      // Now each round measures per band, takes the worst remaining one, and sends the markup for THAT
      // region from both pages.
      const rows = bandRows(src.png, conv.png);
      const worst = rows.slice().sort((a, b) => b.drift_pct - a.drift_pct)[0];
      const useRegion = worst && worst.drift_pct > 5;
      const srcPart = useRegion ? regionMarkup(src.regions, worst.y0, worst.y1) : '';
      const convPart = useRegion ? regionMarkup(conv.regions, worst.y0, worst.y1) : '';

      try {
        const roundBefore = i === 0 ? before : current;
        newCss = await refineVisualCss({
          // Fall back to the whole document when the page has no clear worst region (an evenly-small drift)
          // or when the region index came back empty -- a narrower prompt is better, an empty one is not.
          sourceHtml: srcPart || src.html,
          convertedHtml: convPart || conv.html,
          drift: roundBefore,
          region: useRegion && srcPart ? `band ${worst.band} of ${rows.length} (y ${worst.y0}-${worst.y1}px, ${worst.drift_pct}% drift)` : '',
        });
      } catch (e) { lastError = e.message; break; } // AI hiccup this round — stop, keep what already helped
      if (!newCss) break;
      const test = await render(browser, convertedUrl, width, (cssAccum + '\n' + newCss).trim());
      const after = driftPct(src.png, test.png);
      roundsRun++;
      if (useRegion && srcPart) { aimed.push({ band: worst.band, drift_pct: worst.drift_pct }); }
      if (after < current - 0.2) {
        cssAccum = (cssAccum + '\n' + newCss).trim();
        current = after;
        conv = test; // the next round measures and aims against what we have actually kept
      } else { break; } // this round didn't help; stop
    }
    return {
      before_drift_pct: before,
      after_drift_pct: current,
      improved: current < before - 0.2,
      rounds_run: roundsRun,
      bands: bandRows(src.png, conv.png),
      aimed_at: aimed,
      css: cssAccum,
    };
  } finally { await browser.close(); }
}
