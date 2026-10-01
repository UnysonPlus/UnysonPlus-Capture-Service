// Regression guard: a container and its only child never carry the SAME Box Preset.
//
// The Box-Preset census runs two independent loops — one assigns `box_style` to every icon_box that stashed
// a skin, the other assigns `border_preset` to every column / flexbox that stashed one. Neither loop knows
// what the other did, so a container and its single child can both stash the same skin and both be assigned
// it. The page then ships `boxp-x` on a flexbox AND `boxp-x` on the icon_box inside it: two borders, two
// fills, two radii, nested, plus the inner card's own padding.
//
// Measured on the corpus: 24 of 134 boxed flexboxes (18%) wrap exactly one icon_box, across 7 of 22 sites.
//
// The rule the PHP path already enforced via its `$box_via_class` flag — one shortcode in the container, the
// shortcode owns the box; two or more, the container owns it — now runs on both paths.
//
// PHP twin: Mapper::collapse_double_box(), guarded by box-owner-flexbox-test.php.
//
// Run: node box-owner-parity.test.mjs

import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./capture.mjs', import.meta.url), 'utf8');

// The census is deep inside capture()'s flow, so lift the collapser out of the source and exercise it
// directly — the same shape the PHP golden builds.
const m = src.match(/const collapseDoubleBox = \(n\) => \{[\s\S]*?\n        \};/);
assert.ok(m, 'collapseDoubleBox not found in capture.mjs — the census post-pass is missing');
const collapseDoubleBox = eval('(' + m[0].replace(/^const collapseDoubleBox = /, '').replace(/;$/, '') + ')');

const pair = (outer, inner, extraKid) => ({
  type: 'flexbox', atts: { border_preset: outer },
  _items: [{ type: 'simple', shortcode: 'icon_box', atts: { box_style: inner } }, ...(extraKid ? [extraKid] : [])],
});

let t = pair('boxp-outline', 'boxp-outline');
collapseDoubleBox(t);
assert.strictEqual(t.atts.border_preset, '', 'the CONTAINER drops a duplicate preset');
assert.strictEqual(t._items[0].atts.box_style, 'boxp-outline', 'the single shortcode keeps it');

t = pair('boxp-panel', 'boxp-outline');
collapseDoubleBox(t);
assert.strictEqual(t.atts.border_preset, 'boxp-panel', 'NEGATIVE: two different presets are two real boxes');

t = pair('boxp-outline', '');
collapseDoubleBox(t);
assert.strictEqual(t.atts.border_preset, 'boxp-outline', 'NEGATIVE: nothing to collapse into — the container still paints');

t = pair('boxp-outline', 'boxp-outline', { type: 'simple', shortcode: 'button', atts: {} });
collapseDoubleBox(t);
assert.strictEqual(t.atts.border_preset, 'boxp-outline', 'NEGATIVE: 2+ children need a wrapper around both');

t = { type: 'flexbox', atts: {}, _items: [pair('boxp-card', 'boxp-card')] };
collapseDoubleBox(t);
assert.strictEqual(t._items[0].atts.border_preset, '', 'a doubled box two levels down is collapsed too');

console.log('✓ box-owner-parity — one box, one owner (5 assertions)');
