/**
 * Guards for the PHP-vs-JS path parity sweep.
 *
 * Network-free and WP-free: the rules worth pinning are the inventory walk and the comparison, both pure.
 * The refusal is the one that matters — see the NEGATIVE.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inventory, compare } from './path-parity.mjs';

test('the inventory counts shortcodes at any depth', () => {
  const tree = [{ shortcode: 'section', _items: [
    { shortcode: 'column', _items: [{ shortcode: 'text_block' }, { shortcode: 'text_block' }] },
    { shortcode: 'icon_box', atts: { nested: { shortcode: 'button' } } },
  ] }];
  assert.deepEqual(inventory(tree), { section: 1, column: 1, text_block: 2, icon_box: 1, button: 1 });
});

test('the inventory of nothing is nothing, not a crash', () => {
  for (const v of [null, undefined, [], {}, 'str', 7]) assert.deepEqual(inventory(v), {});
});

test('identical inventories are zero divergence', () => {
  const r = compare({ text_block: 3, button: 1 }, { text_block: 3, button: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.divergence, 0);
  assert.deepEqual(r.rows, [], 'nothing to look at');
});

test('divergence measures WHICH shortcodes differ, not just how many there are', () => {
  // Ten of one against ten of another is total disagreement, even though both totals are ten. A count-only
  // comparison would call this a perfect match and hide the entire problem.
  const r = compare({ text_block: 10 }, { icon_box: 10 });
  assert.equal(r.divergence, 1);
  assert.deepEqual(r.rows.map((x) => x.shortcode), ['icon_box', 'text_block']);
});

test('the rows name both sides and the direction of the gap', () => {
  const r = compare({ code_block: 5, icon_box: 1 }, { code_block: 1, icon_box: 4 });
  const cb = r.rows.find((x) => x.shortcode === 'code_block');
  assert.deepEqual({ js: cb.js, php: cb.php, delta: cb.delta }, { js: 5, php: 1, delta: 4 },
    'a positive delta means JS emitted more of it — here, more verbatim fallbacks than PHP');
});

test('NEGATIVE: an empty side is refused, never scored as total divergence', () => {
  // The bug this exists for: two stored captures held zero sections — failed captures — and scoring them
  // put both at 1.0, the worst divergence on the board. A broken INPUT then reads as a broken CONVERTER,
  // and the mean it drags up is a number about nothing.
  for (const [a, b] of [[{}, { text_block: 7 }], [{ text_block: 7 }, {}], [{}, {}]]) {
    const r = compare(a, b);
    assert.equal(r.ok, false);
    assert.match(r.error, /not graded/);
    assert.equal(r.divergence, undefined, 'it must not report a score at all');
  }
});

test('a converged pair and an unmeasured pair are distinguishable', () => {
  // Both have no rows to show. Only one of them was actually compared.
  const same = compare({ text_block: 2 }, { text_block: 2 });
  const blank = compare({}, {});
  assert.equal(same.ok, true);
  assert.equal(blank.ok, false);
  assert.notEqual(same.ok, blank.ok);
});
