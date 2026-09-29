// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * THE FIRST CAPTURED URL IS NOT NECESSARILY THE HOME PAGE.
 *
 * It was labelled `home` + `front: true` unconditionally, so capturing a SUB-PAGE on its own produced a
 * bundle claiming to be the front page — and importing it REPLACED the site's home page instead of
 * creating the sub-page. Reported after converting /services: the home page held the services content and
 * the original hero was gone.
 *
 * And a sub-page is not named after the site: its <title> is usually "Brand — tagline" with the page name
 * absent entirely, so taking the first title segment titled every sub-page after the brand.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/** The identity rules as capture.mjs applies them. */
function identify(url, origin, title) {
  const slugFromUrl = (u) => {
    try {
      const path = new URL(u, origin).pathname.replace(/\/+$/, '');
      let seg = (path.split('/').filter(Boolean).pop() || 'home').replace(/\.(html?|php|aspx?)$/i, '');
      seg = seg.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      return seg === '' || seg === 'index' ? 'home' : seg;
    } catch { return 'home'; }
  };
  const isRoot = (() => { try { return new URL(url, origin).pathname.replace(/\/+$/, '') === ''; } catch { return true; } })();
  const slug = isRoot ? 'home' : slugFromUrl(url);
  const human = slug.replace(/-/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
  const segs = (title || '').split(/\s+[|–—·-]\s+/).map((x) => x.trim()).filter(Boolean);
  const key = (v) => v.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const pageTitle = isRoot ? (segs[0] || human) : (segs.find((x) => key(x) === key(slug)) || human);
  return { slug, front: isRoot, title: pageTitle };
}

const ORIGIN = 'https://example.com';

test('the site root is the front page', () => {
  assert.deepEqual(identify('https://example.com/', ORIGIN, 'OBSIDIAN — Premium grooming'),
    { slug: 'home', front: true, title: 'OBSIDIAN' });
});

test('a sub-page is NOT the front page and keeps its path slug', () => {
  const r = identify('https://example.com/services', ORIGIN, 'OBSIDIAN — Premium grooming');
  assert.equal(r.slug, 'services');
  assert.equal(r.front, false, 'importing a sub-page must not replace the home page');
});

test('a sub-page is not named after the site', () => {
  // the <title> is all brand, so the page name comes from the path
  assert.equal(identify('https://example.com/services', ORIGIN, 'OBSIDIAN — Premium grooming').title, 'Services');
  assert.equal(identify('https://example.com/about', ORIGIN, 'OBSIDIAN — Premium grooming').title, 'About');
});

test('…but a title segment that DOES name the page wins over the slug', () => {
  assert.equal(identify('https://example.com/services', ORIGIN, 'Services | OBSIDIAN').title, 'Services');
});

test('index.* and a trailing slash still read as the root', () => {
  assert.equal(identify('https://example.com/index.html', ORIGIN, 'Brand').slug, 'home');
  assert.equal(identify('https://example.com', ORIGIN, 'Brand').front, true);
});

test('a nested path takes its last segment', () => {
  const r = identify('https://example.com/shop/accessories/', ORIGIN, 'Brand — tagline');
  assert.equal(r.slug, 'accessories');
  assert.equal(r.front, false);
});
