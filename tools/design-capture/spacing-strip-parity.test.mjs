// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// NO CLASS DROPPED — the spacing + strip batch (browser-free; 2026-09-12). A second source converted on a test site lost
// the heading GROUP wrapper's `mb-20` under a section heading, a "trusted by" strip's wrapper padding + its kicker's `mb-8`
// + the brand NAMES beside iconify marks, a hero column's `mt-12` landed on the CTA as a stray 48px, a card's icon CHIP
// rode the body as a stray `sc-deco-1`, and the header CTA wore the plan buttons' outline preset (one preset per role).
// The browser-side twins (capture-extract: wrapper margin + padding → mtAdd / mbAdd, the icon-chip decor gate, the icon
// strip + its labels, the buttons-only groupCls gate) are exercised by the corpus; what to-pages / to-theme-settings must
// guarantee from the capture record is guarded here.
// PHP twin: tests/golden-fixture-1-test.php [Q].   Run: node spacing-strip-parity.test.mjs   (exit 1 on any failure)
import { toPages } from './to-pages.mjs';
import { buildButtonPresets, toThemeSettings } from './to-theme-settings.mjs';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + msg); if (!cond) fails++; };
const find = (n, pred) => { if (!n || typeof n !== 'object') return null; if (pred(n)) return n; for (const c of (n._items || [])) { const r = find(c, pred); if (r) return r; } return null; };
const mg = (n) => (n && n.atts && n.atts.spacing && n.atts.spacing.margin) || {};

// (1) section → container → `text-center mb-20` heading group → h2 + p: the wrapper's mb lands on the LAST part (mbAdd)
const pricingBlocks = [
  { t: 'heading', tag: 'h2', level: 2, html: 'Equip your arsenal', text: 'Equip your arsenal', cls: 'text-5xl font-bold mb-6', align: 'center', color: 'rgb(255, 255, 255)', fontSize: '48px', fontWeight: '700', lineHeight: '48px', marginTop: '0px', marginBottom: '24px' },
  { t: 'text', html: '<p>Begin your journey for free, and unlock legendary powers as your story grows.</p>', text: 'Begin your journey for free, and unlock legendary powers as your story grows.', cls: 'text-slate-400 max-w-xl mx-auto text-lg', align: 'center', color: 'rgb(148, 163, 184)', fontSize: '18px', lineHeight: '28px', marginBottom: '0px', mbAdd: 80 },
];
// (2) the hero strip: an overline-only kicker (its own mb-8) + a logo_grid, both wearing the flattened wrapper's margin + padding
const heroBlocks = [
  { t: 'heading', tag: 'h1', level: 1, html: 'Breathe life into your worlds.', text: 'Breathe life into your worlds.', cls: 'text-8xl font-bold mb-6', align: 'center', fontSize: '96px', fontWeight: '700', lineHeight: '96px', marginTop: '0px', marginBottom: '24px', mtAdd: 48 },
  { t: 'text', html: '<p>Generate landscapes, weather and lighting for true storytelling.</p>', text: 'Generate landscapes, weather and lighting for true storytelling.', cls: 'text-xl mb-10 max-w-2xl', align: 'center', fontSize: '20px', lineHeight: '28px', marginBottom: '40px' },
  { t: 'button', label: 'Create Your Scene', href: 'http://x/#pricing', tag: 'a', cls: 'inline-flex items-center gap-2 px-8 py-4 bg-brand text-white rounded-full font-semibold text-lg', align: 'center', groupCls: '', pad: '16px 32px', fontSize: '18px', fontWeight: '600', bs: { bg: 'rgb(34, 197, 94)', fg: 'rgb(255, 255, 255)', bd: '', bds: 'none', bw: '0px' } },
  { t: 'overline', html: 'Trusted by visual creators at', text: 'Trusted by visual creators at', cls: 'text-xs font-semibold tracking-widest text-slate-300 uppercase mb-8', color: 'rgb(203, 213, 225)', textTransform: 'uppercase', fontSize: '12px', fontWeight: '600', lineHeight: '16px', letterSpacing: '1.2px', marginBottom: '32px', marginTop: '0px', mtAdd: 152 },
  { t: 'logo_grid', gap: '64', opacity: '0.7', grayscale: 'yes', iconSize: '24', item: { gap: 8, pad: '0px', fs: '20px', fw: '700', lh: '28px' }, mbAdd: 48, html: '<div>…</div>', logos: [
    { url: 'https://api.iconify.design/simple-icons/unrealengine.svg?height=32&color=%23ffffff', svg: '', name: 'Unreal Engine', label: true, link_url: '', link_target: '_blank' },
    { url: 'https://api.iconify.design/simple-icons/unity.svg?height=32&color=%23ffffff', svg: '', name: 'Unity', label: true, link_url: '', link_target: '_blank' },
    { url: 'https://api.iconify.design/simple-icons/blender.svg?height=32&color=%23ffffff', svg: '', name: 'Blender', label: true, link_url: '', link_target: '_blank' },
  ] },
];
const cap = { url: 'http://x/', sections: [
  { sectionClass: 'hero', computed: { padding: '80px 0px 0px', margin: '0px' }, blocks: heroBlocks },
  { sectionClass: 'pricing', id: 'pricing', computed: { padding: '128px 24px', margin: '0px' }, blocks: pricingBlocks },
] };
const out = toPages(cap, { hifiCss: true });
const secs = out.pages[0].builder.filter((n) => n.type === 'section');

