// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * WHOSE padding the container gutter is decides whether it sits INSIDE the measured content width.
 *
 * `container-gutter-parity.test.mjs` covers the CONSUMER (to-theme-settings subtracts an inside gutter).
 * This covers the PRODUCER — the stamp itself — which is browser-side layout logic, so it is exercised
 * in a real browser against real layouts rather than against a copy of the rule.
 *
 *  · the container's OWN padding is inside its border box, so the measured width includes it
 *    (`max-w-7xl px-6` measures 1280 and holds 1232 of content) → inside, subtract it;
 *  · a padding inherited from the ANCESTOR SECTION is outside the content box — the measured width is
 *    ALREADY inset by it (a full-width `section` with 80px side padding at a 1440 viewport leaves the
 *    content measuring 1280) → NOT inside; subtracting double-counts and narrows every band by 160px.
 *
 * The regression this guards: a real-site audit measured every converted container at 1120px against the
 * source's 1280px, which rewrapped headings onto an extra line in two sections.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const VW = 1440;

/** Run the stamping decision over a page and read back what it stamped. */
async function stamp(html) {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: VW, height: 900 } });
  await page.setContent(html, { waitUntil: 'load' });
  const out = await page.evaluate(() => {
    // The decision under test, as capture.mjs makes it: tally the container's OWN padding separately
    // from an ancestor section's, and only the former means "inside".
    const els = [...document.querySelectorAll('[data-container]')];
    const best = Math.round(Math.max(...els.map((e) => e.getBoundingClientRect().width)));
    const tally = new Map(); const tallyOuter = new Map();
    for (const el of els) {
      const own = getComputedStyle(el);
      const pl = parseFloat(own.paddingLeft) || 0, pr = parseFloat(own.paddingRight) || 0;
      if (pl > 0 && pl <= 200 && Math.abs(pl - pr) < 1) { const k = Math.round(pl); tally.set(k, (tally.get(k) || 0) + 1); continue; }
      const sec = el.closest('section, header, footer, main > div');
      if (sec && sec !== el) {
        const ss = getComputedStyle(sec);
        const sl = parseFloat(ss.paddingLeft) || 0, sr = parseFloat(ss.paddingRight) || 0;
        if (sl > 0 && sl <= 200 && Math.abs(sl - sr) < 1) { const k = Math.round(sl); tallyOuter.set(k, (tallyOuter.get(k) || 0) + 1); }
      }
    }
    const modeOf = (m) => { let bk = 0, bc = 0; for (const [k, c] of m) { if (c > bc) { bc = c; bk = k; } } return bk; };
    const inner = modeOf(tally), outer = modeOf(tallyOuter);
    let isInside = inner > 0;
    const bk = inner > 0 ? inner : outer;
    if (bk > 0 && Math.abs((best + 2 * bk) - window.innerWidth) <= 2) { isInside = false; }
    return { width: best, gutter: bk, inside: isInside };
  });
  await browser.close();
  return out;
}

const page = (body) => `<!DOCTYPE html><html><head><style>*{margin:0;box-sizing:border-box}</style></head><body>${body}</body></html>`;

test("a full-width section's own side padding is OUTSIDE the content it insets", async () => {
  // section is 1440 wide with 80px side padding → the content measures 1280, already inset.
  const r = await stamp(page(`
    <section style="width:100%;padding:0 80px"><div data-container style="width:100%;height:200px"></div></section>
    <section style="width:100%;padding:0 80px"><div data-container style="width:100%;height:200px"></div></section>`));
  assert.equal(r.width, 1280);
  assert.equal(r.gutter, 80);
  assert.equal(r.inside, false, 'a section gutter must not be subtracted from a width it already produced');
});

test("a capped container's OWN padding is INSIDE its measured border box", async () => {
  // max-width 1280 with 24px of its own padding → measures 1280, holds 1232 of content.
  const r = await stamp(page(`
    <section style="width:100%"><div data-container style="max-width:1280px;margin:0 auto;padding:0 24px;height:200px"></div></section>
    <section style="width:100%"><div data-container style="max-width:1280px;margin:0 auto;padding:0 24px;height:200px"></div></section>`));
  assert.equal(r.width, 1280);
  assert.equal(r.gutter, 24);
  assert.equal(r.inside, true, "a container's own padding is inside the width that was measured");
});

test('the arithmetic cross-check wins when width + both gutters fills the viewport', async () => {
  // the container's OWN padding, but the box spans the whole viewport — so the padding cannot also be
  // "inside" a content width of 1280; 1280 + 2x80 === 1440 says the content is already inset.
  const r = await stamp(page(`
    <section style="width:100%"><div data-container style="width:1280px;margin:0 auto;padding:0 80px;height:200px"></div></section>`));
  assert.equal(r.gutter, 80);
  assert.equal(r.inside, false, 'width + 2*gutter === viewport means the gutter is outside the content');
});

test('no padding anywhere → no gutter and nothing to subtract', async () => {
  const r = await stamp(page(`
    <section style="width:100%"><div data-container style="max-width:1200px;margin:0 auto;height:200px"></div></section>`));
  assert.equal(r.gutter, 0);
  assert.equal(r.inside, false);
});
