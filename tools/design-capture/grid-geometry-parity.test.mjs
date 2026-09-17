// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Grid cell GEOMETRY parity (browser-free). An UNEQUAL source grid (`1.08fr .92fr` → 736.5px / 627.5px tracks)
// renders as a native Grid carrying the exact track list (the 12-span model rounded it to 6/6); a cell's fixed
// min-height (a 640px card) and its flex-column vertical centring ride on the cell. Negative: equal tracks stay
// on the flex/span path. PHP twin: tests/golden-fixture-1-test.php [G].
// Run: node grid-geometry-parity.test.mjs   (exit 1 on any failure)
import { toPages } from './to-pages.mjs';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + msg); if (!cond) fails++; };

const text = (t) => ({ t: 'text', html: '<p>' + t + '</p>', text: t, tag: 'p', cls: '', fontSize: '16px', color: 'rgb(60, 60, 60)', lineHeight: '32px', bg: '', bgImage: '', border: '', borderRadius: '0px', boxShadow: '', padding: '0px', backdrop: '', position: 'static' });
const cap = (tracks) => ({ url: 'http://x/', sections: [{ sectionClass: 'section', computed: { padding: '120px 0px', margin: '0px' }, blocks: [
  { t: 'row', role: 'columns', gap: '28px', gapResp: null, cols: [
    { width: '1_2', cls: '', fullCls: 'left', colId: 'sccol-0', cw: 6, track: tracks[0], minH: 640, flex: { dir: 'column', justify: 'center', align: 'normal', gap: '0px' },
      html: '<h2>Designed to breathe</h2><p>The landscape follows the valley.</p>', blocks: [{ t: 'heading', level: 2, html: 'Designed to breathe', text: 'Designed to breathe' }, text('The landscape follows the valley.')] },
    { width: '1_2', cls: '', fullCls: 'right', colId: 'sccol-1', cw: 6, track: tracks[1], minH: 640,
      html: '<p>Aside</p>', blocks: [text('Aside')] },
  ] },
] }] });
const rowOf = (out) => {
  const find = (n) => { if (!n || typeof n !== 'object') return null; if (n.type === 'flexbox' && (n._items || []).length === 2 && n._items[0].type === 'flexbox') return n; for (const c of (n._items || [])) { const r = find(c); if (r) return r; } return null; };
  for (const s of (out?.pages?.[0]?.builder || [])) { const r = find(s); if (r) return r; }
  return null;
};

console.log('\n=== unequal tracks → native Grid with the exact ratio; min-height + centring on the cell ===');
{
  const row = rowOf(toPages(cap([736.547, 627.453]), { hifiCss: true }));
  ok(!!row, 'the two-cell row is found');
  ok(row && row.atts.display === 'grid', 'unequal tracks → native Grid mode');
  ok(row && row.atts.grid_columns === '1.08fr 0.92fr', 'grid_columns carries the exact track ratio');
  ok(row && !row._items[0].atts.width && !row._items[1].atts.width, 'cells carry no 12-span width (the tracks size them)');
  ok(row && row._items[0].atts.track_px === undefined, 'no track_px leaks into the builder atts');
  const l = row && row._items[0].atts, r = row && row._items[1].atts;
  ok(l && l.min_height && l.min_height.base.value === '640' && l.min_height.base.unit === 'px', 'left cell min-height 640px');
  ok(r && r.min_height && r.min_height.base.value === '640', 'right cell min-height 640px');
  ok(l && l.direction && l.direction.base === 'column' && l.justify_content && l.justify_content.base === 'center', 'left cell (flex-column, justify center) → direction column + justify_content center');
}
console.log('\n=== framed photo tile: cell box → clipping Box Preset; lone image → media_image FILL (PHP twin: golden [G2]) ===');
{
  const tile = { src: 'https://example.invalid/a.jpg', alt: 'Landscape', fill: true };
  const box = { bg: '', fill: '', gradient: 'linear-gradient(rgba(255, 255, 255, 0.24), rgba(255, 255, 255, 0.14))', radius: '42px', borderWidth: '1px', borderStyle: 'solid', borderColor: 'rgba(131, 108, 74, 0.08)', shadow: 'rgba(255, 255, 255, 0.25) 0px 1px 0px 0px inset, rgba(98, 78, 45, 0.08) 0px 22px 60px 0px', backdrop: '', padding: '', clip: true };
  const c2 = cap([736.547, 627.453]);
  const right = c2.sections[0].blocks[0].cols[1];
  delete right.blocks; right.html = '<img src="https://example.invalid/a.jpg" alt="Landscape">'; right.image = tile; right.cardBox = box;
  const out = toPages(c2, { hifiCss: true });
  const row = rowOf(out);
  const rc = row && row._items[1];
  ok(rc && rc.atts.direction && rc.atts.direction.base === 'column', 'right cell is a flex column (the image can grow to the card height)');
  const img = rc && rc._items[0];
  ok(img && img.shortcode === 'media_image', 'lone image → native media_image');
  ok(img && /selector img\{flex:1 1 auto;width:100%;min-height:0;object-fit:cover;display:block;\}/.test(img.atts.custom_css || ''), 'media_image FILL rule (grows in the flex column, object-fit cover)');
  ok(rc && rc.atts._box && rc.atts._box.clip === true, 'the cell carries its card box (with clip) for the Box Preset');
  const { buildBorderPresets } = await import('./box-presets.mjs');
  const bp = buildBorderPresets([box, { ...box, clip: false }]);
  const clipP = bp.presets.find((p) => /overflow:hidden/.test(p.custom_css || ''));
  ok(!!clipP && clipP.custom_css.includes('{{SELECTOR}}{overflow:hidden;}'), 'tile preset CLIPS its media (overflow:hidden in the preset CSS)');
  ok(bp.presets.filter((p) => String(p.border_radius && p.border_radius.value) === '42').length === 2, 'tile preset is distinct from a text card with the same skin (clip keys the signature)');
  // MULTI-LAYER shadow: the native field holds the MOST VISIBLE layer (the 22/60 drop, not the first-listed inset); the FULL value rides in the preset CSS.
  ok(!!clipP && clipP.states.default.box_shadow && clipP.states.default.box_shadow.y === 22 && clipP.states.default.box_shadow.inset === false, 'tile preset native shadow = the most visible layer (the 22/60 drop, not the inset)');
  ok(!!clipP && clipP.custom_css.includes('{{SELECTOR}}{box-shadow:rgba(255, 255, 255, 0.25) 0px 1px 0px 0px inset, rgba(98, 78, 45, 0.08) 0px 22px 60px 0px !important;}'), 'tile preset CSS carries the FULL two-layer shadow');
  const one = buildBorderPresets([{ ...box, shadow: 'rgba(98, 78, 45, 0.08) 0px 22px 60px 0px', clip: false }]).presets.find((p) => String(p.border_radius && p.border_radius.value) === '42');
  ok(!!one && !/box-shadow/.test(one.custom_css || ''), 'single-layer shadow → NO full-shadow rule in the preset CSS');
  // NEGATIVE — a lone image with no card box: no fill, no box.
  const c3 = cap([736.547, 627.453]); const r3 = c3.sections[0].blocks[0].cols[1]; delete r3.blocks; r3.html = '<img src="https://example.invalid/a.jpg" alt="x">'; r3.image = { src: 'https://example.invalid/a.jpg', alt: 'x' };
  const row3 = rowOf(toPages(c3, { hifiCss: true })); const img3 = row3 && row3._items[1]._items[0];
  ok(img3 && !/object-fit:cover/.test(img3.atts.custom_css || ''), 'no card box → the lone image is NOT forced into fill mode');
  ok(row3 && !row3._items[1].atts._box, 'no card box → no Box Preset on the cell');
}

