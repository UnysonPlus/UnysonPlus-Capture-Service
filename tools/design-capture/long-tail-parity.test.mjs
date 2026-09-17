// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// THE CSS LONG TAIL parity (browser-free; the coverage audit of 2026-09-12). capture-extract now reads the properties that
// were invisible before (boxExtraOf / imgExtraOf / textLongTailOf / boxHoverOf / cell placement) and to-pages + box-presets
// must carry them: a card's box-level props (opacity / accent border / outline / inset multi-shadow / sticky) → its Box
// Preset CSS, KEYED so an opacity card and a plain card are different presets; a lift-only hover keys the preset and
// becomes the native Lift; a 4-value padding shorthand survives; color(srgb …) resolves; the title / description text
// long tail → .icon-box__title / __content (icon cards) or .heading-title / .heading-subtitle (text cards); an image's
// filter / object-position → its <img>; a cell's order / align-self → native options.
// PHP twin: tests/golden-fixture-1-test.php [T].   Run: node long-tail-parity.test.mjs   (exit 1 on any failure)
import { toPages } from './to-pages.mjs';
import { buildBorderPresets } from './box-presets.mjs';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + msg); if (!cond) fails++; };

const box = (o = {}) => ({ bg: 'rgb(255, 255, 255)', fill: 'rgb(255, 255, 255)', gradient: '', radius: '24px', borderWidth: '1px', borderStyle: 'solid', borderColor: 'rgba(95, 73, 42, 0.12)', shadow: '', backdrop: '', padding: '40px 32px', clip: false, extra: '', hover: null, hoverLift: false, ...o });
const card = (title, o = {}) => ({ icon: '', customIcon: '', lucide: '', iconLayout: 'inline-left', iconColor: '', title, titleTag: 'h2', text: '<p>Body copy for the ' + title.toLowerCase() + '.</p>', link: null, center: false, box: box(o.box), titleExtra: o.titleExtra || '', bodyExtra: o.bodyExtra || '', bodyColor: o.bodyColor || '', bodyLinkSkin: o.bodyLinkSkin || '', decor: [], image: o.image || null });
const cell = (id, c, extra = {}) => ({ width: '1_3', cls: '', fullCls: 'card', colId: id, cw: 4, track: 437, html: '<div class="card">…</div>', card: c, ...extra });
const cells = [
  cell('c1', card('Plain card', { box: { padding: '24px 56px' } })),
  cell('c2', card('Faded card', { box: { extra: 'opacity:0.72' } })),
  cell('c3', card('Accent card', { box: { extra: 'outline:3px dashed rgb(201, 139, 62);outline-offset:6px;border-left:6px solid rgb(47, 111, 78)' } })),
  cell('c4', card('Shadowed card', { box: { shadow: 'rgba(47, 111, 78, 0.25) 0px 0px 0px 4px inset, rgba(0, 0, 0, 0.08) 0px 20px 40px 0px' } })),
  cell('c5', card('Mixed card', { box: { bg: 'color(srgb 0.902118 0.932235 0.916706)', fill: 'color(srgb 0.902118 0.932235 0.916706)' } })),
  cell('c6', card('Lifting card', { box: { hover: { lift: true } } })),
  cell('c8', card('Linked card', { bodyColor: 'rgb(120, 120, 120)', bodyLinkSkin: 'color:rgb(47, 111, 78);text-decoration-line:underline;text-decoration-thickness:2px;text-underline-offset:6px;text-decoration-color:rgb(201, 139, 62)' })),
  cell('c7', card('Typed card', { titleExtra: 'text-shadow:rgba(0, 0, 0, 0.25) 0px 2px 12px;font-style:italic', bodyExtra: '-webkit-line-clamp:2;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-line' }), { order: -1, alignSelf: 'end' }),
];
const row = { t: 'row', valign: '', gap: 28, gapResp: null, html: '<div class="grid">…</div>', mt: 0, mb: 0, cols: cells };
const imgRow = { t: 'row', valign: '', gap: 28, gapResp: null, html: '<div>…</div>', mt: 0, mb: 0, cols: [
  { width: '1_2', cls: '', fullCls: '', colId: 'i1', cw: 6, html: '<img>', blocks: [{ t: 'image', src: 'http://x/a.png', alt: '', radius: '24px', shadow: '', borderWidth: '4px', borderStyle: 'solid', borderColor: 'rgb(255, 255, 255)', outline: '2px dashed rgb(47, 111, 78);outline-offset:4px', extra: 'filter:grayscale(1) contrast(1.1);object-position:20% 80%' }] },
  { width: '1_2', cls: '', fullCls: '', colId: 'i2', cw: 6, html: '<h2>…</h2>', text: { overline: '', overlineClass: '', overlineIcon: '', overlineIconPos: 'before', title: 'Text card', titleTag: 'h2', titleClass: '', subtitle: 'A subtitle', subtitleClass: '', titleLongTail: 'text-wrap:balance;-webkit-text-stroke-width:1px;-webkit-text-stroke-color:rgb(47, 111, 78)', subtitleLongTail: 'font-style:italic;text-indent:2em', wrapClass: '', paras: [] } },
] };
const cap = { url: 'http://x/', sections: [{ sectionClass: 'cards', computed: { padding: '120px 0px', margin: '0px' }, blocks: [row] }, { sectionClass: 'media', computed: { padding: '120px 0px', margin: '0px' }, blocks: [imgRow] }] };
const out = toPages(cap, { hifiCss: true });
const secs = out.pages[0].builder.filter((n) => n.type === 'section');
const find = (n, pred) => { if (!n || typeof n !== 'object') return null; if (pred(n)) return n; for (const c of (n._items || [])) { const r = find(c, pred); if (r) return r; } return null; };
const css = (n) => (n && n.atts && n.atts.custom_css) || '';
const ib = (t) => find(secs[0], (n) => n.shortcode === 'icon_box' && (n.atts.title || '') === t);
const cellOf = (t) => find(secs[0], (n) => n.type === 'flexbox' && JSON.stringify(n).includes(t) && !JSON.stringify(n).includes('Plain card' === t ? 'Faded card' : 'Plain card'));

