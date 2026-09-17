// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// THE PHONE PASS parity (browser-free; second viewport, first cut). capture.mjs renders the page at 390px too and
// capture-extract carries only what DIFFERS: a section's phone padding / margin (computedSm), a paragraph's / heading's
// phone font-size (fontSizeSm), a panel's / row's phone padding tier (pad.base = phone, pad.lg = desktop), a cell's phone
// min-height (minHSm), plus the page flag (phonePass). to-pages must map them: section padding BASE tier = the measured
// phone value with desktop on lg — and, when the pass ran and found no difference, the EXACT desktop value with no
// 112px clamp; a phone font-size → a max-width:767px rule; a pad record's lg tier → a min-width:992px rule; a cell's
// phone minimum (or none) → the Min Height base tier; a cover-fill image only fills beside its text (min-width:992px).
// PHP twin: tests/golden-fixture-1-test.php [V].   Run: node phone-pass-parity.test.mjs   (exit 1 on any failure)
import { toPages } from './to-pages.mjs';
import { toThemeSettings } from './to-theme-settings.mjs';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + msg); if (!cond) fails++; };

const head = { t: 'heading', level: 2, html: 'Designed to breathe', text: 'Designed to breathe', tag: 'h2', cls: '', wrapCls: '', fontSize: '44px', fontWeight: '400', color: 'rgb(38, 33, 28)', lineHeight: '48px', letterSpacing: 'normal', textAlign: '', marginTop: '0px', marginBottom: '12px', fontSizeSm: '32px', lineHeightSm: '36px' };
const para = { t: 'text', html: '<p>The landscape follows the natural movement of the valley.</p>', text: 'The landscape follows the natural movement of the valley.', tag: 'p', cls: '', fontSize: '18px', color: 'rgb(38, 33, 28)', lineHeight: '30px', fontWeight: '400', textAlign: '', textTransform: 'none', letterSpacing: 'normal', marginTop: '0px', marginBottom: '0px', fontSizeSm: '15px', lineHeightSm: '26px' };
const panel = { t: 'panel', box: { bg: 'rgb(255, 255, 255)', fill: 'rgb(255, 255, 255)', gradient: '', radius: '28px', borderWidth: '', borderStyle: '', borderColor: '', shadow: '', backdrop: '' }, pad: { base: { top: 28, right: 28, bottom: 28, left: 28 }, lg: { top: 70, right: 70, bottom: 70, left: 70 } }, width: '', maxw: '', aspect: '', align: '', selfCenter: false, centerH: false, centerV: false, shell: false, decor: [], mt: 0, mb: 0, blocks: [head, para] };
const row = { t: 'row', valign: '', gap: 28, gapResp: null, html: '<div class="grid">…</div>', mt: 0, mb: 0, tracks: '736px 627px', tracksMd: 1, tracksSm: 1, cols: [
  { width: '1_2', cls: '', fullCls: 'left', colId: 'c1', cw: 6, track: 736, html: '<div>…</div>', minH: 640, minHSm: 0, blocks: [head, para] },
  { width: '1_2', cls: '', fullCls: 'right', colId: 'c2', cw: 6, track: 627, html: '<img>', minH: 640, minHSm: 0, blocks: [{ t: 'image', src: 'http://x/a.png', alt: '', radius: '', shadow: '', fill: true }] },
] };
const cap = { url: 'http://x/', phonePass: true, sections: [
  { sectionClass: 'story', computed: { padding: '160px 0px', margin: '0px' }, computedSm: { padding: '64px 0px', margin: '0px' }, computedMd: { padding: '96px 0px', margin: '0px' }, blocks: [row] },
  { sectionClass: 'same',  computed: { padding: '160px 0px', margin: '0px' }, blocks: [panel, { ...para, html: '<p>Golden fields · Harvest 12</p>', text: 'Golden fields · Harvest 12', hideSm: true, fontSizeSm: '', lineHeightSm: '' }] },
] };
const out = toPages(cap, { hifiCss: true });
const secs = out.pages[0].builder.filter((n) => n.type === 'section');
const find = (n, pred) => { if (!n || typeof n !== 'object') return null; if (pred(n)) return n; for (const c of (n._items || [])) { const r = find(c, pred); if (r) return r; } return null; };
const css = (n) => (n && n.atts && n.atts.custom_css) || '';

