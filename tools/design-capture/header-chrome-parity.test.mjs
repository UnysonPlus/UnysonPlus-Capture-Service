// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Header/footer CHROME translation guard (browser-free). Feeds synthetic capture output through the
// real toThemeSettings() and asserts each measured signal lands on the correct NATIVE option.
//
// WHY THIS EXISTS: these rules were originally "proved" with screenshots, which is the anti-pattern
// docs/extensions/site-converter.md names explicitly — the proof of a translation is a browser-free
// fixture, not a rendered diff. Every rule below had no regression guard until this file.
//
// Each case also pins a NEGATIVE: with the signal absent, the option must NOT be emitted, so a default
// conversion is unchanged. That is the half that actually protects existing sites.
//
// Run: node header-chrome-parity.test.mjs   (exit 1 on any failure)
import { toThemeSettings } from './to-theme-settings.mjs';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + msg); if (!cond) fails++; };
const val = (home, config = {}) => {
  const ts = toThemeSettings({ colors: { bg: '#0a0a0a', ink: '#eee' }, ...config }, home);
  return (ts && ts.values) ? ts.values : ts;
};
/** A capture whose header changes on scroll. */
const scrolling = (top, scrolled, extra = {}) => ({
  header: { element: { position: 'fixed', backgroundColor: 'rgba(0, 0, 0, 0)' }, bar: {}, ...extra.header },
  chrome: { header_scroll: { top, scrolled } },
  ...extra,
});

console.log('\n=== HEADER: two-state numeric translation ===');
{
  // 88px at rest -> 73px stuck. scroll_height carries the EXACT stuck height; scroll_shrink rides with
  // it because min-height alone loses to taller content and the bar would never actually shrink.
  const v = val(scrolling(
    { height: 88, bg: 'rgba(0, 0, 0, 0)', backdrop: '', padTop: '20px', linkColor: 'rgb(200,200,200)', position: 'fixed' },
    { height: 73, bg: 'rgba(10, 10, 10, 0.9)', backdrop: 'blur(12px)', padTop: '20px', linkColor: 'rgb(200,200,200)' },
  ));
  const hl = v.header_layout || {};
  ok(hl.scroll_height && hl.scroll_height.value === '73', 'scroll_height = 73px (exact stuck height)');
  ok(hl.scroll_shrink === 'yes', 'scroll_shrink enabled alongside scroll_height');
  ok(hl.header_scroll_change === 'yes', 'header_scroll_change set');
  ok(!hl.scroll_link_color, 'scroll_link_color NOT emitted when the link colour is unchanged');
}
{
  // A header that only restyles its links once stuck.
  const v = val(scrolling(
    { height: 80, bg: 'rgba(0, 0, 0, 0)', backdrop: '', padTop: '16px', linkColor: 'rgb(255,255,255)', position: 'fixed' },
    { height: 80, bg: 'rgb(255,255,255)', backdrop: '', padTop: '16px', linkColor: 'rgb(17,17,17)' },
  ));
  const hl = v.header_layout || {};
  ok(!!hl.scroll_link_color, 'scroll_link_color emitted when the nav darkens on scroll');
  ok(!hl.scroll_height, 'scroll_height NOT emitted when the height is unchanged');
}

console.log('\n=== HEADER: glass blur + saturation ===');
{
  // REGRESSION: bar.backdropFilter is the STRING 'none' on a non-frosted wrapper. A plain `||` chain
  // stops there and never reaches the element that actually carries the blur — that bug shipped once.
  const v = val({
    header: { element: { position: 'sticky', backgroundColor: 'rgba(248,246,240,0.9)', backdropFilter: 'blur(12px)' },
              bar: { backdropFilter: 'none', boxShadow: 'none' } },
    chrome: {},
  });
  const hl = v.header_layout || {};
  ok(hl.header_glass === 'yes', 'header_glass detected from the ELEMENT (not just the inner bar)');
  ok(hl.header_glass_blur && hl.header_glass_blur.value === '12', 'header_glass_blur = 12px from the element');
  ok(hl.header_glass_saturate === 100, 'saturate pinned to 100 when the source blurs WITHOUT saturating');
}
{
  const v = val({
    header: { element: { position: 'sticky', backgroundColor: '#111', backdropFilter: 'blur(10px) saturate(1.4)' }, bar: {} },
    chrome: {},
  });
  const hl = v.header_layout || {};
  ok(!hl.header_glass_blur, 'blur NOT emitted at the theme default (10px)');
  ok(!hl.header_glass_saturate, 'saturate NOT emitted at the theme default (140%)');
}

