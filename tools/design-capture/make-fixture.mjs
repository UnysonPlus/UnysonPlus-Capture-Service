// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// make-fixture.mjs — cut the REPRO FIXTURE for a finding out of a capture: the failing construct (by CSS selector) with
// its capture stamps, wrapped in its section (the converter reads a band, not a bare element), scrubbed to structure
// (fixture.mjs) and written beside the capture. Paste the file into the finding's `fixture` field (or pass
// `--finding` a path whose JSON has `"fixture": "@fixture.html"` — send-finding.mjs inlines an `@file`).
//
//   node make-fixture.mjs capture-out/<site> ".marquee"                  # → capture-out/<site>/fixture.html
//   node make-fixture.mjs capture-out/<site> "section:nth-of-type(3) .grid" --out repro.html
//   node make-fixture.mjs capture-out/<site> ".cta-orb" --no-section       # the element alone
//
// The fixture must be STAMPED (data-sc-cs on the element) — a bare DOM proves nothing about the converter's input.
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { chromium } from 'playwright-core';
import { scrubFixture, fixtureIsStamped, FIXTURE_MAX } from './fixture.mjs';

const args = process.argv.slice(2);
const dir = args[0]; const sel = args[1];
const flag = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : ''; };
if (!dir || !sel) { console.error('usage: node make-fixture.mjs capture-out/<site> "<css selector>" [--out file] [--no-section]'); process.exit(1); }

let html;
try { html = readFileSync(join(dir, 'rendered.html'), 'utf8'); } catch (e) { console.error('make-fixture: no rendered.html in ' + dir + ' — ' + e.message); process.exit(1); }
// The DOM work runs in a headless page over the captured markup (the service's own Playwright — no extra dependency):
// the element by selector, its stamp check, and the band rebuilt as band > ancestors-on-the-path > element.
const useSection = !args.includes('--no-section');
const browser = await chromium.launch({ channel: 'chrome', headless: true }); // the branded Chrome the capture uses
let picked, out;
try {
  const page = await browser.newPage({ javaScriptEnabled: false });
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  // The first pass measures (no prune) how much the scrub shrinks this DOM; the prune budget is then the raw size
  // that scrubs to the cap, tightened until the SCRUBBED fixture fits (or nothing repeats any more).
  for (let budget = Infinity, tries = 0, last = -1; tries < 8; tries++) {
  picked = await page.evaluate(({ sel, useSection, budget }) => {
    const el = document.querySelector(sel);
    if (!el) return { err: 'nothing matches ' + sel, code: 2 };
    if (!el.hasAttribute('data-sc-cs')) return { err: 'the element carries no data-sc-cs stamp — pick the stamped element (the capture stamps every rendered element; a hidden or generated one is not a repro)', code: 3 };
    let root = el;
    if (useSection) {
      const band = el.closest('section, main > div, header, footer') || el;
      if (band !== el) {
        const chain = []; let n = el; while (n && n !== band) { chain.push(n); n = n.parentElement; }
        const clone = band.cloneNode(false); let cur = clone;
        for (let i = chain.length - 1; i > 0; i--) { const a = chain[i].cloneNode(false); cur.appendChild(a); cur = a; }
        cur.appendChild(el.cloneNode(true)); root = clone;
      }
    }
    // OVER BUDGET → prune REPEATS, never truncate: a wall of 12 tiles proves the rule with 3 (every grid / list /
    // gallery recognizer wants ≥ 3 look-alike children — a one-tile fixture reproduces a DIFFERENT construct, the
    // lone image, and the finding's rule can't be locked in). Keep the first 3 of every run of same-class siblings,
    // innermost groups first, until the fixture fits or nothing repeats. A cut mid-tag (the sender's hard cap) is
    // the fallback the maintainer should never see.
    let pruned = 0;
    const key = (e) => e.tagName + '|' + (e.getAttribute('class') || '');
    for (let pass = 0; pass < 8 && root.outerHTML.length > budget; pass++) {
      const parents = [root, ...Array.from(root.querySelectorAll('*'))].filter((e) => e.children.length >= 4).reverse();
      let cut = 0;
      for (const p of parents) {
        const groups = {};
        for (const c of Array.from(p.children)) { (groups[key(c)] = groups[key(c)] || []).push(c); }
        for (const g of Object.values(groups)) { if (g.length > 3) { for (const extra of g.slice(3)) { extra.remove(); cut++; } } }
        if (root.outerHTML.length <= budget) break;
      }
      pruned += cut; if (!cut) break;
    }
    const h = document.documentElement; const b = document.body;
    return { html: root.outerHTML, pruned, cw: h.getAttribute('data-sc-content-width') || '', gutter: h.getAttribute('data-sc-content-gutter') || '', bodyCs: b ? (b.getAttribute('data-sc-cs') || '') : '' };
  }, { sel, useSection, budget });
  if (picked.err) break;
  out = scrubFixture(picked.html);
  if (out.length <= FIXTURE_MAX - 300 || out.length === last) break; // fits (300: the head + tail the file adds), or nothing left to prune
  last = out.length;
  const need = Math.floor(picked.html.length * (FIXTURE_MAX - 300) / out.length); // the raw size that scrubs to the cap
  budget = Math.min(need, budget === Infinity ? need : Math.floor(budget * 0.85));
  }
} finally { await browser.close(); }
if (picked.err) { console.error('make-fixture: ' + picked.err); process.exit(picked.code); }
const head = `<!DOCTYPE html><html data-sc-content-width="${picked.cw}"${picked.gutter ? ' data-sc-content-gutter="' + picked.gutter + '"' : ''}><head><title>Fixture</title></head><body${picked.bodyCs ? ' data-sc-cs="' + picked.bodyCs.replace(/"/g, '&quot;') + '"' : ''}><main>`;
if (!fixtureIsStamped(out)) { console.error('make-fixture: the scrubbed fixture lost its stamps — report this'); process.exit(3); }
const full = head + out + '</main></body></html>';
const outFile = flag('out') || join(dir, 'fixture.html');
writeFileSync(outFile, full);
const over = full.length > FIXTURE_MAX;
console.log(`fixture → ${outFile} (${full.length} chars${picked.pruned ? '; ' + picked.pruned + ' repeated sibling(s) pruned — 3 of each run kept' : ''}${over ? ' — OVER ' + FIXTURE_MAX + ': the sender will truncate it; pick a tighter selector or --no-section' : ''})`);
console.log(`  finding field: "fixture": "@${outFile.replace(/\\/g, '/')}"`);
