// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// THE UTILITY-CLASS PROBE parity (browser-free; 2026-09-12). A page built from generated utility classes is reproduced
// from MEASUREMENTS, never class names: capture-extract reads a brand-filled card's inherited ink (titleInk / bodyInk vs
// the page ink), the card's hover ink + a child's own / GROUP hover (hoverGroupOf), the title / description tracking /
// case / truncate (textLongTailOf), their 390 / 820 font sizes (titleFs*/bodyFs*), a cell hidden per tier (hide), the
// grid's measured track counts + a cell's own tablet fraction (tracksMd / fracMd), a card image's own box + radius
// (imgExtraOf), an arbitrary shadow behind Tailwind's transparent placeholders (shadowLayersOf) and a thin accent-bar
// pseudo (decorPseudosOf above) — and to-pages / box-presets carry each one.
// PHP twin: tests/golden-fixture-1-test.php [U].   Run: node utility-probe-parity.test.mjs   (exit 1 on any failure)
import { toPages } from './to-pages.mjs';
import { buildBorderPresets } from './box-presets.mjs';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + msg); if (!cond) fails++; };

const box = (o = {}) => ({ bg: 'rgb(255, 255, 255)', fill: 'rgb(255, 255, 255)', gradient: '', radius: '24px', borderWidth: '1px', borderStyle: 'solid', borderColor: 'rgba(38, 33, 28, 0.1)', shadow: '', backdrop: '', padding: '40px', clip: false, extra: '', hover: null, hoverLift: false, ...o });
const card = (title, o = {}) => ({ icon: '', customIcon: '', lucide: '', iconLayout: 'inline-left', iconColor: '', title, titleTag: 'h2', text: '<p>Body copy for the ' + title.toLowerCase() + ' that runs a little long.</p>', link: null, center: false, box: box(o.box), titleExtra: o.titleExtra || '', bodyExtra: o.bodyExtra || '', bodyColor: '', bodyLinkSkin: '', decor: o.decor || [], image: o.image || null, ...o });
const cell = (id, c, extra = {}) => ({ width: '1_3', cls: '', fullCls: 'card', colId: id, cw: 4, track: 437, html: '<div class="card">…</div>', card: c, ...extra });
const cells = [
  // a plain card with an arbitrary shadow behind two transparent placeholder layers, a hover fill + hover INK, a 4px accent bar, spanning the whole tablet row
  cell('c1', card('Brand card', { box: { shadow: 'rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.08) 0px 20px 40px 0px', hover: { fill: 'rgb(47, 111, 78)', color: 'rgb(255 255 255)' } }, titleInherits: true, bodyInherits: true, decor: [{ pe: 'before', top: '0%', left: '10%', width: '80%', height: '4px', above: true, background: 'rgb(201, 139, 62)' }] }), { fracMd: 1 }),
  // a brand-filled card whose title / description inherit WHITE (differs from the page ink)
  cell('c2', card('Inverse card', { box: { bg: 'rgb(47, 111, 78)', fill: 'rgb(47, 111, 78)' }, titleInk: 'rgb(255, 255, 255)', bodyInk: 'rgb(255, 255, 255)' })),
  // a group-hover title, an uppercase tracked truncating description with phone / tablet sizes, hidden from 820px up
  cell('c3', card('Grouped card', { titleHover: 'color:rgb(47 111 78);text-decoration-line:underline', bodyExtra: 'white-space:nowrap;letter-spacing:2.6px;text-transform:uppercase;text-overflow:ellipsis;overflow:hidden', titleFsSm: '22px', bodyFsSm: '16px', bodyLhSm: '24px', bodyFsMd: '18px', bodyLhMd: '28px' }), { hide: { 'hide-xs': false, 'hide-sm': false, 'hide-md': true, 'hide-lg': true } }),
  // an avatar card: a 64px round image (its own box + radius)
  cell('c4', card('Avatar card', { image: { src: 'http://x/b.png', alt: '', extra: 'border-radius:9999px;width:64px;height:64px;flex:0 0 auto' } })),
];
const row = { t: 'row', valign: '', gap: 28, gapResp: null, html: '<div class="grid">…</div>', mt: 0, mb: 0, tracks: '437px 437px 437px', tracksMd: 2, tracksSm: 1, cols: cells };
const cap = { url: 'http://x/', sections: [{ sectionClass: 'cards', computed: { padding: '120px 0px', margin: '0px' }, blocks: [row] }] };
const out = toPages(cap, { hifiCss: true });
const secs = out.pages[0].builder.filter((n) => n.type === 'section');
const find = (n, pred) => { if (!n || typeof n !== 'object') return null; if (pred(n)) return n; for (const c of (n._items || [])) { const r = find(c, pred); if (r) return r; } return null; };
const css = (n) => (n && n.atts && n.atts.custom_css) || '';
const ib = (t) => find(secs[0], (n) => n.shortcode === 'icon_box' && (n.atts.title || '') === t);
const titles = ['Brand card', 'Inverse card', 'Grouped card', 'Avatar card'];
const cellOf = (t) => find(secs[0], (n) => n.type === 'flexbox' && titles.filter((x) => JSON.stringify(n).includes(x)).length === 1 && JSON.stringify(n).includes(t));

