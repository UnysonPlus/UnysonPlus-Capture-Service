// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// BAND STACK parity (browser-free). A section with a computed zero padding-top, then a STACK block (a single-track
// grid, 22px gap, 120px above) of band ROWS — each a .8fr/1.2fr grid of an EMPTY PAINTED panel + a padded copy
// cell (flex column space-between) holding eyebrow → h3 → p. Rules: zero padding is a value; a stack is one
// flexbox column with the gap + margin; a band row wears its card + min-height (clipped, a panel reaches the
// edge); the panel is an empty cell carrying the source's multi-layer paint; the copy cell keeps padding +
// space-between; label → h3 → p fold into one special heading. PHP twin: tests/golden-fixture-1-test.php [F].
// Run: node band-stack-parity.test.mjs   (exit 1 on any failure)
import { toPages } from './to-pages.mjs';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + msg); if (!cond) fails++; };

const vis = 'radial-gradient(circle at 25% 30%, rgba(215, 170, 97, 0.26), rgba(0, 0, 0, 0) 20%), radial-gradient(circle at 70% 35%, rgba(86, 120, 168, 0.18), rgba(0, 0, 0, 0) 18%), linear-gradient(rgba(255, 255, 255, 0.18), rgba(0, 0, 0, 0.06))';
const band = (lbl, ttl, copy, i) => ({ t: 'row', valign: '', gap: 0, gapResp: null, html: '<article class="band">…</article>', minh: 300,
  rowBox: { bg: '', fill: '', gradient: 'linear-gradient(rgba(255, 255, 255, 0.64), rgba(255, 255, 255, 0.24))', radius: '38px', borderWidth: '1px', borderStyle: 'solid', borderColor: 'rgba(131, 108, 74, 0.08)', shadow: 'rgba(98, 78, 45, 0.08) 0px 18px 50px 0px', backdrop: '', padding: '', clip: false },
  cols: [
    { width: '1_2', cls: '', fullCls: 'visual', colId: 'sccol-' + (i * 2), cw: 5, track: 556, minH: 300, html: '<div class="visual"></div>', paint: { bgi: vis, bg: '' } },
    { width: '1_2', cls: '', fullCls: 'copyzone', colId: 'sccol-' + (i * 2 + 1), cw: 7, track: 834, flex: { dir: 'column', justify: 'space-between', align: 'normal', gap: '0px' },
      html: '<div><div class="section-label">' + lbl + '</div><h3>' + ttl + '</h3><p>' + copy + '</p></div>',
      blocks: [
        { t: 'overline', html: lbl, text: lbl, cls: 'section-label', pill: false, color: 'rgb(138, 124, 105)', bg: 'rgba(0, 0, 0, 0)', borderW: '0px', borderColor: '', radius: '0px', padding: '0px', backdropFilter: '', textTransform: 'uppercase', fontSize: '10px', lineHeight: '15px', letterSpacing: '3px', fontWeight: '400', gap: 'normal', iconSvg: '', iconPos: 'before' },
        { t: 'heading', level: 3, html: ttl, text: ttl, tag: 'h3', cls: 'serif', wrapCls: '', fontSize: '42px', fontWeight: '400', color: 'rgb(42, 36, 28)', marginBottom: '0px', marginTop: '0px', lineHeight: '39.9px', letterSpacing: '-2.1px', align: 'left' },
        { t: 'text', html: '<p>' + copy + '</p>', text: copy, tag: 'p', cls: '', fontSize: '16px', color: 'rgb(100, 88, 75)', lineHeight: '30.4px', letterSpacing: 'normal', marginBottom: '0px', marginTop: '16px', textAlign: 'start', fontWeight: '400', bg: '', bgImage: '', border: '', borderRadius: '0px', boxShadow: '', padding: '0px', backdrop: '', position: 'static', maxWidth: '640px' },
      ] },
  ] });
const cap = { url: 'http://x/', sections: [{ sectionClass: 'section pt-0', computed: { padding: '0px 0px 120px', margin: '0px' }, blocks: [
  { t: 'heading', level: 2, html: 'Staggered layers like terraced fields.', text: 'Staggered layers like terraced fields.', tag: 'h2', cls: '', wrapCls: '', fontSize: '80px', align: 'left' },
  { t: 'stack', gap: '22px', mt: 120, mb: 0, items: [
    band('Golden-ratio cultivation', 'Organic planting geometry', 'Crop spacing and field sequencing tuned for airflow, irrigation balance, and a balanced visual cadence across the estate.', 0),
    band('Zen-organic harmonics', 'Rhythms of water and silence', 'Wind, moisture, and reflection systems create a calm sensory cadence throughout the agricultural landscape.', 1),
    band('Riparian restoration', 'River-edge recovery', 'Native vegetation and softer runoff pathways stabilize the terrain while improving biodiversity and water retention.', 2),
  ] },
] }] };
const out = toPages(cap, { hifiCss: true });
const sec = out.pages[0].builder.find((n) => n.type === 'section');
const find = (n, pred) => { if (!n || typeof n !== 'object') return null; if (pred(n)) return n; for (const c of (n._items || [])) { const r = find(c, pred); if (r) return r; } return null; };

console.log('\n=== band stack (PHP twin: golden [F]) ===');
ok(sec && sec.atts.padding_top && sec.atts.padding_top.base === 'pt-[0px]', 'computed padding-top 0 → explicit pt-[0px]');
const stack = find(sec, (n) => n.type === 'flexbox' && n.atts.direction && n.atts.direction.base === 'column' && (n._items || []).length === 3);
ok(!!stack, 'stack → ONE flexbox column of three bands');
ok(stack && stack.atts.gap && stack.atts.gap.base === '[22px]', 'stack gap = the source 22px');
ok(stack && stack.atts.spacing && stack.atts.spacing.margin.top === 'mt-[120px]', 'stack margin-top = the source 120px');
const b0 = stack && stack._items[0];
ok(b0 && b0.atts.display === 'grid' && b0.atts.grid_columns === '0.8fr 1.2fr', 'band → native Grid with the source tracks (0.8fr 1.2fr)');
ok(b0 && b0.atts._box && b0.atts._box.radius === '38px' && b0.atts._box.clip === true, 'band row wears its card skin (radius 38, clipped — a panel reaches the edge)');
ok(b0 && b0.atts.min_height && b0.atts.min_height.base.value === '300', 'band min-height 300');
const panel = b0 && b0._items[0], copy = b0 && b0._items[1];
ok(panel && panel.type === 'flexbox' && !(panel._items || []).length, 'painted EMPTY panel → an empty cell (not dropped)');
ok(panel && /selector\{background-image:radial-gradient\(circle at 25% 30%/.test(panel.atts.custom_css || ''), "panel carries the source's multi-layer paint as its background-image");
ok(copy && copy.atts.direction && copy.atts.direction.base === 'column' && copy.atts.justify_content && copy.atts.justify_content.base === 'between', 'copy cell = flex column, justify space-between');
const sh = copy && find(copy, (n) => n.shortcode === 'special_heading');
ok(sh && sh.atts.overline === 'Golden-ratio cultivation' && sh.atts.title === 'Organic planting geometry' && /Crop spacing/.test(sh.atts.subtitle || ''), 'label → h3 → p fold into ONE special heading');
ok(sh && sh.atts.heading === 'h3', 'h3 keeps its tag');
ok(copy && (copy._items || []).filter((n) => n.shortcode === 'special_heading').length === 1, 'exactly one heading in the copy cell');

console.log(fails ? `\n✗ ${fails} FAIL` : '\n✓ ALL PASS — band stack parity guarded');
process.exit(fails ? 1 : 0);
