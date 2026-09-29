/**
 * Guards for page discovery.
 *
 * The bug these exist for: discovery read ONLY the header nav, so a site publishing 133 URLs in its
 * sitemap converted as 2 pages — and nothing in the pipeline noticed, because "the nav had one link" and
 * "the site has one page" are indistinguishable when the nav is your only source.
 *
 * Everything here is deliberately network-free: the pure functions are where the judgement lives, and a
 * test that needs the internet is a test that gets skipped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, linksInHtml, groupOf, mergePages } from './discover.mjs';

const ORIGIN = 'https://example.test';

test('normalizeUrl keeps same-origin pages and drops everything else', () => {
  assert.equal(normalizeUrl('/about', ORIGIN), ORIGIN + '/about');
  assert.equal(normalizeUrl(ORIGIN + '/about/', ORIGIN), ORIGIN + '/about');
  assert.equal(normalizeUrl('https://other.test/about', ORIGIN), null, 'off-origin');
  assert.equal(normalizeUrl('mailto:a@b.c', ORIGIN), null, 'non-http scheme');
  assert.equal(normalizeUrl('/logo.png', ORIGIN), null, 'asset');
  assert.equal(normalizeUrl('/wp-admin/edit.php', ORIGIN), null, 'wp internals');
});

test('a hash or query is the same page, not another one', () => {
  // Otherwise one page with a few filters becomes a dozen rows in the picker and a dozen captures.
  assert.equal(normalizeUrl('/shop?colour=red', ORIGIN), ORIGIN + '/shop');
  assert.equal(normalizeUrl('/shop#top', ORIGIN), ORIGIN + '/shop');
  assert.equal(normalizeUrl('/', ORIGIN), ORIGIN + '/');
});

test('linksInHtml reads every quote style and ignores off-origin', () => {
  const html = `<a href="/a">A</a><a href='/b'>B</a><a href=/c>C</a>
                <a href="https://other.test/x">X</a><a>no href</a>`;
  const got = linksInHtml(html, ORIGIN).sort();
  assert.deepEqual(got, [ORIGIN + '/a', ORIGIN + '/b', ORIGIN + '/c']);
});

test('groupOf buckets by first path segment', () => {
  assert.equal(groupOf(ORIGIN + '/guides/one', ORIGIN), 'guides');
  assert.equal(groupOf(ORIGIN + '/about', ORIGIN), 'about');
  assert.equal(groupOf(ORIGIN + '/', ORIGIN), '');
});

test('mergePages unions sources, records provenance, and puts home first', () => {
  const pages = mergePages(
    { sitemap: ['/b', '/a', '/deep/x'], nav: ['/a'], footer: ['/legal'] },
    ORIGIN,
    ORIGIN + '/',
  );
  assert.equal(pages[0].path, '/', 'home leads');
  assert.equal(pages[0].home, true);

  const a = pages.find((p) => p.path === '/a');
  assert.deepEqual(a.sources.sort(), ['nav', 'sitemap'], 'both sources recorded, not the first one only');
  assert.equal(a.inNav, true);

  // Provenance has to survive, because it is what lets a picker pre-select the pages the site itself
  // considers primary instead of presenting 133 equal-looking checkboxes.
  assert.equal(pages.indexOf(a), 1, 'a nav page outranks a sitemap-only page');
  assert.equal(pages.find((p) => p.path === '/legal').inNav, false);
});

test('the home page is never also listed as a child', () => {
  const pages = mergePages({ sitemap: [ORIGIN + '/', ORIGIN + '/a'] }, ORIGIN, ORIGIN + '/');
  assert.equal(pages.filter((p) => p.path === '/').length, 1);
});

test('shallower pages rank above deeper ones', () => {
  const pages = mergePages({ sitemap: ['/x/y/z', '/x', '/x/y'] }, ORIGIN, ORIGIN + '/');
  assert.deepEqual(pages.slice(1).map((p) => p.path), ['/x', '/x/y', '/x/y/z']);
});

test('duplicates across sources collapse to one row', () => {
  const pages = mergePages({ sitemap: ['/a', '/a/'], nav: [ORIGIN + '/a'], page: ['/a#x'] }, ORIGIN, ORIGIN + '/');
  assert.equal(pages.filter((p) => p.path === '/a').length, 1);
});
