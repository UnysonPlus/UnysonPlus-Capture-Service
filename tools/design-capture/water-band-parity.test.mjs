// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// WATER BAND parity (browser-free). A rounded SHELL panel (the site's container expression → fills the section; a radial
// glow OVER a linear wash; clipped; inner padding 82/84/42) holding a 1.1fr/.9fr grid row (gap 56, align-items:end) of a
// copy column (eyebrow → fluid h2 → p) and a stats column that IS a single-track stack (gap 16) of two glass stat panels,
// then a footer row: a one-sided hairline (an EDGE skin), margin-top 64, padding-top 26, space-between, a brand text leaf
// on the left and a row of three PLAIN tag spans (a chip row without a box) on the right. Rules: a shell-expression panel
// fills the section; a multi-layer fill rides verbatim in the preset CSS; a row keeps its justify / align / gap / margins /
// padding; a cell that is a stack carries its gap; an edge skin keeps its side; a stat value keeps its line-height and a
// zero bottom margin; a plain tag row is a chip row. PHP twin: tests/golden-fixture-1-test.php [S].
// Run: node water-band-parity.test.mjs   (exit 1 on any failure)
import { toPages } from './to-pages.mjs';
import { buildBorderPresets } from './box-presets.mjs';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + msg); if (!cond) fails++; };

const shellGrad = 'radial-gradient(circle at 18% 18%, rgba(255, 197, 114, 0.14), rgba(0, 0, 0, 0) 20%), linear-gradient(rgb(63, 88, 126) 0%, rgb(41, 55, 84) 100%)';
const glass = { bg: 'rgba(255, 255, 255, 0.1)', fill: 'rgba(255, 255, 255, 0.1)', gradient: '', radius: '28px', borderWidth: '1px', borderStyle: 'solid', borderColor: 'rgba(255, 255, 255, 0.12)', shadow: '', backdrop: 'blur(18px)', padding: '', clip: false };
const statCard = (lbl, val) => ({ t: 'panel', box: { ...glass }, pad: { base: { top: 26, right: 28, bottom: 26, left: 28 } }, width: '', maxw: '', aspect: '', align: '', selfCenter: false, centerH: false, centerV: false, shell: false, decor: [], mt: 0, mb: 0,
  blocks: [
    { t: 'overline', html: lbl, text: lbl, cls: 'section-label', pill: false, color: 'rgba(255, 255, 255, 0.6)', bg: 'rgba(0, 0, 0, 0)', borderW: '0px', borderColor: '', radius: '0px', padding: '0px', backdropFilter: '', textTransform: 'uppercase', fontSize: '10px', lineHeight: '15px', letterSpacing: '3px', fontWeight: '400', gap: 'normal', iconSvg: '', iconPos: 'before' },
    { t: 'heading', level: 3, html: val, text: val, tag: 'div', cls: 'value serif', wrapCls: '', fontSize: '42px', fontWeight: '400', color: 'rgb(255, 255, 255)', marginBottom: '0px', marginTop: '10px', lineHeight: '42px', letterSpacing: 'normal', align: 'left' },
  ] });