console.log('\n=== the CSS long tail (PHP twin: golden [T]) ===');
ok(['Plain card', 'Faded card', 'Accent card', 'Shadowed card', 'Mixed card', 'Lifting card', 'Typed card', 'Linked card'].every((t) => ib(t)), 'eight cards → eight icon_boxes');
// Box presets: cluster the cells' skins the way capture.mjs does and check the keys + CSS
const skins = cells.map((c) => c.card.box);
const bp = buildBorderPresets(skins);
const pFor = (i) => bp.presets.find((p) => 'boxp-' + p.preset_name.toLowerCase().replace(/[^a-z0-9]+/g, '-') === bp.boxpFor(skins[i]));
ok(pFor(0) && /padding:24px 56px;/.test(pFor(0).custom_css), 'a 4-value padding shorthand survives whole in the preset CSS');
ok(pFor(1) && pFor(1) !== pFor(0) && /opacity:0\.72/.test(pFor(1).custom_css), 'opacity keys its OWN preset and rides the preset CSS');
ok(pFor(2) && /border-left:6px solid rgb\(47, 111, 78\)/.test(pFor(2).custom_css) && /outline:3px dashed/.test(pFor(2).custom_css), 'a left accent bar + a dashed outline ride the preset CSS');
ok(pFor(3) && /box-shadow:[^}]*inset/.test(pFor(3).custom_css), 'an inset ring + drop shadow list keeps BOTH layers in the preset CSS');
ok(pFor(4) && JSON.stringify(pFor(4).states).includes('rgb(230, 238, 234)'), 'color(srgb …) (a color-mix() result) resolves to a real fill');
ok(pFor(5) && pFor(5) !== pFor(0) && (pFor(5).hover_animation === 'btnfx-lift' || (pFor(5).hover_fx || []).includes('lift')), 'a card that only LIFTS on hover keeps the lift (the hover keys the preset)');
const ty = ib('Typed card');
ok(ty && /\.icon-box__title\{[^}]*text-shadow[^}]*font-style:italic/.test(css(ty)), "the title's text-shadow + italic → .icon-box__title");
ok(ty && /\.icon-box__content\{[^}]*-webkit-line-clamp:2[^}]*white-space:pre-line/.test(css(ty)), "the description's line-clamp (+ companions) and white-space → .icon-box__content");
const tyCell = cellOf('Typed card');
ok(tyCell && tyCell.atts.order && tyCell.atts.order.base === '-1', "the cell's order:-1 → the native Order");
ok(tyCell && tyCell.atts.align_self && tyCell.atts.align_self.base === 'end', "the cell's align-self:end → the native Align Self");
const ln = ib('Linked card');
ok(ln && ln.atts.content_color && /^(#787878|rgb\(120, 120, 120\))$/.test(ln.atts.content_color.custom || ''), "the description's own (muted) ink → the native Content Colour");
ok(ln && /\.icon-box__content a\{[^}]*color:rgb\(47, 111, 78\)[^}]*text-decoration-thickness:2px[^}]*text-underline-offset:6px/.test(css(ln)), "the description's inline link keeps its colour + underline metrics");
const mi = find(secs[1], (n) => n.shortcode === 'media_image');
ok(mi && /selector img\{[^}]*filter:grayscale\(1\) contrast\(1\.1\)[^}]*object-position:20% 80%/.test(css(mi)), "an image's filter + object-position → its <img>");
ok(mi && /selector img\{[^}]*border-radius:24px[^}]*border:4px solid rgb\(255, 255, 255\)[^}]*outline:2px dashed rgb\(47, 111, 78\);outline-offset:4px/.test(css(mi)), "a ROUNDED / framed / outlined image stays a NATIVE media_image (radius + border + outline on its <img>), not a verbatim block");
const th = find(secs[1], (n) => n.shortcode === 'special_heading' && /Text card/.test(n.atts.title || ''));
ok(th && /\.heading-title\{[^}]*text-wrap:balance[^}]*-webkit-text-stroke-width:1px/.test(css(th)) && /\.heading-subtitle\{[^}]*font-style:italic[^}]*text-indent:2em/.test(css(th)), "a text card's title / subtitle long tail → .heading-title / .heading-subtitle");

console.log(fails ? `\n✗ ${fails} FAIL` : '\n✓ ALL PASS — CSS long-tail parity guarded');
process.exit(fails ? 1 : 0);
