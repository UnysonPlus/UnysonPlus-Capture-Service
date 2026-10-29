/**
 * Guard for carrying WHAT A URL IS from discovery into the bundle manifest.
 *
 * `discoverPages()` classifies every URL it finds — page, post or archive — from a post-sitemap /
 * page-sitemap where the source says so outright, else from the path shape. One line later, the capture
 * loop did `.map((p) => p.url)` and the classification was gone. WordPress therefore had no way to know an
 * article was an article, and every converted URL landed as a PAGE: absent from the blog index, the feed,
 * its category and its tag, and carrying a builder tree nobody wants to edit a paragraph in. On a real
 * source that is a hundred-odd articles filed in the wrong place.
 *
 * The rule lives here rather than in capture.mjs's loop because the loop needs a browser and the rule does
 * not — same split as `blank-giveup.test.mjs`.
 *
 * Two things have to hold, and the second is the one that keeps it safe:
 *
 *  - a discovered kind reaches the manifest row for that URL, matched across the trailing-slash and
 *    query-string differences between what discovery saw and what the capture navigated to;
 *  - an UNCLASSIFIED URL defaults to `page`, because that is the direction the errors should fall. A page
 *    that should have been a post is a filing mistake a human can fix in one click; a post invented from a
 *    listing is junk content in the feed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ORIGIN = 'https://example-domain.test';

/** capture.mjs's key: origin + path, trailing slashes removed, query and hash ignored. */
function kindKey(u, origin = ORIGIN) {
  try {
    const x = new URL(u, origin);
    return (x.origin + x.pathname).replace(/\/+$/, '') || x.origin;
  } catch {
    return String(u || '').replace(/\/+$/, '');
  }
}

/** capture.mjs's carry-through: discovery rows in, one manifest row per captured URL out. */
function manifestRows(discovered, captured) {
  const kindByUrl = new Map();
  for (const p of discovered) {
    if (p && p.url) kindByUrl.set(kindKey(p.url), String(p.kind || 'page'));
  }
  return captured.map((url, i) => ({
    slug: `s${i}`,
    url,
    kind: kindByUrl.get(kindKey(url)) || 'page',
  }));
}

test('a discovered post reaches the manifest as a post', () => {
  const rows = manifestRows(
    [
      { url: `${ORIGIN}/`, kind: 'page', home: true },
      { url: `${ORIGIN}/about-us`, kind: 'page' },
      { url: `${ORIGIN}/leadership-principles`, kind: 'post' },
    ],
    [`${ORIGIN}/`, `${ORIGIN}/about-us`, `${ORIGIN}/leadership-principles`]
  );
  assert.deepEqual(
    rows.map((r) => r.kind),
    ['page', 'page', 'post']
  );
});

test('the trailing slash does not lose the classification', () => {
  // Discovery reads `<loc>` from a sitemap, which may or may not end in a slash; the capture navigates to
  // whichever form the nav linked. Keying on the raw string made those two different URLs, so the kind was
  // dropped for exactly the pages a sitemap described best.
  const rows = manifestRows(
    [{ url: `${ORIGIN}/leadership-principles/`, kind: 'post' }],
    [`${ORIGIN}/leadership-principles`]
  );
  assert.equal(rows[0].kind, 'post');
});

test('a query string or hash does not lose it either', () => {
  const rows = manifestRows(
    [{ url: `${ORIGIN}/leadership-principles`, kind: 'post' }],
    [`${ORIGIN}/leadership-principles?utm_source=nav#top`]
  );
  assert.equal(rows[0].kind, 'post');
});

test('an unclassified URL defaults to page, not post', () => {
  // The whole asymmetry: this default is what every URL used to get, so an unknown page converts exactly as
  // it did before posts existed. Defaulting the other way would invent posts out of anything undiscovered.
  const rows = manifestRows([], [`${ORIGIN}/something-nobody-classified`]);
  assert.equal(rows[0].kind, 'page');
});

test('an archive is carried as an archive, not quietly turned into a page', () => {
  // In practice an archive never gets this far: discoverPages() filters them out of `pages` before the
  // capture loop sees them, because WordPress regenerates a category listing from the posts and converting
  // the source's rendered one would freeze a listing that is correct for one day and shadow the real archive.
  // So this asserts the mapping's FIDELITY, not a live path: if archives are ever captured deliberately (to
  // read their ordering, say), the label must arrive intact rather than be flattened to `page` in transit.
  const rows = manifestRows(
    [{ url: `${ORIGIN}/category/leadership/`, kind: 'archive' }],
    [`${ORIGIN}/category/leadership`]
  );
  assert.equal(rows[0].kind, 'archive');
});

test('a row whose URL could not be parsed still gets a kind', () => {
  // Never throw on the way to a manifest: a bundle short one page is useful, a bundle that died writing it
  // is not.
  const rows = manifestRows([{ url: 'not a url', kind: 'post' }], ['not a url']);
  assert.equal(rows[0].kind, 'post');
});