console.log('\n=== HEADER: shadow depth bucketing ===');
{
  const soft = val({ header: { element: { position: 'sticky', backgroundColor: '#111', boxShadow: '0 1px 4px rgba(0,0,0,.2)' }, bar: {} }, chrome: {} });
  const strong = val({ header: { element: { position: 'sticky', backgroundColor: '#111', boxShadow: '0 18px 60px rgba(0,0,0,.4)' }, bar: {} }, chrome: {} });
  const mid = val({ header: { element: { position: 'sticky', backgroundColor: '#111', boxShadow: '0 6px 22px rgba(0,0,0,.3)' }, bar: {} }, chrome: {} });
  ok((soft.header_layout || {}).header_shadow_depth === 'soft', 'blur < 12px -> soft');
  ok((strong.header_layout || {}).header_shadow_depth === 'strong', 'blur > 26px -> strong');
  ok(!(mid.header_layout || {}).header_shadow_depth, 'mid blur -> medium, so nothing emitted (theme default)');
}

console.log('\n=== FOOTER: measured chrome ===');
{
  const v = val({
    footer: {
      computed: { backgroundColor: 'rgb(31,31,31)', color: '#a6a6a6', padding: '80px 0px 40px 0px' },
      colGap: '48px', linkColor: 'rgb(166,166,166)', linkHoverColor: 'rgb(250,250,250)', mobileColumns: 2,
    },
  });
  ok(v.footer_col_gap && v.footer_col_gap.value === '48', 'footer_col_gap = 48px (theme default is 40)');
  ok(!!v.footer_link_hover_color, 'footer_link_hover_color emitted when hover differs from rest');
  ok(v.footer_mobile_columns === '2', 'footer_mobile_columns = 2 when the source keeps 2-up on a phone');
  ok(!v.footer_padding_top_custom, '80px is ON the spacing scale -> no custom padding override');
}
{
  // 240px is past the scale ceiling (8rem = 128px) and used to CLAMP, losing 112px.
  const v = val({
    footer: {
      computed: { backgroundColor: '#111', color: '#ccc', padding: '240px 0px 90px 0px' },
      colGap: '40px', linkColor: 'rgb(1,1,1)', linkHoverColor: 'rgb(1,1,1)', mobileColumns: 1,
    },
  });
  ok(v.footer_padding_top_custom && v.footer_padding_top_custom.value === '240', 'off-scale 240px -> exact override');
  ok(v.footer_padding_bottom_custom && v.footer_padding_bottom_custom.value === '90', 'off-scale 90px -> exact override');
  ok(!v.footer_col_gap, 'gap NOT emitted at the theme default (40px)');
  ok(!v.footer_link_hover_color, 'hover colour NOT emitted when it equals the rest colour');
  ok(!v.footer_mobile_columns, 'mobile columns NOT emitted when the source stacks');
}

console.log('\n=== NEGATIVE: an empty capture must not invent options ===');
{
  const v = val({ header: { element: {}, bar: {} }, chrome: {}, footer: {} });
  const hl = v.header_layout || {};
  const invented = ['scroll_height', 'scroll_link_color', 'header_glass_blur', 'header_glass_saturate', 'header_shadow_depth']
    .filter((k) => hl[k] !== undefined);
  const invented2 = ['footer_col_gap', 'footer_link_hover_color', 'footer_mobile_columns', 'footer_padding_top_custom']
    .filter((k) => v[k] !== undefined);
  ok(invented.length === 0, 'no header chrome options invented from an empty capture' + (invented.length ? ' (' + invented.join(',') + ')' : ''));
  ok(invented2.length === 0, 'no footer chrome options invented from an empty capture' + (invented2.length ? ' (' + invented2.join(',') + ')' : ''));
}

