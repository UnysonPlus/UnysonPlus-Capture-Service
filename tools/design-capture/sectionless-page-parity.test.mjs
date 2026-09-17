// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SECTION-LESS VIDEO PAGE parity guard (browser-free). The capture-side records a page like the payment-operations
// fixture produces (a page-wide fixed video, a brand-only footer laid out brand | paragraph, a capsule signup pill with
// a placeholder tint) fed through the real toThemeSettings() / toPages(), asserting what the PHP golden [U] asserts:
//   - the fixed backdrop → Site Background video in FIXED mode (general_layout.site_background.video)
//   - a brand-only footer → 2 columns (logo | .footer-tagline paragraph), NO fabricated © bar
//   - the capsule form → design 'capsule', the wrapper skin on .fw-nl__fields, the input keeping only its type + inset,
//     the 448px measure centred, the placeholder rgba tint
//   - a segmented band's inherited container padding rides the section rhythm
//   - the measured CSS-class reveals (capture data-sc-reveal) → Scroll Motion REVEAL with the source's delay sequence,
//     on the heading, the form, and each card COLUMN (the stagger); the pill wrapper's own :hover → .fw-nl__fields:hover
//
// Run: node sectionless-page-parity.test.mjs   (exit 1 on any failure)
import { toThemeSettings } from './to-theme-settings.mjs';
import { toPages } from './to-pages.mjs';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + msg); if (!cond) fails++; };

console.log('\n=== theme settings: site-bg video + brand-only footer ===');
const config = { colors: { bg: '#000000', ink: '#ffffff' }, footer: { menu: [], social: [], copyright: '' } };
const home = {
  pageFixedVideo: { mp4: 'https://cdn.example.invalid/backdrop.mp4', webm: '', poster: '' },
  footer: {
    computed: { backgroundColor: 'rgb(31, 41, 55)', color: 'rgb(255, 255, 255)', padding: '48px 24px', backgroundImage: 'none' },
    brand: 'AETHER HOUSE', groups: [], social: [], copyright: '', links: [], text: '',
    tagline: { text: 'Aether House is a financial technology company, not a bank. Banking services provided by partner institutions.', html: 'Aether House is a financial technology company, not a bank. Banking services provided by partner institutions.', computed: { fontSize: '11px', lineHeight: '17.875px', color: 'rgba(255, 255, 255, 0.4)', textAlign: 'right', maxWidth: '576px' } },
    brandRow: true, shell: null, mainRow: null, labelBar: null, leadEyebrow: null,
  },
};
const ts = toThemeSettings(config, home);
const v = ts && ts.values ? ts.values : ts;
const vid = (((v.general_layout || {}).site_background) || {}).video || {};
ok(vid.enabled === 'yes' && vid.position === 'fixed' && /backdrop\.mp4$/.test(String((vid.source_mp4 || {}).url || '')), 'page-wide fixed video → Site Background video, FIXED mode');
const fc = v.main_footer_columns || {};
ok(fc.count === '2' && /footer-tagline/.test(JSON.stringify(fc['2'] && fc['2'].main_footer_col_2)), 'brand-only footer → logo | tagline paragraph (2 columns)');
ok(v.copyright_settings && v.copyright_settings.enabled === 'no', 'no © line in the source → no fabricated © bar');
ok(/\.footer-tagline\{[^}]*font-size:11px[^}]*text-align:right/.test(String((v.misc_custom_css || {}).custom_css || '')), 'the paragraph keeps its 11px / right-aligned type');

