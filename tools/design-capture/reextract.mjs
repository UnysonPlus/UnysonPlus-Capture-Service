// Offline per-region re-run harness (Rule −1 prerequisite): replay the deterministic
// extractor + to-pages against a PINNED snapshot (rendered.html) — no network — so the
// converter-improvement loop is fast and reproducible. Prints the hero section's builder
// tree so we can see whether a region decomposes (vs. one verbatim code_block).
//
//   node reextract.mjs <url> [sectionIndex]
//
// Lightweight live re-run (extract + to-pages only) — skips the heavy report/bundle/
// screenshot stages of capture.mjs so the converter-improvement loop is fast. The live
// DOM carries the real CSS (offline snapshot replay needs CSS bundling — a separate task).
import { chromium } from 'playwright-core';
import { extractDesign } from './capture-extract.mjs';
import { toPages } from './to-pages.mjs';

const url = process.argv[2];
const only = process.argv[3] !== undefined ? Number(process.argv[3]) : null;
if (!url) { console.error('usage: node reextract.mjs <url> [sectionIndex]'); process.exit(1); }

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
await page.waitForTimeout(600);
await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
await page.waitForTimeout(300);

const capture = await page.evaluate(extractDesign);
await browser.close();

console.log('sections:', (capture.sections || []).length);
(capture.sections || []).forEach((s, i) => {
  const decomposed = !!s.blocks;
  console.log(`  [${i}] ${decomposed ? 'DECOMPOSED' : 'VERBATIM  '}  class="${(s.sectionClass || '').slice(0, 50)}"`);
});

const pages = toPages(capture, {});
const builder = pages.pages[0].builder;

const walk = (nodes, d = 0) => {
  const pad = '  '.repeat(d);
  for (const n of nodes || []) {
    if (!n) { console.log(pad + '(null)'); continue; }
    let info = n.type + (n.shortcode ? ':' + n.shortcode : '');
    if (n.type === 'column') info += ' w=' + n.width;
    const t = n.atts && (n.atts.title || n.atts.label || n.atts.text || n.atts.message);
    if (t) info += ' "' + String(t).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 36) + '"';
    if (n.shortcode === 'code_block') info += ' [[VERBATIM ' + String((n.atts && n.atts.code) || '').length + ' chars]]';
    console.log(pad + info);
    if (n._items && n._items.length) walk(n._items, d + 1);
  }
};

const target = only !== null ? [builder[only]] : builder;
console.log(`\n--- builder tree${only !== null ? ' (section ' + only + ')' : ''} ---`);
walk(target);
