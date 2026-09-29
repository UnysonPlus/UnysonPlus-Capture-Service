// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * A responsive column utility must be read at the CAPTURED VIEWPORT, not at its mobile base step.
 *
 * `grid-cols-1 md:grid-cols-4` is a FOUR-up row at 1440px. Reading the base step turned a real site's
 * 4-up horizontal step row into a 1-up vertical list (section height 632px → 986px, +56%). The rule now
 * prefers the resolved `grid-template-columns` track count and only falls back to the class scan, where
 * `grid-cols-1` is guarded by a larger-breakpoint override exactly as `flex-col` is guarded by
 * `md:flex-row`.
 *
 * This is the JS twin of the PHP assertion in the Site Converter's
 * `tests/golden-fixture-1-test.php` ("steps: `grid-cols-1 md:grid-cols-4` resolves 4-up"). It pulls the
 * rule VERBATIM out of capture-extract.mjs and runs it in a real browser, so the twin cannot silently
 * drift away from the PHP side.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const SRC = readFileSync(new URL('./capture-extract.mjs', import.meta.url), 'utf8');

// the rule, lifted verbatim from the twin (fails loudly if the twin drops or renames it)
const RULE = (() => {
  const m = SRC.match(/const gtc = \(getComputedStyle\(el\)\.gridTemplateColumns[\s\S]*?const stackedGrid = tracks > 0[\s\S]*?;\r?\n/);
  assert.ok(m, 'capture-extract.mjs no longer carries the resolved-track rule (JS twin drifted from the PHP side)');
  return m[0];
})();

const dir = mkdtempSync(join(tmpdir(), 'respgrid-'));
const url = (name, html) => {
  const p = join(dir, name);
  writeFileSync(p, html, 'utf8');
  return 'file:///' + p.split(String.fromCharCode(92)).join('/');
};

const page = (cls, tracks) => `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<div id="t" class="${cls}" style="display:grid;grid-template-columns:${tracks};gap:32px">
  <div><span>01</span><h3>Intake</h3><p>We take the brief.</p></div>
  <div><span>02</span><h3>Draft</h3><p>We draft the plan.</p></div>
  <div><span>03</span><h3>Refine</h3><p>We refine each part.</p></div>
  <div><span>04</span><h3>Deliver</h3><p>We hand it over.</p></div>
</div></body></html>`;

const stackedGridFor = async (browser, cls, tracks) => {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto(url(`g-${tracks.replace(/[^a-z0-9]+/gi, '')}-${cls.replace(/[^a-z0-9]+/gi, '')}.html`, page(cls, tracks)));
  const out = await p.evaluate(({ rule }) => {
    const el = document.getElementById('t');
    const cls = ' ' + (el.getAttribute('class') || '').toLowerCase() + ' ';
    // eslint-disable-next-line no-new-func
    return new Function('el', 'cls', rule + 'return stackedGrid;')(el, cls);
  }, { rule: RULE });
  await p.close();
  return out;
};

test('`grid-cols-1 md:grid-cols-4` resolving to 4 tracks is NOT stacked', async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    assert.equal(await stackedGridFor(browser, 'grid grid-cols-1 md:grid-cols-4 gap-8', '280px 280px 280px 280px'), false);
  } finally { await browser.close(); }
});

test('a bare `grid-cols-1` resolving to one track IS stacked', async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    assert.equal(await stackedGridFor(browser, 'grid grid-cols-1 gap-8', '1136px'), true);
  } finally { await browser.close(); }
});

test('with no resolved tracks, the class scan still guards `grid-cols-1` with a breakpoint override', () => {
  const run = (cls) => new Function('el', 'cls', 'const getComputedStyle = () => ({ gridTemplateColumns: "none" });' + RULE + 'return stackedGrid;')({}, ' ' + cls + ' ');
  assert.equal(run('grid grid-cols-1 md:grid-cols-4 gap-8'), false, 'md:grid-cols-4 must override the base step');
  assert.equal(run('grid grid-cols-1 lg:grid-cols-2'), false, 'lg:grid-cols-2 must override the base step');
  assert.equal(run('grid grid-cols-1 gap-8'), true, 'a bare grid-cols-1 is stacked');
});
