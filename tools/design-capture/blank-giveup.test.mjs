/**
 * Guard for abandoning a source whose inner routes render blank.
 *
 * Measured on a real run: a single-page conversion request produced 54 navigations, 12 blank renders and
 * 12 hydration retries — every discovered page returning ZERO sections at roughly 34 seconds each. Five to
 * seven minutes spent proving the same fact repeatedly, because nothing watched the pattern.
 *
 * One blank page is bad luck; several in a row is the shape of the site. The rule is pinned here rather
 * than in capture.mjs's loop because the loop needs a browser and the RULE does not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BLANK_GIVE_UP = 2;

/** Replays the loop's decision over a sequence of page outcomes; returns what it captured and skipped. */
function plan(outcomes, giveUp = BLANK_GIVE_UP) {
  let blankRun = 0, gaveUp = 0;
  const captured = [];
  for (const [i, empty] of outcomes.entries()) {
    if (blankRun >= giveUp) { gaveUp++; continue; }
    blankRun = empty ? blankRun + 1 : 0;
    captured.push(i);
  }
  return { captured, gaveUp, attempted: captured.length };
}

test('a run of blanks stops the crawl', () => {
  // 9 discovered pages, all empty: attempt only until the rule trips.
  const r = plan(new Array(9).fill(true));
  assert.equal(r.attempted, 2, 'two attempts is enough to establish the pattern');
  assert.equal(r.gaveUp, 7, 'the rest are skipped rather than navigated');
});

test('a page that renders RESETS the run', () => {
  // A blank, then a real page, then a blank: the counter must go back to zero at the real page, so the
  // single blank before it cannot combine with the one after to trip the rule.
  const r = plan([true, false, true, false, true, false]);
  assert.equal(r.gaveUp, 0, 'no pages abandoned while content keeps appearing');
  assert.equal(r.attempted, 6);
});

test('NEGATIVE: a healthy source is never abandoned', () => {
  // The way to get this wrong is a rule that trims a site which was converting fine.
  const r = plan(new Array(12).fill(false));
  assert.equal(r.gaveUp, 0);
  assert.equal(r.attempted, 12, 'every discovered page is still captured');
});

test('NEGATIVE: one unlucky blank does not end the crawl', () => {
  const r = plan([false, true, false, false]);
  assert.equal(r.gaveUp, 0);
  assert.equal(r.attempted, 4);
});

test('the blank pages that WERE attempted are still kept', () => {
  // They are part of the source; a blank page is a fact about the site, not a reason to drop a capture.
  const r = plan([true, true, true, true]);
  assert.deepEqual(r.captured, [0, 1], 'the two attempted are captured, the rest never navigated');
});

test('the saving is the point: 9 blank pages cost 2 navigations, not 9', () => {
  const naive = 9, withRule = plan(new Array(9).fill(true)).attempted;
  assert.ok(withRule < naive / 3, `expected a large saving, attempted ${withRule} of ${naive}`);
});