console.log('\n=== the utility-class probe (PHP twin: golden [U]) ===');
const brand = ib('Brand card'), inv = ib('Inverse card'), grp = ib('Grouped card'), av = ib('Avatar card');
ok(brand && inv && grp && av, 'four cards → four icon_boxes');
const skins = cells.map((c) => c.card.box);
const bp = buildBorderPresets(skins);
const pFor = (i) => bp.presets.find((p) => 'boxp-' + p.preset_name.toLowerCase().replace(/[^a-z0-9]+/g, '-') === bp.boxpFor(skins[i]));
ok(pFor(0) && JSON.stringify(pFor(0).states).includes('"y":20,"blur":40') && JSON.stringify(pFor(0).states).includes('rgba(0, 0, 0, 0.08)'), "a shadow behind Tailwind's transparent ring placeholders is a real shadow (the preset's Box Shadow)");
ok(pFor(0) && JSON.stringify(pFor(0).states.hover || {}).includes('rgb(47, 111, 78)'), "the card's hover FILL reaches the preset");
ok(brand && /selector:hover \.icon-box__title\{[^}]*color:rgb\(255 255 255\)/.test(css(brand)) && /selector:hover \.icon-box__content\{[^}]*color:rgb\(255 255 255\)/.test(css(brand)), "the card's hover ink (hover:text-white) → the title / description follow it on hover");
ok(brand && /::before\{[^}]*z-index:1[^}]*height:4px[^}]*background:rgb\(201, 139, 62\)/.test(css(brand)), 'a 4px accent bar (a thin ::before) rides the card as a scoped pseudo ABOVE the fill, px-thin');
ok(inv && inv.atts.title_color && /^(#ffffff|rgb\(255, 255, 255\))$/.test(inv.atts.title_color.custom || ''), "a brand-filled card's inherited WHITE title → the native Title Colour");
ok(inv && inv.atts.content_color && /^(#ffffff|rgb\(255, 255, 255\))$/.test(inv.atts.content_color.custom || ''), '…and its description → the native Content Colour');
ok(brand && !(brand.atts.title_color && brand.atts.title_color.custom), 'a plain white card keeps the theme defaults (no Title Colour)');
ok(grp && /selector:hover \.icon-box__title\{[^}]*color:rgb\(47 111 78\)[^}]*text-decoration-line:underline/.test(css(grp)), 'a group-hover title (colour + underline when the CARD is hovered) → selector:hover .icon-box__title');
ok(grp && /\.icon-box__content\{[^}]*letter-spacing:2\.6px[^}]*text-transform:uppercase[^}]*text-overflow:ellipsis[^}]*overflow:hidden/.test(css(grp)), 'an uppercase, tracked, truncating description → .icon-box__content');
ok(grp && css(grp).includes('@media (max-width:767px){selector .icon-box__content{font-size:16px;line-height:24px !important;}}') && css(grp).includes('@media (min-width:768px) and (max-width:991px){selector .icon-box__content{font-size:18px;line-height:28px !important;}}'), "the description's measured PHONE size → a max-width:767px rule; the TABLET size → a 768–991px rule");
ok(grp && css(grp).includes('@media (max-width:767px){selector .icon-box__title{font-size:22px !important;}}'), "the title's phone size → its own max-width:767px rule");
const gcell = cellOf('Grouped card'), bcell = cellOf('Brand card'), icell = cellOf('Inverse card');
ok(gcell && gcell.atts.responsive_hide && gcell.atts.responsive_hide['hide-md'] && gcell.atts.responsive_hide['hide-lg'] && !gcell.atts.responsive_hide['hide-xs'], 'a card hidden from 820px up (md:hidden) → Responsive Hide on tablets + desktops, shown on phones');
ok(icell && icell.atts.width && icell.atts.width.md && icell.atts.width.md.preset === '6', "a two-track tablet grid (measured) → a plain card's tablet width is 6/12");
ok(bcell && bcell.atts.width && bcell.atts.width.md && bcell.atts.width.md.preset === '12', '…while the md:col-span-2 card (fraction 1 at 820px) spans the whole row on tablets');
ok(icell && icell.atts.width && icell.atts.width.base && icell.atts.width.base.preset === '12', '…and every card is full-width on phones (one measured track at 390px)');
ok(av && /selector \.icon-box__image img, selector img\{[^}]*border-radius:9999px;width:64px;height:64px/.test(css(av)), "a 64px round avatar inside a card keeps its own box + radius on the image");

