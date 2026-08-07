// refine-chrome.mjs — the self-verify → AI-fix loop, SCOPED TO THE HEADER (and, secondarily, the FOOTER).
//
// A sibling of refine-visual.mjs, but instead of the WHOLE page it crops to the site CHROME: the top
// HEADER band and the bottom FOOTER band. It renders SOURCE + CONVERTED, measures pixel drift *within
// those bands*, asks the AI for CSS scoped to the converted page's REAL header/footer selectors, injects
// it, and re-measures. The CSS is kept ONLY if the combined chrome drift actually dropped — so the AI can
// only ever IMPROVE header/footer fidelity (measured), never make it worse.
//
// HEADER-FIRST: the header is the primary target and is always measured + refined. The footer path rides
// along when its selectors are found (it comes almost for free), but it is SECONDARY — a missing/again
// footer never blocks a working header pass. See the FOOTER_TODO notes for the deliberately-lighter bits.
//
// Returns the before/after chrome drift + the CSS, which the caller (WordPress) persists into the child
// theme (labeled block, idempotent) so the fidelity win survives.

import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { refineChromeCss } from './to-ai.mjs';

const CHROME = process.env.CHROME || process.env.CHROME_PATH ||
  'C:/Program Files/Google/Chrome/Application/chrome.exe';

// Selectors we treat as "the header" / "the footer" on the CONVERTED page (WP chrome + the converter's
// own sc-* chrome). First match wins for the band geometry.
const HEADER_SEL = 'header, .sc-header, #masthead, .site-header';
const FOOTER_SEL = 'footer, #colophon, .sc-footer, .site-footer';
const HEADER_FALLBACK = 140;  // px from top when no header element is found
const FOOTER_FALLBACK = 600;  // px from bottom when no footer element is found

/**
 * Render a full page. Returns the PNG, the page HTML, and the measured header/footer band geometry
 * (y-ranges in device pixels) + the trimmed header/footer HTML for the prompt.
 */
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

    // Measure the header + footer bands and pull their outerHTML (trimmed) for the AI prompt.
    const bands = await page.evaluate(({ headerSel, footerSel, hFall, fFall }) => {
      const rectOf = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); const top = r.top + window.scrollY, bottom = r.bottom + window.scrollY; if (bottom <= top) return null; return { top: Math.max(0, Math.round(top)), bottom: Math.round(bottom), html: (el.outerHTML || '').slice(0, 12000), classes: el.className || '', id: el.id || '' }; };
      const docH = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      const h = rectOf(headerSel) || { top: 0, bottom: hFall, html: '', classes: '', id: '' };
      const f = rectOf(footerSel) || { top: Math.max(0, docH - fFall), bottom: docH, html: '', classes: '', id: '' };
      return { docH, header: h, footer: f };
    }, { headerSel: HEADER_SEL, footerSel: FOOTER_SEL, hFall: HEADER_FALLBACK, fFall: FOOTER_FALLBACK }).catch(() => null);

    const png = PNG.sync.read(await page.screenshot({ fullPage: true }));
    const html = await page.content().catch(() => '');
    return { png, html, bands: bands || { docH: png.height, header: { top: 0, bottom: HEADER_FALLBACK, html: '', classes: '', id: '' }, footer: { top: Math.max(0, png.height - FOOTER_FALLBACK), bottom: png.height, html: '', classes: '', id: '' } } };
  } finally { await page.close(); }
}

// Crop a horizontal BAND (full width, y0..y1) out of a PNG into a new PNG.
function cropBand(png, y0, y1) {
  const top = Math.max(0, Math.min(png.height, Math.round(y0)));
  const bot = Math.max(top + 1, Math.min(png.height, Math.round(y1)));
  const w = png.width, h = bot - top;
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const si = (png.width * (y + top) + x) << 2, di = (w * y + x) << 2;
    out.data[di] = png.data[si]; out.data[di + 1] = png.data[si + 1];
    out.data[di + 2] = png.data[si + 2]; out.data[di + 3] = png.data[si + 3];
  }
  return out;
}

// Drift % between the SAME band on two PNGs (compared over the overlapping width/height).
function bandDrift(a, b, aY, bY, threshold = 0.1) {
  const ca = cropBand(a, aY[0], aY[1]);
  const cb = cropBand(b, bY[0], bY[1]);
  const w = Math.min(ca.width, cb.width), h = Math.min(ca.height, cb.height);
  if (w < 2 || h < 2) return 0;
  const na = cropBand(ca, 0, h), nb = cropBand(cb, 0, h); // trim to common height
  const wa = na.width === w ? na : cropWidth(na, w), wb = nb.width === w ? nb : cropWidth(nb, w);
  const mismatched = pixelmatch(wa.data, wb.data, null, w, h, { threshold });
  return Math.round((mismatched / (w * h)) * 1000) / 10;
}

