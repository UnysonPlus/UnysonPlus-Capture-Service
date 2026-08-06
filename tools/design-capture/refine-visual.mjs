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
    return { png, html };
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
    for (let i = 0; i < rounds; i++) {
      let newCss = '';
      try {
        // The AI sees the converted page WITH what we've kept so far, so each round fixes what's STILL wrong.
        const conv = i === 0 ? first : await render(browser, convertedUrl, width, cssAccum);
        const roundBefore = i === 0 ? before : current;
        newCss = await refineVisualCss({ sourceHtml: src.html, convertedHtml: conv.html, drift: roundBefore });
      } catch (e) { lastError = e.message; break; } // AI hiccup this round — stop, keep what already helped
      if (!newCss) break;
      const test = await render(browser, convertedUrl, width, (cssAccum + '\n' + newCss).trim());
      const after = driftPct(src.png, test.png);
      roundsRun++;
      if (after < current - 0.2) { cssAccum = (cssAccum + '\n' + newCss).trim(); current = after; } // keep — it helped
      else break; // this round didn't help; stop
    }
    return {
      before_drift_pct: before,
      after_drift_pct: current,
      improved: current < before - 0.2,
      rounds_run: roundsRun,
      css: cssAccum,
    };
  } finally { await browser.close(); }
}