// ===== batch 2: child rhythm, a side-by-side card, empty painted boxes, the WIDE tier, a layout-centred card, a field's :focus skin (PHP twin: golden [U2])
console.log('\n=== the utility-class probe, batch 2 (PHP twin: golden [U2]) ===');
const cells2 = [
  cell('d1', card('Rhythm card', { bodyRhythm: 'margin-top:16px;border-top:1px solid rgb(201, 139, 62);padding-top:12px' })),
  cell('d2', card('Row card', { cardRow: { gap: 16, titleLast: true, from: 'md' } })),
  cell('d3', card('Decor card', { decorBoxes: [{ n: 1, css: 'background-color:rgb(223, 214, 200);aspect-ratio:4 / 3;border-radius:12px', before: true }, { n: 2, css: "background-image:url(\"data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Ccircle cx='20' cy='20' r='6' fill='%232f6f4e'/%3E%3C/svg%3E\");background-size:40px 40px;height:160px;border-radius:12px", before: false }], text: '<div class="sc-deco-1"></div><p>A 4:3 box and a pattern tile.</p><div class="sc-deco-2"></div>', padXl: '56px', bodyFsXl: '18px', bodyLhXl: '28px' })),
  cell('d4', card('Centred card', { align: 'center' })),
];
const row2 = { t: 'row', valign: '', gap: 28, gapResp: null, html: '<div class="grid">…</div>', mt: 0, mb: 0, cols: cells2 };
const nl2 = { t: 'newsletter', role: 'newsletter', placeholder: 'Your email', name_placeholder: '', show_name: false, button_label: 'Subscribe', align: '', rounded: 'md', design: 'inline', gap: 12, button_bg: 'rgb(47, 111, 78)', button_fg: 'rgb(255, 255, 255)', fieldFocus: 'box-shadow:0 0 0 2px rgb(47, 111, 78);outline:none' };
const cap2 = { url: 'http://x/', sections: [{ sectionClass: 'cards', computed: { padding: '120px 0px', margin: '0px' }, computedXl: { padding: '160px 0px', margin: '0px' }, blocks: [row2] }, { sectionClass: 'signup', computed: { padding: '96px 0px', margin: '0px' }, blocks: [nl2] }] };
const out2 = toPages(cap2, { hifiCss: true });
const secs2 = out2.pages[0].builder.filter((n) => n.type === 'section');
const ib2 = (t) => find(secs2[0], (n) => n.shortcode === 'icon_box' && (n.atts.title || '') === t);
const rh = ib2('Rhythm card'), rw = ib2('Row card'), dc = ib2('Decor card'), ce = ib2('Centred card'), nln = find(secs2[1], (n) => n.shortcode === 'newsletter');
ok(rh && rw && dc && ce && nln, 'four cards → icon_boxes; the signup → a newsletter');
ok(rh && css(rh).includes('selector .icon-box__content p + p{margin-top:16px;border-top:1px solid rgb(201, 139, 62);padding-top:12px !important;}'), "the second paragraph's measured rhythm → .icon-box__content p + p");
ok(rw && /@media \(min-width:768px\)\{selector \.icon-box__inner\{display:flex;flex-direction:row;align-items:flex-start;gap:16px;\}selector \.icon-box__head,selector \.icon-box__inner>\.icon-box__title\{flex:0 0 auto;order:2;\}/.test(css(rw)), 'a side-by-side card → the icon_box inner is a row from 768px, the title LAST');
ok(dc && String(dc.atts.content || '').indexOf('sc-deco-1') < String(dc.atts.content || '').indexOf('A 4:3 box') && /\.icon-box__content \.sc-deco-1\{display:block;width:100%;background-color:rgb\(223, 214, 200\);aspect-ratio:4 \/ 3;border-radius:12px;\}/.test(css(dc)), 'an empty 4:3 painted box → a class hook in the description (before the paragraph) + its paint / ratio in scoped CSS');
ok(dc && /\.sc-deco-2\{[^}]*background-image:url\("data:image\/svg\+xml;utf8,%3Csvg[^}]*background-size:40px 40px[^}]*height:160px/.test(css(dc)), 'a pattern tile (an inline-SVG data URL, tags percent-encoded) → its own hook');
ok(dc && css(dc).includes('@media (min-width:1536px){selector{padding:56px !important;}}') && css(dc).includes('@media (min-width:1536px){selector .icon-box__content{font-size:18px;line-height:28px !important;}}'), "the WIDE pass: the card's >= 1536px inset + the description's wide size → min-width:1536px rules");
ok(secs2[0] && String(secs2[0].atts.custom_css || '').includes('@media (min-width:1536px){selector{padding-top:160px !important;padding-bottom:160px !important;}}'), "…and the section's >= 1536px padding → a min-width:1536px rule on the section");
ok(ce && ce.atts.title_align === 'center', 'a layout-centred card → the icon_box aligns centre');
ok(nln && css(nln).includes('selector .fw-nl__input:focus{box-shadow:0 0 0 2px rgb(47, 111, 78);outline:none !important;}'), "a form field's resolved :focus ring → the newsletter input's :focus");

console.log(fails ? `\n✗ ${fails} FAIL` : '\n✓ ALL PASS — utility-class probe parity guarded');
process.exit(fails ? 1 : 0);