console.log('\n=== NO CLASS DROPPED (PHP twin: golden [Q]) ===');
{
  const h = find(secs[1], (n) => n.shortcode === 'special_heading' && /Equip/.test(n.atts.title || ''));
  ok(h && String(h.atts.subtitle || '').trim() !== '', 'pricing: the heading group → ONE special_heading with the intro folded as its subtitle');
  ok(h && mg(h).bottom === 'mb-9', "…whose Spacing bottom IS the wrapper's mb-20 (80px → mb-9): the subtitle's mbAdd rides the head");
}
{
  const h1 = find(secs[0], (n) => n.shortcode === 'special_heading' && /Breathe/.test(n.atts.title || ''));
  ok(h1 && mg(h1).top === 'mt-5', "hero: the content column's mt-12 (48px, mtAdd on the FIRST block) → the heading's Spacing top");
  ok(h1 && /\.heading-title\{[^}]*margin-top:0px/.test(h1.atts.custom_css || ''), '…and the title asserts its own margin-top:0 (a captured zero is a value; the theme default must not double the gap)');
  const btn = find(secs[0], (n) => n.shortcode === 'button' && /Create/.test(n.atts.label || ''));
  ok(btn && !mg(btn).top, 'the hero CTA carries NO stray top margin (groupCls is empty for a column that holds more than buttons)');
  const cap2 = find(secs[0], (n) => n.shortcode === 'text_block' && /Trusted/.test(JSON.stringify(n.atts)));
  ok(cap2 && mg(cap2).top === 'mt-[152px]', "the kicker (an overline with no heading after it → a text block) wears the strip wrapper's margin + padding (56 + 96) as its Spacing top");
  ok(cap2 && /margin-bottom:32px/.test(cap2.atts.custom_css || ''), "…and its OWN mb-8 (32px) as its scoped margin-bottom");
  const lg = find(secs[0], (n) => n.shortcode === 'logo_grid');
  ok(lg && mg(lg).bottom === 'mb-5', "the wrapper's pb-12 (48px, mbAdd on the LAST block) → the logo_grid's Spacing bottom");
  ok(lg && lg.atts.show_labels === 'yes' && lg.atts.logos.length === 3 && lg.atts.logos[0].name === 'Unreal Engine', 'iconify brand marks beside VISIBLE names → show_labels yes, every name carried');
  ok(lg && lg.atts.logo_height === '24' && lg.atts.gap && /\.fw-lg__item\{gap:8px;padding:0px;\}/.test(lg.atts.custom_css || '') && /\.fw-lg__label\{font-size:20px;font-weight:700;line-height:28px;\}/.test(lg.atts.custom_css || ''), "the strip's mark size, measured gap, opacity, and the item's own gap / padding / label type");
}
{
  // (6) a role's SECOND distinct skin → "<Role> 2"; the header CTA colour-matches it, a semantic class keeps the winner
  const home = { buttonSkins: [
    { role: 'Outline', cls: 'block w-full py-3 rounded-xl border border-slate-700 text-center hover:bg-slate-800', bg: '', fg: 'rgb(255, 255, 255)', bd: 'rgb(51, 65, 85)', bw: '1px', fs: '16px', px: '0px', py: '12px', radius: '12px', hoverBg: 'rgb(30, 41, 59)' },
    { role: 'Outline', cls: 'block w-full py-3 rounded-xl border border-slate-700 text-center hover:bg-slate-800', bg: '', fg: 'rgb(255, 255, 255)', bd: 'rgb(51, 65, 85)', bw: '1px', fs: '16px', px: '0px', py: '12px', radius: '12px', hoverBg: 'rgb(30, 41, 59)' },
    { role: 'Outline', cls: 'px-5 py-2.5 rounded-full border border-white text-sm font-medium hover:bg-brand', bg: '', fg: 'rgb(248, 250, 252)', bd: 'rgb(255, 255, 255)', bw: '1px', fs: '14px', px: '20px', py: '10px', radius: '9999px', hoverBg: 'rgb(34, 197, 94)' },
    { role: 'Primary', cls: 'px-8 py-4 bg-brand text-white rounded-full', bg: 'rgb(34, 197, 94)', fg: 'rgb(255, 255, 255)', bd: '', bw: '', fs: '18px', px: '32px', py: '16px', radius: '9999px', hoverBg: '#86efac' },
  ] };
  const bp = buildButtonPresets(home);
  const names = (bp.button_colors || []).map((c) => c.color_name);
  ok(names.includes('Outline') && names.includes('Outline 2'), 'two DISTINCT outline skins → "Outline" (the common one) + "Outline 2"');
  const o2 = (bp.button_colors || []).find((c) => c.color_name === 'Outline 2');
  ok(o2 && o2.states.default.border_color.custom === 'rgb(255, 255, 255)' && o2.states.hover.bg_color.custom === 'rgb(34, 197, 94)', '…"Outline 2" keeps the white border + brand hover fill');
  const ts = toThemeSettings({ colors: { bg: '#020617', ink: '#f8fafc' } }, { ...home,
    header: { element: { display: 'block', position: 'fixed', backgroundColor: 'rgba(2, 6, 23, 0.4)', padding: '0px' }, bar: { display: 'flex', justifyContent: 'space-between', padding: '0px 24px' },
      logo: { type: 'text', text: 'Brand', computed: { fontSize: '18px', fontWeight: '600', color: 'rgb(248, 250, 252)' } },
      nav: ['Features', 'Pricing', 'Assets'].map((label) => ({ label, href: 'http://x/#' + label.toLowerCase(), computed: { fontSize: '14px', fontWeight: '500', color: 'rgb(203, 213, 225)' } })), navGap: 32, cta: null,
      ctas: [{ label: 'Start Journey', href: 'http://x/#', cls: 'px-5 py-2.5 rounded-full border border-white text-sm font-medium hover:bg-brand', pad: '10px 20px', fontSize: '14px', bs: { bg: '', fg: 'rgb(248, 250, 252)', bw: '1px', bds: 'solid', bd: 'rgb(255, 255, 255)' } }],
      textLinks: [], rows: null, chips: [] } });
  const v = (ts && ts.values) ? ts.values : ts;
  const cta = ((v.header_main || {}).main_right || []).find((e) => e.element_type.element === 'cta_button');
  ok(cta && cta.element_type.cta_button.cta_style === 'btn-outline-2', 'the header CTA resolves to the variant by its MEASURED colours (btn-outline-2), never the first outline preset');
}

console.log(fails ? `\n✗ ${fails} FAIL` : '\n✓ ALL PASS — spacing + strip parity guarded');
process.exit(fails ? 1 : 0);
