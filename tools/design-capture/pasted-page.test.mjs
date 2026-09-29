/**
 * Guard for what a pasted URL means: ONE page, or a site.
 *
 * The defect, reported by a user: pasting a single article URL converted TEN pages. Discovery answers with
 * the SITE's pages — its root and what the nav points at — and a pasted INNER route is not among them, so
 * the picker offered a list that did not contain the page that was asked for, pre-ticked the site root and
 * its top-level pages, and converted those. The extra pages brought their media with them: a conversion of
 * one article pulled in the site's asset-library page and its sixty background images, which is what made
 * the media phase run for minutes.
 *
 * The rule pinned here is the picker's default selection, and the mode it implies. It lives in the admin's
 * inline JS, so the logic is reimplemented — what is guarded is the RULE, asserted against the real shapes
 * discovery returns.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const norm = (u) => {
  try { const x = new URL(u); return (x.origin + x.pathname).replace(/\/+$/, '') + (x.search || ''); }
  catch { return String(u || '').replace(/\/+$/, ''); }
};

/** The picker's default selection + the capture mode it produces. */
function pick(target, discovered, cap = 10) {
  let pages = discovered.map((p) => ({ ...p }));
  let self = pages.filter((p) => norm(p.url) === norm(target))[0];
  if (!self) {
    let path = '/';
    try { const u = new URL(target); path = (u.pathname || '/') + (u.search || ''); } catch { /* */ }
    self = { url: target, path, depth: 1, inNav: false, home: false, pasted: true };
    pages.unshift(self);
  }
  self.pasted = true;

  const picked = {};
  if (!self.home) { picked[self.url] = true; }
  else {
    let n = 0;
    for (const p of pages) {
      if (p.home) { picked[p.url] = true; n++; continue; }
      if (n >= cap) continue;
      if (p.inNav || p.depth === 1) { picked[p.url] = true; n++; }
    }
  }
  const pickedList = pages.filter((p) => !p.home && picked[p.url]).map((p) => p.url);
  const homeRow = pages.filter((p) => p.home)[0];
  const homeIn = homeRow ? !!picked[homeRow.url] : true;
  return { pickedList, homeIn, singlePage: pickedList.length === 1 && !homeIn, injected: !discovered.some((p) => norm(p.url) === norm(target)) };
}

/** The shape discovery returns for a site: a root row plus its pages. */
const SITE = [
  { url: 'https://site.test/', path: '/', depth: 0, inNav: true, home: true },
  { url: 'https://site.test/assets', path: '/assets', depth: 1, inNav: true, home: false },
  { url: 'https://site.test/donate', path: '/donate', depth: 1, inNav: true, home: false },
  { url: 'https://site.test/privacy', path: '/privacy', depth: 1, inNav: false, home: false },
  { url: 'https://site.test/terms', path: '/terms', depth: 1, inNav: false, home: false },
  { url: 'https://site.test/preview/abstract/a', path: '/preview/abstract/a', depth: 3, inNav: false, home: false },
];

test('a pasted INNER url converts that page and nothing else', () => {
  const r = pick('https://site.test/api/preview?category=tech&slug=an-article', SITE);
  assert.equal(r.pickedList.length, 1, `expected one page, got ${r.pickedList.join(', ')}`);
  assert.equal(r.homeIn, false, 'the site root is not part of a one-page request');
  assert.equal(r.singlePage, true, 'the capture runs in single-page mode');
});

test('a pasted url that discovery never found is still offered as a row', () => {
  // The page the user typed must appear in the list — otherwise it cannot be seen, ticked or untickd,
  // and the list silently describes a different set of pages than the one being converted.
  const r = pick('https://site.test/api/preview?slug=x', SITE);
  assert.equal(r.injected, true);
  assert.equal(r.pickedList[0], 'https://site.test/api/preview?slug=x');
});

test('the query string distinguishes two pasted pages on the same path', () => {
  // /api/preview?slug=a and /api/preview?slug=b are different pages; normalising the query away would
  // make a paste of one silently select the other.
  const a = pick('https://site.test/api/preview?slug=a', SITE);
  const b = pick('https://site.test/api/preview?slug=b', SITE);
  assert.notEqual(a.pickedList[0], b.pickedList[0]);
});

test('NEGATIVE: pasting the SITE ROOT still means the site', () => {
  // The way to get this fix wrong is to make every conversion single-page. Pasting a root is a request to
  // convert a site, and its primary pages stay pre-ticked.
  const r = pick('https://site.test/', SITE);
  assert.equal(r.homeIn, true, 'the root is part of a site conversion');
  assert.ok(r.pickedList.length >= 4, `expected the site's primary pages, got ${r.pickedList.length}`);
  assert.equal(r.singlePage, false, 'a site conversion is not single-page mode');
});

test('NEGATIVE: a pasted inner url already IN the list does not double up', () => {
  // SITE already carries this row — no duplicate is added, or the same page would be picked twice.
  const r = pick('https://site.test/preview/abstract/a', SITE);
  assert.equal(r.injected, false, 'it was already there; no duplicate row');
  assert.equal(r.pickedList.length, 1);
  assert.equal(r.singlePage, true);
});

test('a trailing slash does not make a page a different page', () => {
  const r = pick('https://site.test/assets/', SITE);
  assert.equal(r.injected, false, '/assets/ is /assets');
  assert.equal(r.pickedList.length, 1);
  assert.deepEqual(r.pickedList, ['https://site.test/assets']);
});
