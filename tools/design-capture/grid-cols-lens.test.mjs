// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * A COLUMN COUNT is a property of the container, so only the container can report it.
 *
 * The element-level lens describes leaves. When a 3-up card row collapses to a 1-up stack, every leaf
 * inside it also "moved" — and on a real audit that churn (45 star glyphs in one section) buried the one
 * finding that mattered: the row was no longer a row. `grid-cols` names it directly.
 *
 * Also guards the icon ROLLUP: repeated identical glyph findings collapse to one carrying a count, so a
 * section's list describes its distinct defects rather than its element count.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifySections } from './verify.mjs';

const dir = mkdtempSync(join(tmpdir(), 'gridlens-'));
const url = (name, html) => {
  const p = join(dir, name);
  writeFileSync(p, html, 'utf8');
  return 'file:///' + p.replace(/\\/g, '/');
};

const card = (t) => `<div style="width:100%;background:#eee;padding:16px;box-sizing:border-box">
  <p style="font:16px/24px system-ui;margin:0">${t}</p></div>`;

const page = (cols) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;box-sizing:border-box}</style></head><body>
<section id="reviews" style="width:100%;padding:40px 0">
  <h2 style="font:700 32px/40px system-ui">What our customers say</h2>
  <div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:24px;margin-top:24px">
    ${card('My dog absolutely loves these treats every single day.')}
    ${card('Finally a treat that is healthy and tastes great as well.')}
    ${card('The quality is unmatched and I would recommend it widely.')}
  </div>
</section></body></html>`;

test('a 3-up group rendering 1-up is reported as grid-cols, with both counts', async () => {
  const a = url('src3.html', page(3));
  const b = url('conv1.html', page(1));
  const r = await verifySections({ sourceUrl: a, convertedUrl: b });
  const g = r.findings.filter((f) => f.kind === 'grid-cols');
  assert.equal(g.length, 1, `expected one grid-cols finding, got ${JSON.stringify(r.byKind)}`);
  assert.equal(g[0].source.cols, 3);
  assert.equal(g[0].converted.cols, 1);
  assert.match(g[0].note, /3-up group renders 1-up/);
});

test('NEG: an unchanged column count reports nothing', async () => {
  const a = url('src3b.html', page(3));
  const b = url('conv3.html', page(3));
  const r = await verifySections({ sourceUrl: a, convertedUrl: b });
  assert.equal(r.findings.filter((f) => f.kind === 'grid-cols').length, 0);
});

test('every lens answers `.findings` — the flat list matches the per-section one', async () => {
  const r = await verifySections({ sourceUrl: url('src3c.html', page(3)), convertedUrl: url('conv2.html', page(2)) });
  assert.ok(Array.isArray(r.findings), 'verifySections must expose a flat findings array');
  const nested = r.sections.reduce((n, s) => n + (s.findings || []).length, 0);
  assert.equal(r.findings.length, nested, 'flat and nested counts must agree');
  assert.equal(r.findings.length, r.total);
  for (const f of r.findings) assert.ok(f.sec, 'each flat finding carries its section id');
});

test('repeated identical icon findings roll up to one carrying a count', async () => {
  const stars = (n) => Array.from({ length: n }, () => '<svg class="lucide lucide-star" width="16" height="16"><path d="M2 2h12v12H2z"/></svg>').join('');
  const withStars = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;box-sizing:border-box}</style></head><body>
    <section id="reviews" style="width:100%;padding:40px 0"><h2 style="font:700 32px/40px system-ui">Reviews</h2>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px">
      <div style="background:#eee;padding:16px">${stars(5)}<p style="font:16px/24px system-ui">Alpha review text here.</p></div>
      <div style="background:#eee;padding:16px">${stars(5)}<p style="font:16px/24px system-ui">Beta review text here.</p></div>
      <div style="background:#eee;padding:16px">${stars(5)}<p style="font:16px/24px system-ui">Gamma review text here.</p></div>
    </div></section></body></html>`;
  const noStars = withStars.replace(/<svg class="lucide lucide-star"[^>]*>.*?<\/svg>/g, '');
  const r = await verifySections({ sourceUrl: url('src-stars.html', withStars), convertedUrl: url('conv-nostars.html', noStars) });
  const im = r.findings.filter((f) => f.kind === 'icon-missing');
  assert.equal(im.length, 1, `15 identical star glyphs must roll into one finding, got ${im.length}`);
  assert.equal(im[0].count, 15, `the rollup must keep the count, got ${im[0].count}`);
});