function cropWidth(png, w) {
  const h = png.height, out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const si = (png.width * y + x) << 2, di = (w * y + x) << 2;
    out.data[di] = png.data[si]; out.data[di + 1] = png.data[si + 1];
    out.data[di + 2] = png.data[si + 2]; out.data[di + 3] = png.data[si + 3];
  }
  return out;
}

// Combined chrome drift for a converted render vs the source. HEADER is primary; FOOTER is secondary
// (weighted lighter and only counted when a real footer was found on the converted page).
function chromeDrift(src, conv) {
  const hSrc = [src.bands.header.top, src.bands.header.bottom];
  const hConv = [conv.bands.header.top, conv.bands.header.bottom];
  const header = bandDrift(src.png, conv.png, hSrc, hConv);
  let footer = null;
  const hasFooter = conv.bands.footer.html !== '' && src.bands.footer.html !== '';
  if (hasFooter) {
    const fSrc = [src.bands.footer.top, src.bands.footer.bottom];
    const fConv = [conv.bands.footer.top, conv.bands.footer.bottom];
    footer = bandDrift(src.png, conv.png, fSrc, fConv);
  }
  // Header-first weighting: header 0.7, footer 0.3 (or header alone when no footer band).
  const combined = footer == null ? header : Math.round((header * 0.7 + footer * 0.3) * 10) / 10;
  return { header, footer, combined };
}

// Pull the REAL header/footer selectors present on the converted page so the AI scopes CSS to them.
function chromeSelectors(bands) {
  const sels = (b, tag) => {
    const out = [];
    if (b.id) out.push('#' + b.id);
    String(b.classes || '').split(/\s+/).filter(Boolean).slice(0, 6).forEach((c) => out.push('.' + c));
    if (!out.length) out.push(tag);
    return out;
  };
  return { header: sels(bands.header, 'header'), footer: sels(bands.footer, 'footer') };
}

/**
 * Improve HEADER (primary) + FOOTER (secondary) fidelity with AI-authored, verified, chrome-scoped CSS.
 * @param {{ sourceUrl:string, convertedUrl:string, width?:number, rounds?:number }} o
 * @returns {Promise<{ before_chrome_drift_pct:number, after_chrome_drift_pct:number, header_before:number, header_after:number, footer_before:(number|null), footer_after:(number|null), improved:boolean, rounds_run:number, css:string }>}
 */
export async function refineChrome({ sourceUrl, convertedUrl, width = 1440, rounds = 2 }) {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const src = await render(browser, sourceUrl, width);
    const first = await render(browser, convertedUrl, width);
    const before = chromeDrift(src, first);

    const sels = chromeSelectors(first.bands);
    let cssAccum = '', current = before, roundsRun = 0, lastError = '';
    for (let i = 0; i < rounds; i++) {
      let newCss = '';
      try {
        const conv = i === 0 ? first : await render(browser, convertedUrl, width, cssAccum);
        // HEADER-FIRST: ask for the header fix using the converted page's real header markup/selectors.
        // The source header is the look to match. Region label steers the focused prompt.
        newCss = await refineChromeCss({
          sourceHtml: src.bands.header.html || src.html,
          convertedHtml: conv.bands.header.html || conv.html,
          selectors: sels.header,
          region: 'header',
        });
        // FOOTER (secondary): only when a real footer band exists on both pages. Free when present.
        if (conv.bands.footer.html && src.bands.footer.html) {
          const footCss = await refineChromeCss({
            sourceHtml: src.bands.footer.html,
            convertedHtml: conv.bands.footer.html,
            selectors: sels.footer,
            region: 'footer',
          }).catch(() => '');
          if (footCss) { newCss = (newCss + '\n' + footCss).trim(); }
        }
      } catch (e) { lastError = e.message; break; } // AI hiccup — stop gracefully, keep what already helped
      if (!newCss) break;
      const test = await render(browser, convertedUrl, width, (cssAccum + '\n' + newCss).trim());
      const after = chromeDrift(src, test);
      roundsRun++;
      if (after.combined < current.combined - 0.2) { cssAccum = (cssAccum + '\n' + newCss).trim(); current = after; } // keep — it helped
      else break; // this round didn't help; stop
    }
    return {
      before_chrome_drift_pct: before.combined,
      after_chrome_drift_pct: current.combined,
      header_before: before.header,
      header_after: current.header,
      footer_before: before.footer,
      footer_after: current.footer,
      improved: current.combined < before.combined - 0.2,
      rounds_run: roundsRun,
      css: cssAccum,
      error: lastError || undefined,
    };
  } finally { await browser.close(); }
}
