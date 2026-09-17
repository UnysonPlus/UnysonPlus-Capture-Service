// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// HEADER AUDIT parity (browser-free; 2026-09-12). A one-row masthead (logo · links · "Sign in" + CTA as flex siblings) was
// read as a TWO-row header by DOM order — the menu went to a Bottom Bar and every conversion looked like "the last header".
// The JS twin of capture-extract's stacked-rows gate lives in the browser; what to-theme-settings must guarantee from the
// capture record is guarded here: no rows → the menu in main_center; rows → the Bottom Bar; a secondary text link beside
// the CTA → a list_item ahead of the button; a utility-built hover colour (`rgb(255 255 255 / var(--tw-text-opacity, 1))`,
// even truncated) → a clean colour, never a broken string the CSS generator swaps for the brand primary.
// PHP twin: tests/golden-fixture-1-test.php [M].   Run: node header-audit-parity.test.mjs   (exit 1 on any failure)
import { toThemeSettings } from './to-theme-settings.mjs';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + msg); if (!cond) fails++; };
const val = (home) => { const ts = toThemeSettings({ colors: { bg: '#020617', ink: '#f8fafc' } }, home); return (ts && ts.values) ? ts.values : ts; };
const nav = ['Features', 'Worlds', 'Pricing'].map((label) => ({ label, href: 'http://x/#' + label.toLowerCase(), computed: { fontFamily: 'Inter, sans-serif', fontSize: '14px', fontWeight: '500', color: 'rgb(203, 213, 225)', paddingLeft: '0px', paddingTop: '0px' }, hover: { color: 'rgb(255 255 255 / var(--tw-text-opacity, 1)' } }));
const base = (extra = {}) => ({
  header: { element: { display: 'block', position: 'fixed', backgroundColor: 'rgba(2, 6, 23, 0.4)', padding: '0px' }, bar: { display: 'flex', justifyContent: 'space-between', padding: '0px 24px', maxWidth: '1280px' },
    logo: { type: 'text', text: 'Brand', computed: { fontSize: '18px', fontWeight: '600', color: 'rgb(248, 250, 252)' } },
    nav, navGap: 32, cta: null,
    ctas: [{ label: 'Start', href: 'http://x/#', cls: 'px-5 py-2.5 rounded-full border border-white text-sm font-medium', bs: { bg: '', fg: 'rgb(248, 250, 252)', bw: '1px', bds: 'solid', bd: 'rgb(255, 255, 255)', grad: '' }, fs: '14px', pad: '10px 20px', height: '42px', hover: {} }],
    textLinks: [{ label: 'Sign in', href: 'http://x/#signin', color: 'rgb(203, 213, 225)', fontSize: '14px', fontWeight: '500', letterSpacing: 'normal', textTransform: 'none', hover: { color: 'rgb(255, 255, 255)' } }],
    rows: null, chips: [], ...extra },
});

console.log('\n=== HEADER AUDIT (PHP twin: golden [M]) ===');
{
  const v = val(base());
  const hm = v.header_main || {}, bb = v.header_bottombar || {};
  ok(hm.main_center && hm.main_center.length === 1 && hm.main_center[0].element_type.element === 'menu_area', 'one-row masthead (rows:null) → the menu sits in main_center, not a Bottom Bar');
  ok(!(bb.bottombar_left || []).length && !(bb.bottombar_center || []).length && !(bb.bottombar_right || []).length, '…and the Bottom Bar stays empty');
  const right = hm.main_right || [];
  ok(right.length === 2 && right[0].element_type.element === 'list_item' && right[0].element_type.list_item.li_text === 'Sign in' && right[0].element_type.list_item.li_link_type === 'url' && right[1].element_type.element === 'cta_button', 'a secondary "Sign in" beside the CTA → a list_item AHEAD of the cta_button in main_right');
  const css = String((v.misc_custom_css && v.misc_custom_css.custom_css) || '');
  ok(/\.site-header \.sc-hdr-link \.list-item, \.site-header \.sc-hdr-link \.list-item a\{[^}]*color:rgb\(203, 213, 225\)[^}]*font-size:14px/.test(css) && /\.sc-hdr-link \.list-item a:hover\{color:rgb\(255, 255, 255\);\}/.test(css), "…with the link's own colour / size + hover as scoped CSS");
  const menu = v.header_menu || {};
  ok(menu.menu_link_hover_color && menu.menu_link_hover_color.custom === 'rgb(255, 255, 255)', "a utility-built hover colour (`/ var(--tw-text-opacity, 1)`, truncated) → a clean rgb() — never a broken string");
  ok(menu.menu_link_color && menu.menu_link_color.custom === 'rgb(203, 213, 225)', 'the nav link colour is the measured slate');
}
{
  const v = val(base({ rows: { nav_pos: 'bottom', nav_cls: 'nav-row', align: 'left', nav_height: 44, padding: '0px', gap: 32, link_lh: 20, brand_height: 72 } }));
  const hm = v.header_main || {}, bb = v.header_bottombar || {};
  ok((bb.bottombar_left || []).some((e) => e.element_type.element === 'menu_area') && !(hm.main_center || []).length, 'a genuinely STACKED masthead (rows.nav_pos:bottom) → the menu rides the Bottom Bar');
}
{
  const v = val(base({ textLinks: [] }));
  const right = (v.header_main || {}).main_right || [];
  ok(right.length === 1 && right[0].element_type.element === 'cta_button', 'NEG: no secondary link → only the CTA in main_right');
}

console.log(fails ? `\n✗ ${fails} FAIL` : '\n✓ ALL PASS — header audit parity guarded');
process.exit(fails ? 1 : 0);
