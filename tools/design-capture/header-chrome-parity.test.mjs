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

console.log(fails ? `\n✗ ${fails} FAIL` : '\n✓ ALL PASS — header/footer chrome translations guarded');
process.exit(fails ? 1 : 0);