const textLeaf = (t, fs, lh) => ({ t: 'text', html: '<p>' + t + '</p>', text: t, tag: 'div', cls: '', fontSize: fs, color: 'rgba(255, 255, 255, 0.68)', lineHeight: lh, letterSpacing: 'normal', marginBottom: '0px', marginTop: '0px', textAlign: 'start', fontWeight: '400', bg: '', bgImage: '', border: '', borderRadius: '0px', boxShadow: '', padding: '0px', backdrop: '', position: 'static', maxWidth: 'none' });
const tag = (t) => ({ ...textLeaf(t, '10px', '15px'), tag: 'span', textTransform: 'uppercase', letterSpacing: '2.4px' });
const gridRow = { t: 'row', valign: 'end', gap: 56, gapResp: null, html: '<div class="footer-grid">…</div>', mt: 0, mb: 0, cols: [
  { width: '1_2', cls: '', fullCls: '', colId: 'sccol-1', cw: 7, track: 642.4, html: '<div>…</div>', blocks: [
    { t: 'overline', html: 'Still Water', text: 'Still Water', cls: 'section-label', pill: false, color: 'rgba(255, 255, 255, 0.6)', bg: 'rgba(0, 0, 0, 0)', borderW: '0px', borderColor: '', radius: '0px', padding: '0px', backdropFilter: '', textTransform: 'uppercase', fontSize: '10px', lineHeight: '15px', letterSpacing: '3px', fontWeight: '400', gap: 'normal', iconSvg: '', iconPos: 'before' },
    { t: 'heading', level: 2, html: 'Where the river ends, the system quiets.', text: 'Where the river ends, the system quiets.', tag: 'h2', cls: 'footer-title serif', wrapCls: '', fsDecl: 'clamp(3rem,5vw,5.2rem)', lhDecl: '.9', lsDecl: '-.06em', fontSize: '72px', fontWeight: '400', color: 'rgb(255, 255, 255)', marginBottom: '0px', marginTop: '0px', lineHeight: '64.8px', letterSpacing: '-4.32px', align: 'left' },
    { ...textLeaf('The final zone settles into a deep blue reflection, holding the entire landscape in a soft, suspended calm.', '16px', '32px'), tag: 'p', cls: 'footer-copy', marginTop: '18px', maxWidth: '720px', color: 'rgba(255, 255, 255, 0.76)' },
  ] },
  { width: '1_2', cls: '', fullCls: 'footer-stats', colId: 'sccol-2', cw: 5, track: 525.6, html: '<div class="footer-stats">…</div>', stackGap: 16,
    blocks: [{ t: 'stack', gap: '16px', mt: 0, mb: 0, items: [statCard('Water reserve', '84%'), statCard('Soil vitality', 'High')] }] },
] };
const footRow = { t: 'row', valign: '', gap: 20, gapResp: null, html: '<div class="footer-bottom">…</div>', justify: 'space-between', mt: 64, mb: 0, pad: { base: { top: 26, right: 0, bottom: 0, left: 0 } },
  rowBox: { bg: '', fill: '', gradient: '', radius: '', borderWidth: '1px', borderStyle: 'solid', borderColor: 'rgba(255, 255, 255, 0.12)', shadow: '', backdrop: '', padding: '', clip: false, sides: 'top' },
  cols: [
    { width: '1_2', cls: '', fullCls: '', colId: 'sccol-3', cw: 6, html: 'Autumn Flow · Regenerative Landscapes', blocks: [textLeaf('Autumn Flow · Regenerative Landscapes', '14px', '21px')] },
    { width: '1_2', cls: '', fullCls: 'tags', colId: 'sccol-4', cw: 6, html: '<span>Harvest</span>…', blocks: [{ t: 'chips', gap: '18px', align: '', mt: 0, mb: 0, items: [tag('Harvest'), tag('Water'), tag('Equilibrium')] }] },
  ] };
const shell = { t: 'panel', box: { bg: '', fill: '', gradient: shellGrad, radius: '48px', borderWidth: '', borderStyle: '', borderColor: '', shadow: 'rgba(20, 24, 34, 0.18) 0px 22px 60px 0px', backdrop: '', padding: '', clip: true },
  pad: { base: { top: 82, right: 84, bottom: 42, left: 84 } }, width: '', maxw: '', aspect: '', align: '', selfCenter: true, centerH: false, centerV: false, shell: true, decor: [], mt: 0, mb: 0, blocks: [gridRow, footRow] };
const cap = { url: 'http://x/', sections: [{ sectionClass: 'footer-water', computed: { padding: '0px 0px 96px', margin: '0px' }, blocks: [shell] }] };
const out = toPages(cap, { hifiCss: true });
const sec = out.pages[0].builder.find((n) => n.type === 'section');
const find = (n, pred) => { if (!n || typeof n !== 'object') return null; if (pred(n)) return n; for (const c of (n._items || [])) { const r = find(c, pred); if (r) return r; } return null; };
const all = (n, pred, acc = []) => { if (!n || typeof n !== 'object') return acc; if (pred(n)) acc.push(n); for (const c of (n._items || [])) all(c, pred, acc); return acc; };
const css = (n) => (n && n.atts && n.atts.custom_css) || '';

