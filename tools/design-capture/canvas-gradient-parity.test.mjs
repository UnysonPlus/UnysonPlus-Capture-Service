// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// PAGE CANVAS GRADIENT parity (browser-free). A source whose whole identity is a full-height gradient on
// <body> converted to ONE FLAT fill: only the background-COLOUR was read off the canvas, and on this (JS)
// side not even that -- the option was emitted by neither twin, so a JS-path conversion left the canvas at
// the palette default. No band-level lens reports it, because every band still matches its own counterpart.
// PHP twin: tests/golden-fixture-1-test.php [CG].   Run: node canvas-gradient-parity.test.mjs
import { gradientToV2, splitCssArgs, toThemeSettings } from './to-theme-settings.mjs';

let fails = 0;
const ok = (cond, msg, got) => { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + msg + (cond ? '' : '  (got: ' + JSON.stringify(got) + ')')); if (!cond) fails++; };
const eq = (msg, want, got) => ok(JSON.stringify(want) === JSON.stringify(got), msg + ' == ' + JSON.stringify(want), got);

console.log('\n=== PAGE CANVAS GRADIENT (PHP twin: golden [CG]) ===');

// The real captured canvas: oklch/oklab stops with inner spaces, four positions.
const REAL = 'linear-gradient(145deg, oklch(0.205 0.045 265) 0%, oklab(0.345976 0.0227877 -0.0963011) 38%, oklab(0.387292 -0.0395197 -0.0403311) 70%, oklch(0.205 0.045 265) 100%)';
{
  const g = gradientToV2(REAL);
  ok(!!g, 'real canvas gradient parses', g);
  eq('type', 'linear', g.type);
  eq('angle carried from the source (145deg, not the 180deg CSS default)', 145, g.angle);
  eq('all four stops survive', 4, g.stops.length);
  eq('mid stop position preserved (not redistributed evenly)', 38, g.stops[1].position);
  // The PHP twin stores hex here; this side keeps the normalised rgb() form normc() produces. Both round-trip
  // through the same option type, so assert the CHANNELS agree rather than the spelling.
  ok(/^rgb\(13, 22, 44\)$|^#0d162c$/i.test(g.stops[0].color), 'first stop resolves to the source canvas colour', g.stops[0].color);
  ok(/^rgb\(13, 22, 44\)$|^#0d162c$/i.test(g.stops[3].color), 'last stop closes back to the base colour', g.stops[3].color);
}

// Top-level splitting: a functional colour's own commas must not cut the argument list.
eq('splitCssArgs ignores commas inside parens', 2, splitCssArgs('rgba(1, 2, 3, .5) 0%, oklab(0.1 0.2 0.3) 100%').length);

// The cases that were WRONG in the first PHP cut, guarded on both sides.
eq('`to bottom right` becomes 135deg', 135, gradientToV2('linear-gradient(to bottom right, #fff, #000)').angle);
eq('stops with no position are distributed evenly', [0, 50, 100],
   gradientToV2('linear-gradient(90deg, red, green, blue)').stops.map((s) => s.position));
ok(gradientToV2('linear-gradient(90deg, red, green, blue)').stops.every((s) => s.color),
   'NAMED colours resolve (all 147 returned empty before, which deleted the whole gradient)');
{
  const r = gradientToV2('radial-gradient(circle, rgba(255,255,255,.6) 0%, transparent 70%)');
  ok(!!r && r.type === 'radial', 'radial with a shape prelude parses', r);
  eq('a transparent STOP is kept (it is the fade, not "no colour")', 2, r.stops.length);
  ok(/rgba\(0, 0, 0, 0\)/.test(r.stops[1].color), 'transparent stop becomes a zero-alpha colour', r.stops[1].color);
}
eq('0.25turn becomes 90deg', 90, gradientToV2('linear-gradient(0.25turn, #111 0%, #222 100%)').angle);
eq('a layered background-image takes the FIRST gradient', 0, gradientToV2('linear-gradient(0deg, #010203 0%, #040506 100%), url(x.png)').angle);

// Correctly REFUSED -- a fake would paint something the source never showed.
for (const [label, css] of [['conic', 'conic-gradient(#fff, #000)'], ['single stop', 'linear-gradient(90deg, #fff)'],
                            ['plain url', 'url(x.png)'], ['empty', '']]) {
  ok(gradientToV2(css) === null, 'refuses ' + label, gradientToV2(css));
}

// End to end: the canvas record must reach general_layout.site_background with BOTH layers.
{
  const home = { canvas: { color: 'oklch(0.205 0.045 265)', gradient: REAL } };
  // toThemeSettings returns { values }, not the values themselves.
  const v = toThemeSettings({ palette: {}, typography: {} }, home).values || {};
  const sb = ((v.general_layout || {}).site_background) || {};
  ok(!!(sb.color && sb.color.value), 'base colour layer emitted', sb.color);
  ok(!!(sb.gradient && sb.gradient.data && sb.gradient.data.stops.length === 4), 'gradient layer emitted under .data', sb.gradient);
  // NEGATIVE: a flat canvas must not invent a gradient.
  const flat = toThemeSettings({ palette: {}, typography: {} }, { canvas: { color: 'rgb(13, 22, 44)', gradient: '' } }).values || {};
  const fsb = ((flat.general_layout || {}).site_background) || {};
  ok(!fsb.gradient, 'NEGATIVE flat canvas emits no gradient layer', fsb.gradient);
  ok(!!(fsb.color && fsb.color.value), 'NEGATIVE flat canvas still carries its colour', fsb.color);
}

console.log(fails === 0 ? '\n✓ ALL PASS — canvas colour + gradient reach Site Background on both twins\n'
                        : '\n✗ ' + fails + ' FAILURE(S)\n');
process.exit(fails === 0 ? 0 : 1);
