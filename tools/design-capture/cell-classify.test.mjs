/**
 * Guards for `tagOf`, which fills the conversion report's `src_tag` column.
 *
 * Why it exists: `src_tag` was a DECLARED column of the report that nothing ever wrote — 0 of 50 fallback
 * rows on a real capture. Without it the report could say a cell went unrecognized but not what it WAS,
 * which is exactly what a new mapping rule has to be written against. Cells carry no tag of their own
 * (containers and lines do), so it is read off the cell's own markup.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagOf } from './to-pages.mjs';

/* ---- the report column that named none of this --------------------------- */

test('tagOf names the element a fragment opens with', () => {
  // `src_tag` is a declared column of the conversion report and nothing wrote it — 0 of 50 fallback rows on
  // a real capture. Without it the report could say a cell went unrecognized but not what it WAS, which is
  // exactly what a new mapping rule has to be written against.
  assert.equal(tagOf('<div class="x">hi</div>'), 'div');
  assert.equal(tagOf('  <UL><li>a</li></UL>'), 'ul', 'case-folded, leading space tolerated');
  assert.equal(tagOf('<my-widget a=1>'), 'my-widget', 'custom elements keep their hyphen');
  assert.equal(tagOf('plain text'), '', 'text is not a tag');
  assert.equal(tagOf(null), '');
});
