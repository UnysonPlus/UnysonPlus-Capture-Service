// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Footer BOXED-BODY parity guard (browser-free). Feeds the capture's footer shell / main row / label bar
// measures (what capture-extract.mjs stamps for a footer whose rows sit in one inset panel) through the real
// toThemeSettings() and asserts the same Theme-Settings the PHP Stitch emits (detect_footer_shell /
// footer_box_values / footer_row_valign / footer_measured_split / the label-bar copyright branch):
//   footer_body_box (max width from the capped rule, gutter, padding, ONE linear gradient → native, four-edge
//   hairline with its alpha, first shadow layer, decor strip → ::before, copyright inside), every bar Full
//   Width, main_footer_valign 'end', a measured 57/43 split, the label bar as the Copyright bar (auto width +
//   between, hairline, typography with alpha, case/tracking as scoped CSS), a multi-layer footer gradient verbatim.
//
// Run: node footer-box-parity.test.mjs   (exit 1 on any failure)
import { toThemeSettings } from './to-theme-settings.mjs';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + msg); if (!cond) fails++; };

const config = {
  colors: { bg: '#0b0d10', ink: '#ffffff' },
  footer: {
    menu: [
      { label: 'Studio', url: '#', children: [{ label: 'Studio', url: '#' }, { label: 'Services', url: '#' }] },
    ],
    social: [],
    copyright: '',
  },
};
const home = {
  footer: {
    computed: { backgroundColor: 'rgb(7, 10, 14)', color: 'rgb(255, 255, 255)', padding: '120px 0px 94px', backgroundImage: 'radial-gradient(circle at 20% 12%, rgba(255, 171, 89, 0.1), rgba(0, 0, 0, 0) 16%), linear-gradient(rgb(7, 10, 14), rgb(11, 13, 16))' },
    shell: {
      padding: '36px', margin: '0px 16px', cappedWidth: 1600,
      backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'linear-gradient(rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.016))',
      border: { top: '1px solid rgba(255, 255, 255, 0.08)', right: '1px solid rgba(255, 255, 255, 0.08)', bottom: '1px solid rgba(255, 255, 255, 0.08)', left: '1px solid rgba(255, 255, 255, 0.08)' },
      radius: '0px', boxShadow: 'rgba(0, 0, 0, 0.34) 0px 24px 80px 0px',
      decor: [{ top: '295.9px', right: '0px', bottom: '0px', left: '0px', height: '120px', width: '1406px', backgroundImage: 'linear-gradient(rgba(0, 0, 0, 0) 0%, rgba(255, 255, 255, 0.04) 100%)', backgroundColor: 'rgba(0, 0, 0, 0)', backgroundSize: 'auto', backgroundPosition: '0% 0%', backgroundRepeat: 'repeat', opacity: '0.52', clipPath: 'none', borderRadius: '0px', filter: 'none', mixBlendMode: 'normal' }],
      copyrightInside: true, mainRowPadding: '0px', lastRowMargin: '34px 0px 0px', lastRowPadding: '22px 0px 0px',
    },
    mainRow: { display: 'grid', alignItems: 'end', gridTemplateColumns: '747.5px 552.5px' },
    labelBar: { cells: ['Aether House', 'Amber Gold · Teal Wood · Twilight Blue', 'Crafting the nocturnal web'], fontFamily: '"Inter Tight", sans-serif', fontSize: '12px', fontWeight: '400', color: 'rgba(255, 255, 255, 0.52)', letterSpacing: '2.64px', textTransform: 'uppercase', lineHeight: '18px', display: 'flex', justifyContent: 'space-between', borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: 'rgba(255, 255, 255, 0.08)', backgroundColor: 'rgba(0, 0, 0, 0)' },
  },
};

const ts = toThemeSettings(config, home);
const v = ts && ts.values ? ts.values : ts;
const css = String((v.misc_custom_css && v.misc_custom_css.custom_css) || '');

