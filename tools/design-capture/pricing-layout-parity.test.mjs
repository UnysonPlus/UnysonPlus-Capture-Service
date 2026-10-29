// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * A PRICE LIST IS A DIFFERENT SHAPE, NOT A DIFFERENT COLOUR — AND THE SHAPE IS READ, NOT COUNTED.
 *
 * A converted service page rendered a four-item price LIST — name and sub-label left, price right, a
 * rule between rows — as a four-across card grid. Two causes, and the second was the real one: the
 * `columns` att came from `plans.length`, never from how the source laid the plans out; and the
 * pricing_table was skin-shaped, so even `columns: 1` stacked name → description → price inside a card.
 * It now carries real LAYOUTS (grid / list / bars), and the converter reads the layout off the source
 * container's own geometry. Measured across the capture corpus, list-shaped pricing is 43% of the priced
 * groups a conversion meets, none of which the card grid could express.
 *
 * This is the JS twin of the PHP `pricing_layout` / `pricing_col_count` / `pricing_row_metrics`
 * (class-fw-site-converter-stitch.php), guarded on the PHP side by `price-list-is-detected-test.php`.
 *
 * WHY A REAL BROWSER. These rules read `display`, `grid-template-columns`, border and font properties. A
 * fixture that merely carries those as `data-sc-cs` stamp text proves nothing about this path — that
 * exact mistake was made earlier on the footer text-column twin, where a stamp-only fixture reported 0
 * columns and the twin looked broken when it was the test that was wrong. So the rules are lifted
 * VERBATIM out of capture-extract.mjs (the match fails loudly if they are renamed or dropped) and run
 * against pages with real CSS, at the captured viewport.
 *
 * Run: node --test pricing-layout-parity.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const SRC = readFileSync(new URL('./capture-extract.mjs', import.meta.url), 'utf8');

/* The rules, verbatim from the twin: ptPx → the end of pricingRowMetrics, plus the three helpers they
   lean on (txt / hasBg / wChildren), each pulled from its own definition rather than re-typed here. */
const lift = (re, what) => {
  const m = SRC.match(re);
  assert.ok(m, `capture-extract.mjs no longer carries ${what} (the JS twin drifted from the PHP side)`);
  return m[0];
};
const RULE = [
  lift(/^ {2}const txt = .*$/m, 'txt'),
  lift(/^ {2}const hasBg = .*$/m, 'hasBg'),
  lift(/^ {2}const wChildren = \(el\) => \[[\s\S]*?\n {2}\};/m, 'wChildren'),
  lift(/^ {2}const ptPx = [\s\S]*?\n {2}const pricingRowMetrics = \(el\) => \{[\s\S]*?\n {2}\};/m, 'the pricing geometry rules'),
].join('\n');

const dir = mkdtempSync(join(tmpdir(), 'ptlayout-'));
const fileUrl = (name, html) => {
  const p = join(dir, name);
  writeFileSync(p, html, 'utf8');
  return 'file:///' + p.split(String.fromCharCode(92)).join('/');
};

const wrap = (css, body) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box} body{margin:0;font:16px/1.5 system-ui}
${css}</style></head><body>${body}</body></html>`;

/* A real price list: the shape a service menu is actually written in — a stacked container, each row a
   name and sub-label on the left and an amount on the right, a hairline between the rows. */
const LIST = wrap(`
  #t{display:block}
  #t > .row{display:flex;justify-content:space-between;align-items:baseline;padding:18px 0;border-top:1px solid #e3e3e3}
  #t > .row:first-child{border-top:0}
  .amt{font-family:Syncopate,sans-serif;font-size:22px;font-weight:600}
`, `<div id="t">
  <div class="row"><div><h3>Regular Cleaning</h3><p>Weekly or fortnightly</p></div><div class="amt">$120</div></div>
  <div class="row"><div><h3>Deep Cleaning</h3><p>Top to bottom</p></div><div class="amt">$220</div></div>
  <div class="row"><div><h3>Move-Out Clean</h3><p>End of tenancy</p></div><div class="amt">$340</div></div>
  <div class="row"><div><h3>Office Clean</h3><p>Out of hours</p></div><div class="amt">$480</div></div>
</div>`);

/* The same plans as a FLUSH menu — no rule, no row padding, no gap. The row rhythm must come back as the
   source's nothing, because defaulting it put a hairline on every row and padding it never had. */
const FLUSH = wrap(`
  #t{display:block}
  #t > .row{display:flex;justify-content:space-between;padding:0;border:0}
`, `<div id="t">
  <div class="row"><h3>Regular Cleaning</h3><div class="amt">$120</div></div>
  <div class="row"><h3>Deep Cleaning</h3><div class="amt">$220</div></div>
  <div class="row"><h3>Move-Out Clean</h3><div class="amt">$340</div></div>
</div>`);

/* A real pricing GRID: three tracks holding four plans — so a count-based rule gets the columns wrong
   and a geometry-based one gets them right. This is the discriminating case. */
const GRID = wrap(`
  #t{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}
  #t > .plan{border:1px solid #ddd;padding:24px}