console.log('\n=== pages: capsule signup + inherited band padding ===');
const nl = { t: 'newsletter', role: 'newsletter', placeholder: 'Enter your email', name_placeholder: '', show_name: false, button_label: 'Open account', align: 'center', rounded: 'pill', design: 'capsule', gap: 0, wrapMaxWidth: '448px', inputPadding: '12px 24px',
  button_bg: 'rgb(255, 255, 255)', button_fg: 'rgb(0, 0, 0)', button: { cls: 'liquid-btn px-6 py-3 rounded-full', fontSize: '14px', textTransform: 'none', letterSpacing: '0.35px', lineHeight: '21px', height: '47px', fontWeight: '500', pad: '12px 24px', radius: '9999px' },
  field_bg: '', fieldSkin: { bgi: '', bg: 'rgba(243, 250, 255, 0.6)', border: '1px solid rgba(255, 255, 255, 0.8)', shadow: 'rgba(0, 0, 0, 0.03) 0px 20px 40px 0px', backdrop: 'blur(24px)', padding: '6px', height: '61px', fontSize: '15px', color: 'rgb(255, 255, 255)' },
  placeholderColor: 'rgba(255, 255, 255, 0.9)', icon: null, iconColor: '', fieldFocus: '', mt: 40, mb: 0,
  reveal: { dir: 'up', distance: 30, scale: 1, duration: 1.2, delay: 0.2, ease: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  fieldHover: 'background-color:oklch(1 0 0 / 0.7);background-image:initial;box-shadow:oklch(1 0 0) 0px 1px 1px inset, rgba(0, 0, 0, 0.05) 0px 24px 48px;border-color:oklch(1 0 0)' };
const rv = (delay) => ({ dir: 'up', distance: 30, scale: 1, duration: 1.2, delay, ease: 'cubic-bezier(0.16, 1, 0.3, 1)' });
const tile = (title, delay) => ({ width: '', cls: '', fullCls: 'glass', colId: 'c' + delay, cw: 4, minH: 0, html: '<div>…</div>', reveal: rv(delay), card: { icon: '', customIcon: '', lucide: '', iconLayout: 'top', iconColor: '', title, titleTag: 'h3', text: '<p>Body.</p>', link: null, center: false, box: null } });
const cardRow = { t: 'row', valign: '', gap: 24, gapResp: null, html: '', mt: 0, mb: 0, nowrap: false, cols: [tile('Cross-Border Liquidity', 0), tile('Liquidity Forecasting', 0.1), tile('Real-time Ledgers', 0.2)] };
const label = { t: 'text', html: '<p>Sub-millisecond finality</p>', text: 'Sub-millisecond finality', tag: 'p', cls: '', fontSize: '12px', color: 'rgba(255, 255, 255, 0.8)', lineHeight: '16px', fontWeight: '400', textAlign: 'center', textTransform: 'uppercase', letterSpacing: '1.2px', marginTop: '32px', marginBottom: '0px' };
const textStyles = [{ name: 'Lead', size: '20', weight: '', line_height: '1.4', letter_spacing: '-0.5px', transform: '', class: 'lead' }, { name: 'Caption', size: '11', weight: '', line_height: '1.63', letter_spacing: '', transform: '', class: 'font-caption' }, { name: 'Eyebrow', size: '12', weight: '400', line_height: '', letter_spacing: '1.2px', transform: 'uppercase', class: '' }];
const out = toPages({ url: 'http://x/', typography: { textStyles }, sections: [{ sectionClass: 'hero', bandOf: 'main', computed: { padding: '225px 16px 0px 16px', margin: '0px' }, blocks: [{ t: 'heading', level: 1, text: 'Radically different banking', html: 'Radically different banking', align: 'center', reveal: rv(0) }, nl, label] }, { sectionClass: 'features', bandOf: 'main', computed: { padding: '160px 24px 128px 24px', margin: '0px' }, blocks: [cardRow] }] }, { hifiCss: true });
const sec = out.pages[0].builder[0];
let node = null; const walk = (n) => { if (n.shortcode === 'newsletter') node = n; (n._items || []).forEach(walk); }; walk(sec);
ok(!!node && node.atts.design === 'capsule', 'the capsule block → newsletter design "capsule"');
const css = String((node && node.atts.custom_css) || '');
ok(/selector \.fw-nl__fields\{[^}]*background:rgba\(243, 250, 255, 0\.6\)[^}]*padding:6px/.test(css), 'the wrapper skin rides .fw-nl__fields');
ok(/selector \.fw-nl__input\{[^}]*color:rgb\(255, 255, 255\)[^}]*padding:12px 24px/.test(css) && !/selector \.fw-nl__input\{[^}]*background/.test(css), 'the input keeps only its type + inset (no skin)');
ok(css.includes('selector{max-width:448px;margin-left:auto;margin-right:auto;}'), 'the 448px measure, centred');
ok(css.includes('::placeholder{color:rgba(255, 255, 255, 0.9)'), 'the placeholder tint from the opacity utility');
ok(String((sec.atts.padding_top || {}).lg || (sec.atts.padding_top || {}).base || '').includes('225'), 'the band inherits the container padding-top (225px) in the section rhythm');