console.log('\n=== the phone pass (PHP twin: golden [V]) ===');
ok(secs[0].atts.padding_top && secs[0].atts.padding_top.base === 'pt-7' && secs[0].atts.padding_top.lg === 'pt-[160px]', "story: the section's phone rhythm (64px) is the BASE tier, desktop 160px rides lg");
ok(secs[1].atts.padding_top && secs[1].atts.padding_top.base === 'pt-[160px]' && !secs[1].atts.padding_top.lg, 'same: the pass found no phone difference → the exact desktop value is the base (no 112px clamp)');
ok(secs[0].atts.padding_top && secs[0].atts.padding_top.md === 'pt-10', 'story: the TABLET pass (96px at 820px) is the md tier');
const band = (secs[0]._items || []).find((n) => n.type === 'flexbox');
ok(band && /@media \(min-width:768px\) and \(max-width:991px\)\{selector\{grid-template-columns:1fr !important;\}/.test(css(band)), "story: ONE grid track at 820px → a 768–991px rule stacks the band");
const tsg = toThemeSettings({ colors: { bg: '#fff', ink: '#000' } }, { contentGutter: 24, contentGutterSm: 16, contentWidth: 1440 });
ok(tsg && /@media \(max-width:767px\)\{:root\{--container-gutter:16px !important;\}\}/.test(String(tsg.values.misc_custom_css && tsg.values.misc_custom_css.custom_css || '')), 'container: the phone gutter (16px) rides a max-width:767px --container-gutter override');
const cells = [];
(function walk(n) { if (!n) return; if (n.type === 'flexbox' && n.atts.min_height && n.atts.min_height.lg && n.atts.min_height.lg.value) cells.push(n); for (const c of (n._items || [])) walk(c); })(secs[0]);
ok(cells.length >= 2 && cells[0].atts.min_height.base.value === '' && cells[0].atts.min_height.lg.value === '640', 'cells: the desktop 640px minimum rides lg and the phone has NONE');
const h2 = find(secs[0], (n) => n.shortcode === 'special_heading');
ok(h2 && /@media \(max-width:767px\)\{selector \.heading-title\{font-size:32px !important;line-height:36px !important;\}\}/.test(css(h2)), "heading: the phone size (32px / 36px) rides a max-width:767px rule");
const tb = find(secs[1], (n) => n.shortcode === 'text_block') || find(secs[0], (n) => n.shortcode === 'text_block');
ok((tb && /@media \(max-width:767px\)\{selector,selector p\{font-size:15px !important;line-height:26px !important;\}\}/.test(css(tb))) || (h2 && /@media \(max-width:767px\)\{selector \.heading-subtitle\{font-size:15px !important;line-height:26px !important;\}\}/.test(css(h2))), "paragraph (folded into the subtitle here): the phone size (15px / 26px) rides a max-width:767px rule");
const pn = find(secs[1], (n) => n.type === 'flexbox' && /padding-top:28px/.test(css(n)));
ok(pn && /@media \(min-width:992px\)\{selector\{padding-top:70px;padding-right:70px;padding-bottom:70px;padding-left:70px;\}\}/.test(css(pn)), "panel: the phone padding (28px) is the base rule and the desktop 70px rides a min-width:992px rule");
const mi = find(secs[0], (n) => n.shortcode === 'media_image');
ok(mi && /@media \(min-width:992px\)\{selector\{flex:1 1 auto[^}]*\}selector img\{[^}]*object-fit:cover/.test(css(mi)), 'image: the cover-fill rides a min-width:992px rule (natural height when stacked on a phone)');

const chip = find(secs[1], (n) => n.shortcode === 'text_block' && /Golden fields/.test(n.atts.text || ''));
ok(chip && chip.atts.responsive_hide && chip.atts.responsive_hide['hide-xs'] && chip.atts.responsive_hide['hide-sm'] && !chip.atts.responsive_hide['hide-md'], 'chip: display:none at 390px → the native Responsive Hide (mobile + tablet), visible on desktop');

console.log(fails ? `\n✗ ${fails} FAIL` : '\n✓ ALL PASS — phone-pass parity guarded');
process.exit(fails ? 1 : 0);
