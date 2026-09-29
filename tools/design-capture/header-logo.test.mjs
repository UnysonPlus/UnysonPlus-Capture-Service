/**
 * Guards for two header-extraction rules, both found by converting a real site whose menu came out wrong.
 *
 * 1. THE LOGO IS NOT A NAV ITEM. Logo detection took the first header link carrying any text. On a header
 *    whose brand is not a link — plenty render the wordmark as plain markup, e.g. "Mod" plus a
 *    <span>Fii</span> inside a div — the first text link is the first MENU item. So the brand came out as
 *    "Financing" AND the nav silently lost its first entry: two wrongs from one loose test.
 * 2. A DISCLOSURE CONTROL IS NOT A DESTINATION. An overflow toggle ("More") is a <button> carrying
 *    aria-haspopup / aria-expanded. It was captured as a menu item pointing at the site root, so the
 *    converted nav gained a dead entry.
 *
 * These run in a real browser because both rules read computed style and DOM relationships — the things a
 * string test cannot see, and precisely what the old tag/order-based tests got wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { extractDesign } from './capture-extract.mjs';

const CHROME = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

/** A header shaped like the real one: wordmark as plain markup, nav links, an overflow toggle, a CTA. */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;font-family:system-ui}
  header{display:flex;align-items:center;gap:32px;padding:16px 24px;background:#fff}
  .brand{font-size:20px;font-weight:700;color:#111}
  nav{display:flex;align-items:center;gap:32px}
  nav a{font-size:14px;font-weight:500;color:#333;text-decoration:none}
  nav button{font-size:14px;background:none;border:0;padding:0}
  .cta{font-size:14px;background:#27684d;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none}
  main{height:1200px}
</style></head><body>
  <header>
    <div class="brand">Mod<span>Fii</span></div>
    <nav>
      <a href="/modular-home-financing">Financing</a>
      <a href="/resources">Resources</a>
      <a href="/#how-it-works">How It Works</a>
      <a href="/#faq">FAQ</a>
      <button aria-haspopup="menu" aria-expanded="false">More</button>
    </nav>
    <a class="cta" href="/get-started">Get Started</a>
  </header>
  <main><h1>Fixture</h1><p>Body copy so the page has a section.</p></main>
</body></html>`;

let browser, header;
test('extract the fixture header once', async () => {
  browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.setContent(PAGE, { waitUntil: 'load' });
  const d = await p.evaluate(extractDesign);
  header = d.header || {};
  assert.ok(header && typeof header === 'object', 'a header was extracted at all');
});

test('the wordmark is the logo, even though it is not a link', () => {
  assert.equal(header.logo && header.logo.type, 'text');
  assert.equal(header.logo.text.replace(/\s+/g, ''), 'ModFii');
});

test('NEGATIVE: the logo is never one of the nav labels', () => {
  const labels = (header.nav || []).map((n) => n.label);
  const logo = header.logo ? String(header.logo.text || '') : '';
  assert.ok(!labels.includes(logo), `logo "${logo}" must not be a menu item (nav: ${labels.join(', ')})`);
});

test('the nav keeps its FIRST item — the one the old logo rule ate', () => {
  const labels = (header.nav || []).map((n) => n.label);
  assert.ok(labels.includes('Financing'), `nav lost its first entry (got: ${labels.join(', ')})`);
});

test('NEGATIVE: the overflow toggle is not captured as a menu item', () => {
  const labels = (header.nav || []).map((n) => n.label);
  assert.ok(!labels.includes('More'), `a disclosure button became a nav item (got: ${labels.join(', ')})`);
  assert.equal(labels.length, 4, 'exactly the four real destinations');
});

test('the CTA is recognised separately from both logo and nav', () => {
  assert.equal(header.cta && header.cta.label, 'Get Started');
  assert.ok(!(header.nav || []).some((n) => n.label === 'Get Started'), 'the CTA is not also a menu item');
});

test('close the browser', async () => { if (browser) await browser.close(); });