console.log('\n=== footer boxed-body parity ===');
const box = v.footer_body_box;
ok(box && box.enabled === 'yes', 'footer_body_box enabled');
const f = (box && box.yes) || {};
ok(f.footer_box_max_width && f.footer_box_max_width.value === '1600', 'max width 1600px from the capped width rule');
ok(f.footer_box_gutter && f.footer_box_gutter.value === '16', 'side gutter 16px from the shell margin');
ok(f.footer_box_padding_y && f.footer_box_padding_y.value === '36' && f.footer_box_padding_x && f.footer_box_padding_x.value === '36', 'padding 36 / 36');
ok(f.footer_box_background && f.footer_box_background.gradient && f.footer_box_background.gradient.data.stops.length === 2 && f.footer_box_background.gradient.data.angle === 180, 'ONE linear gradient → the native gradient data (180deg)');
ok(f.footer_box_border && f.footer_box_border.width.value === '1' && f.footer_box_border.color.custom === 'rgba(255, 255, 255, 0.08)', 'four-edge hairline keeps its alpha');
ok(f.footer_box_shadow && f.footer_box_shadow.y === 24 && f.footer_box_shadow.blur === 80 && /0\.34/.test(f.footer_box_shadow.color), 'first shadow layer → x/y/blur/colour');
ok(!f.footer_box_radius, 'no radius emitted for 0px');
ok(f.footer_box_copyright_inside === 'yes', 'copyright inside the panel');
ok(/\.footer--boxed \.footer__body::before\{[^}]*bottom:0;[^}]*height:120px;[^}]*opacity:0\.52/.test(css), 'decor strip → the panel ::before (bottom-anchored, height, opacity)');
ok(/\.footer--boxed \.footer__body > \.footer-section--main-footer\{padding-top:0(?:px)?;padding-bottom:0(?:px)?;\}/.test(css), 'main bar padding replaced by the measured row box');
ok(/\.footer--boxed \.footer__body > \.footer-section--copyright\{margin-top:34px;padding-top:22px;padding-bottom:0(?:px)?;\}/.test(css), 'bottom bar gap / padding measured');
for (const bp of ['pre_footer', 'main_footer', 'post_footer']) ok(v[bp + '_custom_styling'] && v[bp + '_custom_styling'].yes[bp + '_container'] === 'container-fluid', bp + ' → Full Width inside the panel');
ok(v.main_footer_custom_styling && v.main_footer_custom_styling.yes.main_footer_valign === 'end', 'main row align-items:end → Column Alignment Bottom');
const mfc = v.main_footer_columns;
const split = mfc && mfc[mfc.count] && mfc[mfc.count].main_footer_split;
ok(Array.isArray(split) && split[0].w === 57 && split[1].w === 43, 'measured split 57 / 43 from the grid tracks');
ok(/\.footer\{background-image:radial-gradient/.test(css), 'multi-layer footer gradient carried verbatim on .footer');
ok(!(v.footer_background && v.footer_background.gradient), 'multi-layer stack NOT forced into the single native gradient');

console.log('\n=== label bar → copyright bar ===');
const cs = v.copyright_settings;
const cc = cs && cs.yes && cs.yes.copyright_columns;
ok(cc && cc.count === '3', 'three label cells → 3 copyright columns');
ok(cc && cc['3'] && /Aether House/.test(JSON.stringify(cc['3'].copyright_col_1)) && /nocturnal web/.test(JSON.stringify(cc['3'].copyright_col_3)), 'cells carried in order');
ok(cc && cc['3'] && cc['3'].copyright_auto === 'yes' && cc['3'].copyright_justify === 'between', 'flex space-between → Auto Width + Between');
ok(!/All rights reserved/.test(JSON.stringify(cs)), 'no fabricated © line');
const ccs = cs && cs.yes && cs.yes.copyright_custom_styling && cs.yes.copyright_custom_styling.yes;
ok(ccs && ccs.copyright_border && ccs.copyright_border.color.custom === 'rgba(255, 255, 255, 0.08)' && ccs.copyright_border_sides[0] === 'top', 'hairline top border with alpha');
ok(ccs && ccs.copyright_typography && ccs.copyright_typography.size.value === '12' && ccs.copyright_typography.color === 'rgba(255, 255, 255, 0.52)' && ccs.copyright_typography['letter-spacing'] === 2.64, 'typography 12px / translucent colour / tracking');
ok(ccs && ccs.copyright_container === 'container-fluid', 'copyright bar Full Width inside the panel');
ok(/\.footer \.footer-section--copyright\{text-transform:uppercase;letter-spacing:2\.64px;line-height:18px;\}/.test(css), 'case / tracking / line-height as scoped CSS');

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