console.log('\n=== reveals: the entrance sequence → Scroll Motion, the pill hover ===');
let head = null; const walk2 = (n) => { if (n.shortcode === 'special_heading') head = n; (n._items || []).forEach(walk2); }; walk2(sec);
const hrv = head && head.atts.gsap_motion && head.atts.gsap_motion.reveal;
ok(head && head.atts.gsap_motion.effect === 'reveal' && hrv.direction === 'up' && hrv.distance === 30 && hrv.style === 'subtle' && hrv.advanced && hrv.advanced.custom.ease === 'expo.out', 'the h1 .reveal-up (30px up, expo-like bezier) → Scroll Motion REVEAL up / 30 / Subtle / expo.out');
ok(node && node.atts.gsap_motion && node.atts.gsap_motion.reveal && node.atts.gsap_motion.reveal.delay === 0.2, 'the form .delay-200 → the newsletter reveal delay 0.2 (the sequence)');
const sec2 = out.pages[0].builder[1]; const cols = []; const walk3 = (n) => { if (n.type === 'flexbox' && n.atts && n.atts.width && n.atts.width.base && n.atts.gsap_motion && n.atts.gsap_motion.effect === 'reveal') cols.push(n); (n._items || []).forEach(walk3); }; walk3(sec2);
ok(cols.length === 3 && JSON.stringify(cols.map((c) => c.atts.gsap_motion.reveal.delay)) === '[0,0.1,0.2]', 'each card COLUMN carries its own reveal (the stagger 0 / 0.1 / 0.2) through the flexbox cell rebuild');
ok(css.includes('selector .fw-nl__fields:hover{background:oklch(1 0 0 / 0.7);border-color:oklch(1 0 0);box-shadow:oklch(1 0 0) 0px 1px 1px inset, rgba(0, 0, 0, 0.05) 0px 24px 48px;}') && css.includes('selector .fw-nl__fields{transition:background .3s,border-color .3s,box-shadow .3s;}'), 'the pill wrapper OWN :hover → .fw-nl__fields:hover + transition');

console.log('\n=== text styles: the FULL treatment picks the Eyebrow, not the nearest size ===');
let lab = null; const walk4 = (n) => { if (n.shortcode === 'text_block' && /Sub-millisecond/.test(String(n.atts.text))) lab = n; (n._items || []).forEach(walk4); }; walk4(sec);
ok(lab && lab.atts.font_size_preset === 'font-eyebrow', 'a tracked uppercase 12px label → the native Text Style EYEBROW (font-<slug> for a class-less style), not the 11px Caption');
ok(lab && lab.atts.text_color && lab.atts.text_color.custom === 'rgba(255, 255, 255, 0.8)' && !/style=/.test(String(lab.atts.text)), 'its ink → native Text Color, no inline style');
ok(lab && !/text-transform|letter-spacing/.test(String(lab.atts.custom_css || '')), 'the transform + tracking the preset owns are not repeated on the block');

console.log(fails ? `\n✗ ${fails} FAIL` : '\n✓ ALL PASS — section-less video page parity guarded');
process.exit(fails ? 1 : 0);
