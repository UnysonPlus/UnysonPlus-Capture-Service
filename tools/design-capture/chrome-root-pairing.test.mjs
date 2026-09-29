// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * Two ways the chrome/section lenses used to manufacture findings instead of reporting them.
 *
 * 1) A masthead is not always a <header>. A Tailwind / AI-generated source routinely ships
 *    `<nav class="fixed top-0 …">` and no header landmark. verifyChrome() returned [] for that side, so
 *    every converted header leaf read as `extra` — eight fabricated findings that hid four real header
 *    defects (a real-site audit). It now falls back to the topmost fixed/sticky full-width bar, and a
 *    side with genuinely no root is reported as an ERROR rather than as a page full of findings.
 *
 * 2) verifySections() paired its order fallback by ABSOLUTE DOM index. The two sides rarely carry the
 *    same landmark count, so one extra converted <header> shifted everything after the first id-less
 *    section: a present section was reported `section-missing` and the source FOOTER was then diffed
 *    against it, manufacturing 23 findings about nothing. The fallback now takes the next UNUSED
 *    converted section.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyChrome, verifySections } from './verify.mjs';

const dir = mkdtempSync(join(tmpdir(), 'chromeroot-'));
const url = (name, html) => {
  const p = join(dir, name);
  writeFileSync(p, html, 'utf8');
  return 'file:///' + p.split(String.fromCharCode(92)).join('/');
};

const BAR = 'display:flex;gap:24px;align-items:center;height:64px;padding:0 24px;background:#231509;color:#fff';
const LINKS = '<a href="#a">Section One</a><a href="#b">Section Two</a><a href="#c">Section Three</a>';

// source: the masthead is a fixed <nav>, with NO <header> anywhere
const navSource = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;box-sizing:border-box}</style></head><body>
<nav style="position:fixed;top:0;left:0;right:0;${BAR}"><strong>BRANDMARK</strong>${LINKS}</nav>
<section id="hero" style="height:600px;padding-top:80px"><h1>Headline One</h1></section>
<footer style="height:200px;background:#111;color:#eee"><p>&copy; 2026</p></footer></body></html>`;

// converted: the same chrome, as a real <header>
const headerConverted = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;box-sizing:border-box}</style></head><body>
<header style="position:fixed;top:0;left:0;right:0;${BAR}"><strong>BRANDMARK</strong>${LINKS}</header>
<section id="hero" style="height:600px;padding-top:80px"><h1>Headline One</h1></section>
<footer style="height:200px;background:#111;color:#eee"><p>&copy; 2026</p></footer></body></html>`;

test('verifyChrome finds a <nav> masthead on a source that has no <header>', async () => {
  const r = await verifyChrome({ sourceUrl: url('nav-src.html', navSource), convertedUrl: url('hdr-conv.html', headerConverted), scope: 'header' });
  assert.ok(r.counted.source > 0, `source header items should be counted, got ${JSON.stringify(r.counted)}`);
  const extras = r.findings.filter((f) => f.kind === 'extra');
  assert.equal(extras.length, 0, `no leaf should be reported as extra: ${JSON.stringify(extras)}`);
});

test('verifyChrome names a genuinely missing root instead of listing every leaf as extra', async () => {
  const noChrome = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><main style="height:400px"><p>no chrome here</p></main></body></html>';
  const r = await verifyChrome({ sourceUrl: url('bare.html', noChrome), convertedUrl: url('hdr-conv2.html', headerConverted), scope: 'header' });
  assert.equal(r.error, 'no-source-header-root');
  assert.equal(r.findings.length, 0);
});

// Both sides carry the SAME three bands; only the converted side adds a <header> landmark, which used to
// shift the whole index-based pairing by one.
const band = (id, h, text) => `<section${id ? ` id="${id}"` : ''} style="height:${h}px;padding:24px;background:#fff"><h2 style="font:700 28px/34px system-ui">${text}</h2></section>`;
const bandsSrc = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;box-sizing:border-box}</style></head><body>
<nav style="position:fixed;top:0;left:0;right:0;${BAR}"><strong>BRANDMARK</strong>${LINKS}</nav>
${band('hero', 400, 'Headline One')}${band('', 300, 'Second Band Heading')}
<footer style="height:200px;background:#111;color:#eee"><h2 style="font:700 28px/34px system-ui">Footer Band Heading</h2></footer></body></html>`;
const bandsConv = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;box-sizing:border-box}</style></head><body>
<header style="position:fixed;top:0;left:0;right:0;${BAR}"><strong>BRANDMARK</strong>${LINKS}</header>
${band('hero', 400, 'Headline One')}${band('section-2', 300, 'Second Band Heading')}
<footer style="height:200px;background:#111;color:#eee"><h2 style="font:700 28px/34px system-ui">Footer Band Heading</h2></footer></body></html>`;

test('an id-less section present on both sides is not reported missing (order fallback takes the next UNUSED section)', async () => {
  const r = await verifySections({ sourceUrl: url('bands-src.html', bandsSrc), convertedUrl: url('bands-conv.html', bandsConv) });
  const missing = r.findings.filter((f) => f.kind === 'section-missing');
  assert.equal(missing.length, 0, `nothing is missing here: ${JSON.stringify(missing)}`);
  const ghosts = r.findings.filter((f) => f.kind === 'missing' && /Footer Band Heading/i.test(f.text || ''));
  assert.equal(ghosts.length, 0, 'the footer must not be diffed against a body section');
});
