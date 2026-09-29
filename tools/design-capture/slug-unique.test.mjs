/**
 * Guard for page-slug uniqueness across a multi-page capture.
 *
 * The defect: slugs came from the LAST path segment only, so two pages in different sections that end the
 * same way collapsed onto one slug and the second import silently OVERWROTE the first. Measured on a real
 * 133-page conversion — `/construction-loans/fha` and `/modular-home-financing/loan-options/fha` both became
 * `fha` (likewise `usda`, `va`), so three source pages were lost. 132 source paths produced 129 distinct
 * slugs, and because a per-slug check finds a page for every path, the loss passed verification: every path
 * "had a page", they just shared it.
 *
 * The logic is reimplemented here rather than imported because capture.mjs is a script with side effects at
 * module scope; what is pinned is the RULE, and the assertions are written against the real colliding paths.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ORIGIN = 'https://example.test';
const clean = (x) => String(x).toLowerCase().replace(/\.(html?|php|aspx?)$/i, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
function slugFromUrl(u) {
  const path = new URL(u, ORIGIN).pathname.replace(/\/+$/, '');
  const seg = clean(path.split('/').filter(Boolean).pop() || 'home');
  return seg === '' || seg === 'index' ? 'home' : seg;
}
function uniqueSlugFromUrl(u, used) {
  const base = slugFromUrl(u);
  if (!used.has(base)) { used.add(base); return base; }
  const segs = new URL(u, ORIGIN).pathname.split('/').filter(Boolean);
  for (let take = 2; take <= segs.length; take++) {
    const cand = segs.slice(-take).map(clean).filter(Boolean).join('-');
    if (cand && !used.has(cand)) { used.add(cand); return cand; }
  }
  for (let n = 2; n < 500; n++) { const cand = `${base}-${n}`; if (!used.has(cand)) { used.add(cand); return cand; } }
  used.add(base); return base;
}
const assign = (paths) => { const used = new Set(); return paths.map((p) => uniqueSlugFromUrl(ORIGIN + p, used)); };

test('the real colliding paths now get distinct slugs', () => {
  const got = assign(['/construction-loans/fha', '/modular-home-financing/loan-options/fha']);
  assert.deepEqual(got, ['fha', 'loan-options-fha']);
  assert.equal(new Set(got).size, 2, 'two source pages must not share one page');
});

test('the first claimant keeps the readable slug', () => {
  // Whoever gets there first keeps `fha`; the other says where it came from. Stable and legible.
  const [a, b] = assign(['/modular-home-financing/loan-options/fha', '/construction-loans/fha']);
  assert.equal(a, 'fha');
  assert.equal(b, 'construction-loans-fha');
});

test('non-colliding paths are completely unaffected', () => {
  // The fix must not rename pages that were already fine — that would break every existing permalink.
  const paths = ['/', '/about', '/pricing', '/modular-home-financing/states/alabama'];
  assert.deepEqual(assign(paths), ['home', 'about', 'pricing', 'alabama']);
});

test('a whole realistic batch yields one slug per page', () => {
  const paths = ['/', '/about', '/construction-loans', '/construction-loans/fha', '/construction-loans/usda',
    '/construction-loans/va', '/modular-home-financing/loan-options/fha',
    '/modular-home-financing/loan-options/usda', '/modular-home-financing/loan-options/va'];
  const got = assign(paths);
  assert.equal(new Set(got).size, paths.length, `expected ${paths.length} distinct slugs, got ${got.join(', ')}`);
});

test('three levels of collision still resolve', () => {
  const got = assign(['/a/x/fha', '/b/x/fha', '/c/x/fha']);
  assert.equal(new Set(got).size, 3, got.join(', '));
  assert.equal(got[0], 'fha');
  assert.equal(got[1], 'x-fha');
  assert.equal(got[2], 'c-x-fha', 'the third climbs further rather than reusing a taken ancestor slug');
});

test('NEGATIVE: identical paths cannot each claim a slug, but never silently share one', () => {
  // The same URL twice is a caller bug, not a naming problem. It must still not produce one page for two
  // entries without saying so — a numeric suffix is visible; a silent overwrite is not.
  const got = assign(['/x/fha', '/x/fha']);
  assert.equal(new Set(got).size, 2, got.join(', '));
});

test('the root is always home', () => {
  assert.deepEqual(assign(['/']), ['home']);
  assert.deepEqual(assign(['/index.html']), ['home']);
});