console.log('\n=== decorative pseudo-layer: card ::before glow → scoped rule; the card clips (PHP twin: golden [G5]) ===');
{
  const c4 = cap([736.547, 627.453]);
  const left = c4.sections[0].blocks[0].cols[0];
  left.cardBox = { bg: '', fill: '', gradient: 'linear-gradient(rgba(255, 255, 255, 0.72), rgba(255, 255, 255, 0.28))', radius: '42px', borderWidth: '1px', borderStyle: 'solid', borderColor: 'rgba(131, 108, 74, 0.08)', shadow: '', backdrop: '', padding: '70px' };
  left.decorPseudo = { pe: 'before', top: '-19.9%', left: '-8%', width: '41.9%', height: '41.9%', background: 'radial-gradient(circle, rgba(215, 170, 97, 0.14), rgba(0, 0, 0, 0) 70%)', filter: 'blur(30px)' };
  const row = rowOf(toPages(c4, { hifiCss: true }));
  const css = (row && row._items[0].atts.custom_css) || '';
  ok(css.includes('selector::before{content:"";position:absolute;pointer-events:none;z-index:-1;top:-19.9%;left:-8%;width:41.9%;height:41.9%;background:radial-gradient(circle, rgba(215, 170, 97, 0.14), rgba(0, 0, 0, 0) 70%);filter:blur(30px);}'), 'column gets the scoped ::before glow (geometry in %, radial background, blur)');
  ok(css.includes('selector{position:relative;isolation:isolate;}'), 'column is an isolated positioned ancestor');
  ok(row && row._items[0].atts._box && row._items[0].atts._box.clip === true, "a glow reaching outside the box → the card's skin clips");
  const row0 = rowOf(toPages(cap([736.547, 627.453]), { hifiCss: true }));
  ok(row0 && !/::before/.test(row0._items[0].atts.custom_css || ''), 'negative: no decorPseudo → no ::before rule');
}

console.log('\n=== NEGATIVE: equal tracks stay on the flex/span path ===');
{
  const row = rowOf(toPages(cap([682, 682]), { hifiCss: true }));
  ok(row && row.atts.display === 'flex' && !/fr/.test(String(row.atts.grid_columns || '')), 'equal tracks → flex row, no track list');
  ok(row && row._items[0].atts.width && row._items[0].atts.width.base.preset === '6', 'equal tracks → 6/6 spans');
}

console.log(fails ? `\n✗ ${fails} FAIL` : '\n✓ ALL PASS — grid cell geometry parity guarded');
process.exit(fails ? 1 : 0);
