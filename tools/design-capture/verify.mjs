// verify.mjs — self-verification for the converter (roadmap item: "measure your own output").
//
// Renders two pages in real Chrome, screenshots them full-page at the same width, and pixel-diffs the
// overlapping region with pixelmatch. Returns an overall drift % plus a per-band breakdown (the page
// split into horizontal strips), so a caller can flag which section drifted. This is the MEASUREMENT
// the eventual auto-fallback-to-verbatim relies on: convert, then check the result against the source.
//
// It intentionally lives in the capture service (it already owns headless Chrome). The WordPress side
// calls POST /verify { source_url, converted_url } after a conversion and surfaces the drift.

import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const CHROME = process.env.CHROME || process.env.CHROME_PATH ||
  'C:/Program Files/Google/Chrome/Application/chrome.exe';

async function shoot(browser, url, width) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
    // let SPA / lazy content settle, then scroll to trigger lazy assets, then back to top
    await page.waitForTimeout(1500);
    await page.evaluate(async () => {
      await new Promise((r) => { let y = 0; const i = setInterval(() => { window.scrollTo(0, y); y += window.innerHeight; if (y > document.body.scrollHeight) { clearInterval(i); r(); } }, 60); });
    }).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await page.waitForTimeout(400);
    const buf = await page.screenshot({ fullPage: true });
    return PNG.sync.read(buf);
  } finally { await page.close(); }
}

// Crop a PNG down to w×h (top-left origin) into a fresh RGBA buffer pixelmatch can read.
function crop(png, w, h) {
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (png.width * y + x) << 2;
      const di = (w * y + x) << 2;
      out.data[di] = png.data[si]; out.data[di + 1] = png.data[si + 1];
      out.data[di + 2] = png.data[si + 2]; out.data[di + 3] = png.data[si + 3];
    }
  }
  return out;
}

// Count mismatched pixels inside a horizontal band [y0, y1) of two equal-width buffers.
function bandDrift(aData, bData, w, y0, y1, threshold) {
  const h = y1 - y0;
  if (h <= 0) return { pct: 0, mismatched: 0, pixels: 0 };
  const a = Buffer.alloc(w * h * 4), b = Buffer.alloc(w * h * 4);
  aData.copy(a, 0, y0 * w * 4, y1 * w * 4);
  bData.copy(b, 0, y0 * w * 4, y1 * w * 4);
  const mismatched = pixelmatch(a, b, null, w, h, { threshold });
  return { pct: Math.round((mismatched / (w * h)) * 1000) / 10, mismatched, pixels: w * h };
}

/**
 * Compare two live URLs. Returns overall drift % + per-band drift.
 * @param {{ sourceUrl:string, convertedUrl:string, width?:number, bands?:number, threshold?:number }} o
 */
export async function verifyUrls({ sourceUrl, convertedUrl, width = 1440, bands = 8, threshold = 0.1 }) {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const [src, conv] = await Promise.all([shoot(browser, sourceUrl, width), shoot(browser, convertedUrl, width)]);
    const w = Math.min(src.width, conv.width);
    const h = Math.min(src.height, conv.height);
    const a = crop(src, w, h), b = crop(conv, w, h);
    const overallMismatched = pixelmatch(a.data, b.data, null, w, h, { threshold });
    const overall = Math.round((overallMismatched / (w * h)) * 1000) / 10;
    const bandRows = [];
    const step = Math.ceil(h / bands);
    for (let i = 0; i < bands; i++) {
      const y0 = i * step, y1 = Math.min((i + 1) * step, h);
      if (y0 >= h) break;
      const d = bandDrift(a.data, b.data, w, y0, y1, threshold);
      bandRows.push({ band: i + 1, y0, y1, drift_pct: d.pct });
    }
    return {
      ok: true,
      overall_drift_pct: overall,
      compared: { width: w, height: h },
      source: { width: src.width, height: src.height },
      converted: { width: conv.width, height: conv.height },
      height_delta_pct: src.height ? Math.round((Math.abs(src.height - conv.height) / src.height) * 1000) / 10 : 0,
      bands: bandRows,
    };
  } finally { await browser.close(); }
}