console.log('\n=== water band (PHP twin: golden [S]) ===');
const sh = find(sec, (n) => n.type === 'flexbox' && n.atts._box && n.atts._box.gradient === shellGrad);
ok(!!sh, 'shell → a flexbox column wearing its skin (the multi-layer fill)');
ok(sh && /selector\{padding-top:82px;padding-right:84px;padding-bottom:42px;padding-left:84px;\}/.test(css(sh)) && !/width:/.test(css(sh)), 'shell keeps its inner 82/84/42 padding and NO width (a shell expression fills the section container)');
const grid = sh && find(sh, (n) => n.type === 'flexbox' && n.atts.display === 'grid');
ok(grid && grid.atts.grid_columns === '1.1fr 0.9fr', 'grid row → native Grid with the source tracks (1.1fr 0.9fr)');
ok(grid && grid.atts.gap && /^(6|56px)$/.test(String(grid.atts.gap.base).replace(/[[]]/g, '')) && grid.atts.align_items && grid.atts.align_items.base === 'end', 'grid row keeps its 56px gap and bottom alignment');
const stats = grid && grid._items[1];
ok(stats && stats.atts.gap && /^(3|16px)/.test(String(stats.atts.gap.base).replace(/[[]]/g, '')) && stats.atts.direction && stats.atts.direction.base === 'column', 'stats cell (itself a stack) carries its 16px gap as the native Gap of a flex column');
const cards = all(sec, (n) => n.type === 'flexbox' && n.atts._box && n.atts._box.radius === '28px');
ok(cards.length === 2 && cards.every((c) => c.atts._box.backdrop === 'blur(18px)' && /padding-top:26px;padding-right:28px/.test(css(c))), 'two glass stat panels with blur + 26/28 padding');
const val = find(cards[0], (n) => n.shortcode === 'special_heading');
ok(val && val.atts.title === '84%' && /line-height:42px !important/.test(css(val)) && /heading-overline\{[^}]*margin-bottom:10px !important/.test(css(val)), 'stat value keeps its 42px line-height and the 10px label→value gap');
ok(val && val.atts.spacing && val.atts.spacing.margin.bottom === 'mb-0', 'stat value (no subtitle) keeps a ZERO outer bottom margin');
const foot = find(sh, (n) => n.type === 'flexbox' && n.atts.justify_content && n.atts.justify_content.base === 'between');
ok(!!foot, 'footer row → native justify space-between');
ok(foot && foot._items.every((c) => c.atts.width && c.atts.width.base.preset === 'none'), 'footer cells are content-sized (no 12-span width)');
ok(foot && foot.atts._box && foot.atts._box.sides === 'top' && foot.atts._box.borderWidth === '1px', 'footer row wears its EDGE skin (a one-sided hairline)');
ok(foot && /^mt-(7|[64px])$/.test(foot.atts.spacing.margin.top) && /padding-top:26px/.test(css(foot)), 'footer row keeps its 64px above and 26px top inset');
const chips = foot && find(foot, (n) => n.type === 'flexbox' && (n._items || []).length === 3 && n.atts.gap && n.atts.gap.base === '[18px]');
ok(chips && chips._items.every((n) => n.shortcode === 'text_block' && !n.atts.box_style), 'plain tag row → a chip row of three text blocks with the 18px gap and NO Box Preset');
const h2 = find(sec, (n) => n.shortcode === 'special_heading' && /Where the river/.test(n.atts.title || ''));
ok(h2 && /font-size:clamp\(3rem,5vw,5\.2rem\) !important;line-height:\.9 !important;letter-spacing:-\.06em !important/.test(css(h2)), 'fluid h2 keeps clamp() + relative metrics');
const bp = buildBorderPresets([sh.atts._box, foot.atts._box, cards[0].atts._box]).presets;
ok(bp.some((p) => p.border_sides === 'top'), "the edge skin's preset puts its border on the TOP side only");
ok(bp.some((p) => /\{\{SELECTOR\}\}\{background-image:radial-gradient\(circle at 18% 18%/.test(p.custom_css || '')), "the shell's multi-layer fill rides verbatim in its preset CSS");

console.log(fails ? `\n✗ ${fails} FAIL` : '\n✓ ALL PASS — water band parity guarded');
process.exit(fails ? 1 : 0);