`, `<div id="t">
  <div class="plan"><h3>Basic</h3><div class="amt">$9</div><ul><li>A</li><li>B</li></ul></div>
  <div class="plan"><h3>Plus</h3><div class="amt">$29</div><ul><li>A</li><li>B</li></ul></div>
  <div class="plan"><h3>Pro</h3><div class="amt">$59</div><ul><li>A</li><li>B</li></ul></div>
  <div class="plan"><h3>Max</h3><div class="amt">$99</div><ul><li>A</li><li>B</li></ul></div>
</div>`);

/* A single-track grid is a STACK, not a column of cards — the PHP rule says so explicitly
   (pricing_col_count >= 2 ? grid : list), and this is what makes a one-up grid land on the list. */
const ONE_TRACK = wrap(`
  #t{display:grid;grid-template-columns:1fr;gap:12px}
`, `<div id="t">
  <div><h3>Starter</h3><div class="amt">$19</div></div>
  <div><h3>Growth</h3><div class="amt">$49</div></div>
</div>`);

/* A flex ROW is cards side by side and must stay a grid; a flex COLUMN is a list. */
const FLEX_ROW = wrap(
  `#t{display:flex;flex-direction:row;gap:20px} #t>div{flex:1;border:1px solid #ccc;padding:20px}`,
  `<div id="t"><div><h3>Basic</h3><div class="amt">$9</div></div><div><h3>Pro</h3><div class="amt">$29</div></div></div>`
);
const FLEX_COL = wrap(
  `#t{display:flex;flex-direction:column;gap:14px}`,
  `<div id="t"><div><h3>Basic</h3><div class="amt">$9</div></div><div><h3>Pro</h3><div class="amt">$29</div></div></div>`
);

/* An auto-fit grid whose extra slots COLLAPSED to 0px: the resolved value lists them, and counting them
   would claim columns the visitor never sees. The PHP rule skips a 0px track for exactly this reason. */
const COLLAPSED = wrap(
  `#t{display:grid;grid-template-columns:200px 200px 0px 0px;gap:16px}`,
  `<div id="t"><div><h3>Basic</h3><div class="amt">$9</div></div><div><h3>Pro</h3><div class="amt">$29</div></div></div>`
);

let browser;
const read = async (html, name) => {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto(fileUrl(name, html));
  const out = await p.evaluate(({ rule }) => {
    const el = document.getElementById('t');
    // eslint-disable-next-line no-new-func
    return new Function('el', rule + 'return { layout: pricingLayout(el), cols: pricingColCount(el), rows: pricingRowMetrics(el) };')(el);
  }, { rule: RULE });
  await p.close();
  return out;
};

test.before(async () => { browser = await chromium.launch(); });
test.after(async () => { await browser?.close(); });

test('a stacked price list reads as a LIST, with the source own row rhythm', async () => {
  const r = await read(LIST, 'list.html');
  assert.equal(r.layout, 'list', 'a display:block container of priced rows is a list');
  assert.equal(r.cols, 0, 'a block container has no tracks to count');
  assert.equal(r.rows.rule, true, 'the hairline between rows is seen');
  assert.equal(r.rows.pad, 18, 'the row own padding is measured, not defaulted');
  assert.equal(r.rows.price_size, 22, 'the price own size is measured');
  assert.equal(r.rows.price_weight, 600, '…and its weight');
  assert.match(r.rows.price_font, /Syncopate/, '…and its family, so the amount keeps the source face');
});

test('NEGATIVE: a flush, rule-less menu acquires no rule, padding or gap', async () => {
  const r = await read(FLUSH, 'flush.html');
  assert.equal(r.layout, 'list');
  assert.equal(r.rows.rule, false, 'no border → no rule (this is what got defaulted on before)');
  assert.equal(r.rows.pad, 0, 'no padding → 0, so the emitter writes no padding var');
  assert.equal(r.rows.gap, 0, 'no gap → 0');
});

test('a 3-track grid holding FOUR plans reports 3 columns, not 4', async () => {
  const r = await read(GRID, 'grid.html');
  assert.equal(r.layout, 'grid');
  assert.equal(r.cols, 3, 'the source tracks, not the plan count — the whole point of the change');
});

test('a SINGLE-track grid is a stack, so it reads as a list', async () => {
  const r = await read(ONE_TRACK, 'onetrack.html');
  assert.equal(r.cols, 1, 'one track counted');
  assert.equal(r.layout, 'list', 'one track is not columns of cards (parity: cols >= 2 ? grid : list)');
});

test('flex direction decides: a row is a grid, a column is a list', async () => {
  assert.equal((await read(FLEX_ROW, 'flexrow.html')).layout, 'grid', 'a flex row IS cards side by side');
  assert.equal((await read(FLEX_COL, 'flexcol.html')).layout, 'list', 'a flex column is full-width rows');
});

test('NEGATIVE: collapsed 0px auto-fit slots are not counted as columns', async () => {
  const r = await read(COLLAPSED, 'collapsed.html');
  assert.equal(r.cols, 2, 'two real tracks; the two 0px slots are collapsed, not columns');
  assert.equal(r.layout, 'grid');
});
