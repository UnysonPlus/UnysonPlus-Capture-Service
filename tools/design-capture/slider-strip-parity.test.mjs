// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SLIDER STRIP parity (browser-free). A header row (flex, space-between, align end, gap 22, NO wrap: eyebrow + fluid h2
// left, a 400px-capped intro right) then a horizontal SCROLL STRIP (grid, column auto-flow, auto-columns minmax(78%, 980px),
// gap 18, overflow-x auto, scroll-snap x, padding-bottom 12) of three strip CARDS, each itself a .95fr/1.05fr row (rounded
// 38, gradient fill, hairline, shadow, clipped, min-height 360) of a padded copy cell (flex column space-between: eyebrow
// → h3 → p … meta) and a PAINTED image half. Rules: a no-wrap row keeps one line and a capped cell is size-frozen; a
// scroll strip keeps the item width, snap and hidden scrollbar; a cell that IS a row is claimed whole and wears its skin on
// that row; the strip cards never squeeze into a 3-column grid. PHP twin: tests/golden-fixture-1-test.php [X].
// Run: node slider-strip-parity.test.mjs   (exit 1 on any failure)
import { toPages } from './to-pages.mjs';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + msg); if (!cond) fails++; };

const text = (t, extra = {}) => ({ t: 'text', html: '<p>' + t + '</p>', text: t, tag: 'p', cls: '', fontSize: '16px', color: 'rgb(100, 88, 75)', lineHeight: '30.4px', letterSpacing: 'normal', marginBottom: '0px', marginTop: '16px', textAlign: 'start', fontWeight: '400', bg: '', bgImage: '', border: '', borderRadius: '0px', boxShadow: '', padding: '0px', backdrop: '', position: 'static', maxWidth: 'none', ...extra });
const overline = (t) => ({ t: 'overline', html: t, text: t, cls: 'section-label', pill: false, color: 'rgb(138, 124, 105)', bg: 'rgba(0, 0, 0, 0)', borderW: '0px', borderColor: '', radius: '0px', padding: '0px', backdropFilter: '', textTransform: 'uppercase', fontSize: '10px', lineHeight: '15px', letterSpacing: '3px', fontWeight: '400', gap: 'normal', iconSvg: '', iconPos: 'before' });
const cardBox = { bg: '', fill: '', gradient: 'linear-gradient(rgba(255, 255, 255, 0.66), rgba(255, 255, 255, 0.26))', radius: '38px', borderWidth: '1px', borderStyle: 'solid', borderColor: 'rgba(131, 108, 74, 0.08)', shadow: 'rgba(98, 78, 45, 0.08) 0px 18px 50px 0px', backdrop: '', padding: '', clip: true };
const paint = 'radial-gradient(circle at 30% 25%, rgba(215, 170, 97, 0.28), rgba(0, 0, 0, 0) 18%), linear-gradient(rgba(255, 255, 255, 0.12), rgba(0, 0, 0, 0.06))';
const card = (lbl, ttl, copy, meta, i) => ({ t: 'row', valign: '', gap: 0, gapResp: null, html: '<article class="strip-card">…</article>', minh: 360, rowBox: { ...cardBox }, nowrap: true, mt: 0, mb: 0, cols: [
  { width: '1_2', cls: '', fullCls: 'content', colId: 'sccol-' + (i * 2), cw: 6, track: 514.8, minH: 360, flex: { dir: 'column', justify: 'space-between', align: 'normal', gap: '0px' }, html: '<div class="content">…</div>',
    blocks: [overline(lbl), { t: 'heading', level: 3, html: ttl, text: ttl, tag: 'h3', cls: 'serif', wrapCls: '', fontSize: '44px', fontWeight: '400', color: 'rgb(42, 36, 28)', marginBottom: '0px', marginTop: '0px', lineHeight: '41.8px', letterSpacing: '-2.2px', align: 'left' }, text(copy, { maxWidth: '620px' }), overline(meta)] },
  { width: '1_2', cls: '', fullCls: 'image', colId: 'sccol-' + (i * 2 + 1), cw: 6, track: 569, minH: 360, html: '<div class="image"></div>', paint: { bgi: paint, bg: '' } },
] });
const strip = { t: 'row', valign: '', gap: 18, gapResp: null, html: '<div class="strip">…</div>', nowrap: true, mt: 0, mb: 0, pad: { base: { top: 0, right: 0, bottom: 12, left: 0 } }, scroll: { item: 'max(78%, 980px)', snap: 'start', padB: 12 }, cols: [
  { width: '1_3', cls: '', fullCls: 'strip-card', colId: 'sccol-13', cw: 4, track: 1085.75, minH: 360, html: '<article>…</article>', blocks: [card('Irrigation pulse', 'Water arriving with precision.', 'The system regulates flow across terraces so each layer receives just enough hydration to remain in balance.', 'Pulse 07 · AM', 0)] },
  { width: '1_3', cls: '', fullCls: 'strip-card', colId: 'sccol-14', cw: 4, track: 1085.75, minH: 360, html: '<article>…</article>', blocks: [card('Terrace memory', 'The fields hold their own geometry.', 'Elevated contours preserve both the visible rhythm of the land and the invisible logic of runoff control.', 'Contour 12 · PM', 1)] },
  { width: '1_3', cls: '', fullCls: 'strip-card', colId: 'sccol-15', cw: 4, track: 1085.75, minH: 360, html: '<article>…</article>', blocks: [card('Seasonal reflection', 'Where the river slows into silence.', 'The final layer dissolves into water and sky, leaving the estate in a calm blue afterglow.', 'Reflection · Dusk', 2)] },
] };
const head = { t: 'row', valign: 'end', gap: 22, gapResp: null, html: '<div class="slider-head">…</div>', justify: 'space-between', nowrap: true, mt: 0, mb: 28, cols: [
  { width: '1_2', cls: '', fullCls: '', colId: 'sccol-11', cw: 8, html: '<div>…</div>', blocks: [overline('Still Water Slider'), { t: 'heading', level: 2, html: 'Horizontal mission states across the valley.', text: 'Horizontal mission states across the valley.', tag: 'h2', cls: 'serif', wrapCls: '', fsDecl: 'clamp(2.7rem,5vw,5.4rem)', lhDecl: '.92', lsDecl: '-.06em', fontSize: '72px', fontWeight: '400', color: 'rgb(42, 36, 28)', marginBottom: '0px', marginTop: '0px', lineHeight: '66.24px', letterSpacing: '-4.32px', align: 'left' }] },
  { width: '1_2', cls: '', fullCls: '', colId: 'sccol-12', cw: 4, maxw: '400px', html: '<p>…</p>', blocks: [text('Each strip captures a different seasonal condition: irrigation, restoration, and reflective calm.', { marginTop: '0px', lineHeight: '30.4px', maxWidth: '400px' })] },
] };
const cap = { url: 'http://x/', sections: [{ sectionClass: 'slider-section', computed: { padding: '120px 0px', margin: '0px' }, blocks: [head, strip] }] };
const out = toPages(cap, { hifiCss: true });
const sec = out.pages[0].builder.find((n) => n.type === 'section');
const find = (n, pred) => { if (!n || typeof n !== 'object') return null; if (pred(n)) return n; for (const c of (n._items || [])) { const r = find(c, pred); if (r) return r; } return null; };
const all = (n, pred, acc = []) => { if (!n || typeof n !== 'object') return acc; if (pred(n)) acc.push(n); for (const c of (n._items || [])) all(c, pred, acc); return acc; };
const css = (n) => (n && n.atts && n.atts.custom_css) || '';

