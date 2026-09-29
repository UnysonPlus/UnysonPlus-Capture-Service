/**
 * Guards for the site-wide verification pass.
 *
 * Why it exists: `verifySections` and `verifyUrls` each take ONE source/converted pair, and nothing ever
 * looped them — so every layout claim made about a conversion was a claim about its home page. Measured
 * on a real site once this existed: the home page had 17 missing items, the site had 158. Judging the
 * conversion on the home page alone was seeing about a tenth of the problem.
 *
 * Network-free: the rules worth pinning are the page PLAN and the URL mapping, both pure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPages, convertedPathFor, gradeSections } from './verify-site.mjs';

test('the converted URL for a source path is its page slug', () => {
  // A converted WordPress site is flat: /guides/financing becomes /financing/, because the importer
  // creates one page per captured screen keyed by its slug, not by the source's folder nesting.
  assert.equal(convertedPathFor('/'), '/');
  assert.equal(convertedPathFor('/about'), '/about/');
  assert.equal(convertedPathFor('/guides/financing'), '/financing/');
  assert.equal(convertedPathFor(''), '/');
});

test('the home page always leads the plan', () => {
  // Everything else is judged against it, and a run that checked three inner pages but not '/' would
  // report drift with nothing to anchor it.
  assert.deepEqual(planPages(['/about', '/pricing']), ['/', '/about', '/pricing']);
  assert.deepEqual(planPages(['/about', '/', '/pricing']), ['/', '/about', '/pricing']);
});

test('duplicates collapse and bare paths gain a slash', () => {
  assert.deepEqual(planPages(['about', '/about', '/about']), ['/', '/about']);
});

test('the cap trims the TAIL, never the home page', () => {
  // The cap is applied last on purpose: applying it before inserting '/' would drop the one page the
  // whole comparison depends on whenever the caller passed a full list and a small limit.
  const got = planPages(['/a', '/b', '/c', '/d'], 2);
  assert.equal(got[0], '/', 'home survives the cap');
  assert.equal(got.length, 2);
});

test('an empty or junk list still yields a runnable plan', () => {
  assert.deepEqual(planPages([]), ['/']);
  assert.deepEqual(planPages(null), ['/']);
  assert.deepEqual(planPages([null, '', 0]), ['/']);
});

test('a limit below one is still one page', () => {
  assert.deepEqual(planPages(['/a'], 0), ['/']);
  assert.deepEqual(planPages(['/a'], -5), ['/']);
});

/* ---- grading: an unmeasured page is not a clean page ---------------------- */

test('a page with sections is graded normally', () => {
  const r = gradeSections('/about', [
    { id: 'hero', dh: 40, findings: [{ kind: 'missing' }, { kind: 'moved' }] },
    { id: 'faq', dh: -10, findings: [{ kind: 'img-missing' }] },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.sections, 2);
  assert.equal(r.missing, 2, 'missing counts only the missing kinds, not moved');
  assert.equal(r.height_delta_px, 50, 'height delta is the sum of ABSOLUTE deltas');
  assert.equal(r.worst_section, 'hero');
});

test('NEGATIVE: a page with NO sections is ungraded, never perfect', () => {
  // The bug this exists for: nine of ten pages were fetched at a mangled URL, returned nothing, and
  // every one scored `missing=0, |Δh|=0`. The totals read like a near-perfect conversion while exactly
  // one page had been measured. An empty result is the absence of a measurement, not a good one.
  for (const empty of [[], null, undefined]) {
    const r = gradeSections('/about', empty);
    assert.equal(r.ok, false, String(empty));
    assert.match(r.error, /not graded/);
    assert.equal(r.missing, undefined, 'it must not report a score at all');
    assert.equal(r.height_delta_px, undefined);
  }
});

test('a clean page and an unloaded page are distinguishable', () => {
  // Both have zero findings. Only one of them was actually looked at.
  const clean = gradeSections('/a', [{ id: 's1', dh: 0, findings: [] }]);
  const unloaded = gradeSections('/a', []);
  assert.equal(clean.ok, true);
  assert.equal(clean.missing, 0);
  assert.equal(unloaded.ok, false);
  assert.notEqual(clean.ok, unloaded.ok, 'the report must not conflate them');
});