console.log('\n=== HEADER: two-row masthead → Bottom Bar · every CTA · chip → list_item (PHP twin: golden [H]) ===');
{
  const skin = { role: 'Outline', cls: '', bg: 'rgba(255, 255, 255, 0.2)', grad: '', fg: 'rgb(255, 255, 255)', bd: 'rgba(95, 73, 42, 0.08)', bw: '1px', shadow: '', radius: '999px', px: '18px', py: '0px', fs: '10px', lh: 'normal', height: '44px', ff: 'Inter', ls: '2.2px', tt: 'uppercase', fw: '400', hov: '', tr: '0.35s' };
  const bs = { bg: 'rgba(255, 255, 255, 0.2)', fg: 'rgb(255, 255, 255)', bw: '1px', bds: 'solid', bd: 'rgba(95, 73, 42, 0.08)', grad: '' };
  const home = {
    buttonSkins: [skin, { ...skin }],
    header: {
      element: { position: 'fixed', backgroundColor: 'rgba(0, 0, 0, 0)', backdropFilter: 'blur(20px)', borderBottomWidth: '1px', borderBottomStyle: 'solid', borderBottomColor: 'rgba(95, 73, 42, 0.08)' },
      bar: { maxWidth: 'none', padding: '18px 28px 14px' },
      nav: [{ label: 'Alpha', href: '#a', computed: { color: 'rgb(255, 255, 255)', fontSize: '10px' }, hover: { color: 'rgb(172, 123, 63)' } }],
      ctas: [
        { label: 'Map', href: '', cls: '', bs, fs: '10px', pad: '0px 18px', height: '44px' },
        { label: 'Visit', href: '', cls: '', bs, fs: '10px', pad: '0px 18px', height: '44px' },
      ],
      rows: { nav_pos: 'bottom', nav_cls: 'bottom', brand_height: 78, brand_pad_x: 28, nav_height: 38, border: { width: 1, style: 'solid', color: 'rgba(95, 73, 42, 0.08)', side: 'top' }, padding: '10px 28px 12px', align: 'center', gap: 28 },
      chips: [{ text: 'Seasonal note · Second note', cls: 'chip', hide: ['hide-xs', 'hide-sm'], dot: { size: 7, color: 'rgb(215, 170, 97)', shadow: 'rgba(215, 170, 97, 0.55) 0px 0px 18px 0px' },
        cs: { gap: '10px', padding: '10px 16px', borderRadius: '999px', backgroundColor: 'rgba(255, 255, 255, 0.2)', color: 'rgb(255, 255, 255)', fontSize: '10px', fontWeight: '400', letterSpacing: '2.4px', textTransform: 'uppercase', lineHeight: '15px', boxShadow: 'none', borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: 'rgba(95, 73, 42, 0.08)' } }],
    },
    chrome: {},
  };
  const v = val(home);
  const main = v.header_main || {};
  const ctas = (main.main_right || []).filter((n) => n.element_type.element === 'cta_button').map((n) => n.element_type.cta_button);
  ok(JSON.stringify(ctas.map((c) => c.cta_text)) === JSON.stringify(['Map', 'Visit']), 'every header action → a cta_button (two, DOM order)');
  ok(ctas[0] && ctas[0].cta_style === 'btn-outline', 'header CTA style resolves to the preset matching its GLASS skin (translucent fill + hairline)');
  ok(ctas[0] && ctas[0].cta_size === 'btn-md', 'header CTA size resolves to the size preset (single size → Default md)');
  ok(!JSON.stringify(main).includes('menu_area'), 'no menu_area in the brand row (it moved to the Bottom Bar)');
  const chip = (main.main_center || [])[0] || {};
  ok(chip.element_type && chip.element_type.element === 'list_item', 'chip → list_item in the centre zone');
  ok(chip.element_type && chip.element_type.list_item.li_text === 'Seasonal note · Second note', 'chip text');
  const mk = (chip.element_type && chip.element_type.list_item.li_icon && chip.element_type.list_item.li_icon.markup) || '';
  ok(mk.includes('<circle') && mk.includes('rgb(215, 170, 97)'), 'chip dot → inline SVG circle icon in the dot colour');
  ok(JSON.stringify(chip.visibility) === JSON.stringify(['hide-xs', 'hide-sm']), 'chip hidden under 1100px → Hide On mobile + tablet');
  ok(chip.element_css_class === 'sc-hdr-chip', 'chip carries its element CSS Class');
  const bb = v.header_bottombar || {};
  ok(bb.bottombar_center && bb.bottombar_center[0] && bb.bottombar_center[0].element_type.element === 'menu_area', 'Bottom Bar centre column = the primary menu');
  ok((bb.bottombar_left || []).length === 0 && (bb.bottombar_right || []).length === 0, 'Bottom Bar left/right columns empty');
  const bcs = (bb.bottombar_custom_styling && bb.bottombar_custom_styling.yes) || {};
  ok(bb.bottombar_custom_styling && bb.bottombar_custom_styling.enabled === 'yes', 'Bottom Bar custom styling enabled');
  ok(bcs.bottombar_border && bcs.bottombar_border.width.value === '1', "Bottom Bar border = the nav row's 1px rule");
  ok(bcs.bottombar_border && bcs.bottombar_border.color.custom === 'rgba(95, 73, 42, 0.08)', 'Bottom Bar border colour keeps its alpha');
  ok(JSON.stringify(bcs.bottombar_border_sides) === JSON.stringify(['top']), 'Bottom Bar border on the TOP edge (facing the brand row)');
  const hl = v.header_layout || {};
  ok(hl.min_height && hl.min_height.value === '78', 'header min_height = the BRAND row (78), not the stacked rows');
  ok(hl.header_border === 'yes', "header_border from the header element's own border-bottom");
  ok(v.header_menu && v.header_menu.menu_link_hover_color.custom === 'rgb(172, 123, 63)', 'menu hover colour = the captured a:hover colour');
  const css = (v.misc_custom_css && v.misc_custom_css.custom_css) || '';
  ok(css.includes('.site-header .sc-hdr-chip .list-item{') && css.includes('border-radius:999px') && css.includes('background-color:rgba(255, 255, 255, 0.2)'), 'chip pill skin as scoped CSS on the element class');
  ok(css.includes('.sc-hdr-chip .list-item__icon{width:7px;height:7px') && css.includes('rgba(215, 170, 97, 0.55) 0px 0px 18px'), 'chip dot size + glow as scoped CSS');
  ok(css.includes('.site-header .header-bottombar{padding:10px 28px 12px;'), 'nav row padding as a scoped Bottom Bar rule');
  ok(css.includes('.header-bottombar .primary-menu{gap:28px;}'), 'nav link gap as a scoped Bottom Bar rule');
  ok(css.includes('.site-header.site-header--border{box-shadow:none !important;border-bottom:1px solid rgba(95, 73, 42, 0.08) !important;}'), "header hairline in the source's own translucent colour");
  // FULL-WIDTH bar: the inner bar has no max-width → Full Width, with the source row's own 28px side inset.
  ok(hl.container === 'container-fluid', 'header with no capped bar → Full Width container');
  ok(css.includes('.site-header .header-main .fw-container-fluid{padding-left:28px;padding-right:28px;}'), "full-width header keeps the source's 28px side inset");
  ok(css.includes('.site-header .header-bottombar .fw-container-fluid,.site-header .header-topbar .fw-container-fluid{padding-left:0;padding-right:0;}'), 'Bottom Bar inner container goes flush');
  // NEGATIVE — a one-row header keeps its menu in the main row and an EMPTY Bottom Bar.
  const v1 = val({ header: { element: {}, bar: {} }, chrome: {} });
  ok(JSON.stringify(v1.header_main || {}).includes('menu_area'), 'one-row header: menu_area stays in the main row');
  ok(v1.header_bottombar && v1.header_bottombar.bottombar_center.length === 0 && !v1.header_bottombar.bottombar_custom_styling, 'one-row header: Bottom Bar stays empty');
}

console.log(fails ? `\n✗ ${fails} FAIL` : '\n✓ ALL PASS — header/footer chrome translations guarded');
process.exit(fails ? 1 : 0);