console.log('\n=== slider strip (PHP twin: golden [X]) ===');
const hd = find(sec, (n) => n.type === 'flexbox' && n.atts.justify_content && n.atts.justify_content.base === 'between');
ok(!!hd && hd.atts.wrap && hd.atts.wrap.base === 'no' && hd.atts.align_items && hd.atts.align_items.base === 'end', 'header row → space-between, NO wrap, bottom-aligned');
ok(hd && /selector>\*\{flex:0 1 auto;min-width:0;\}/.test(css(hd)) && /flex-shrink:0/.test(css(hd._items[1])) && !/flex-shrink:0/.test(css(hd._items[0])), 'cells shrink, but the 400px-capped intro cell is size-frozen');
const st = find(sec, (n) => n.type === 'flexbox' && /overflow-x:auto/.test(css(n)));
ok(!!st && st.atts.wrap && st.atts.wrap.base === 'no' && (st._items || []).length === 3, 'strip → ONE no-wrap flex row of three cards that scrolls on x');
ok(st && /scroll-snap-type:x mandatory/.test(css(st)) && /scrollbar-width:none/.test(css(st)) && /::-webkit-scrollbar\{display:none;\}/.test(css(st)) && /padding-bottom:12px/.test(css(st)), 'strip keeps snap, hidden scrollbar and its 12px bottom pad');
ok(st && /selector>\*\{flex:0 0 max\(78%, 980px\);width:max\(78%, 980px\);max-width:none;scroll-snap-align:start;\}/.test(css(st)), "every card keeps the source's item width (minmax → max(78%, 980px)) and snaps");
ok(st && st._items.every((c) => c.atts.width && c.atts.width.base.preset === 'none') && !/grid/.test(st.atts.display), 'cards are content-sized (never a squeezed 3-column grid)');
const cards = all(st, (n) => n.type === 'flexbox' && n.atts.display === 'grid' && n.atts.grid_columns === '0.95fr 1.05fr');
ok(cards.length === 3, 'each card cell IS a row → native Grid with the .95fr/1.05fr tracks (claimed whole)');
ok(cards.length === 3 && cards.every((c) => c.atts._box && c.atts._box.radius === '38px' && c.atts._box.clip === true && c.atts.min_height && c.atts.min_height.base.value === '360'), 'each card row wears the card skin (radius 38, clipped) at 360 min-height');
const copy = cards[0] && cards[0]._items[0];
ok(copy && copy.atts.direction && copy.atts.direction.base === 'column' && copy.atts.justify_content && copy.atts.justify_content.base === 'between', 'copy cell = flex column, space-between');
const h3 = copy && find(copy, (n) => n.shortcode === 'special_heading' && n.atts.title === 'Water arriving with precision.');
ok(h3 && h3.atts.overline === 'Irrigation pulse' && /The system regulates/.test(h3.atts.subtitle || '') && /font-size:44px !important/.test(css(h3)) && /line-height:41\.8px !important/.test(css(h3)), 'label → h3 → p fold; the nested h3 keeps its 44px / 41.8 metrics');
const img = cards[0] && cards[0]._items[1];
ok(img && !(img._items || []).length && /background-image:radial-gradient\(circle at 30% 25%/.test(css(img)), 'painted image half → an empty cell carrying the paint');
const h2 = find(sec, (n) => n.shortcode === 'special_heading' && /Horizontal mission/.test(n.atts.title || ''));
ok(h2 && /font-size:clamp\(2\.7rem,5vw,5\.4rem\) !important;line-height:\.92 !important;letter-spacing:-\.06em !important/.test(css(h2)), 'fluid h2 keeps clamp() + relative metrics');

console.log(fails ? `\n✗ ${fails} FAIL` : '\n✓ ALL PASS — slider strip parity guarded');
process.exit(fails ? 1 : 0);
