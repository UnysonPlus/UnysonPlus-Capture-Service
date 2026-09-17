// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// NEWSLETTER SIGNUP parity (browser-free). A form-less SIGNUP LOCKUP: a paper-pill FIELD wrapper (gradient, hairline, blur,
// inset + drop shadow, radius 999, padding 12/16) around an envelope glyph (another icon set's id) + a transparent email
// input, and a full-width silk submit button 12px below (54px tall, 14px sentence-case). Rules: the lockup converts to the
// native newsletter shortcode (design stacked from geometry, pill from the WRAPPER's radius, the wrapper's skin on the
// field, the placeholder colour, the stack gap, the submit through the shared Button Preset matcher with its own type
// re-asserted, the glyph as the native field_icon via the semantic Lucide fallback + its colour). PHP twin:
// tests/golden-fixture-1-test.php [N]. Run: node newsletter-signup-parity.test.mjs   (exit 1 on any failure)
import { toPages } from './to-pages.mjs';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + msg); if (!cond) fails++; };

const silk = { bg: 'rgba(0, 0, 0, 0)', fg: 'rgb(47, 38, 26)', bd: 'rgba(255, 255, 255, 0.6)', bds: 'solid', bw: '1px', grad: 'linear-gradient(rgba(255, 255, 255, 0.88), rgba(255, 255, 255, 0.54))' };
const nl = { t: 'newsletter', role: 'newsletter', placeholder: 'Email address', name_placeholder: '', show_name: false, button_label: 'Request a walkthrough', align: '', rounded: 'pill', design: 'stacked', gap: 12,
  button_bg: 'rgba(0, 0, 0, 0)', button_fg: 'rgb(47, 38, 26)',
  button: { cls: 'silk w-full rounded-[999px] px-5 py-4 text-sm', fontSize: '14px', textTransform: 'none', letterSpacing: 'normal', lineHeight: '20px', height: '54px', fontWeight: '400', pad: '16px 20px', radius: '999px', bs: silk },
  field_bg: '', fieldSkin: { bgi: 'linear-gradient(rgba(255, 255, 255, 0.62), rgba(255, 255, 255, 0.28))', bg: '', border: '1px solid rgba(129, 108, 74, 0.08)', shadow: 'rgba(255, 255, 255, 0.65) 0px 1px 0px 0px inset, rgba(98, 78, 45, 0.08) 0px 20px 50px 0px', backdrop: 'blur(26px) saturate(1.1)', padding: '12px 16px', height: '50px', fontSize: '16px', color: 'rgb(45, 38, 31)' },
  placeholderColor: '#7f7366', icon: { id: 'ph:envelope-simple' }, iconColor: 'rgb(132, 114, 93)' };
// A silk button colour preset + a 54px size preset, as theme-settings would carry them (the shared matcher input).
const buttonPresets = { button_colors: [{ color_name: 'Silk', states: { default: { bg_color: { predefined: '', custom: 'rgba(0,0,0,0)' }, text_color: { predefined: '', custom: '#2f261a' }, border_color: { predefined: '', custom: 'rgba(255,255,255,0.6)' }, gradient: { type: 'linear', angle: 180, stops: [{ color: 'rgba(255, 255, 255, 0.88)', position: 0 }, { color: 'rgba(255, 255, 255, 0.54)', position: 100 }] } } } }],
  button_sizes: [{ slug: 'md', font_size: { value: '14', unit: 'px' }, padding_y: { value: '16', unit: 'px' }, padding_x: { value: '20', unit: 'px' }, height: { value: '54', unit: 'px' } }] };
const cap = { url: 'http://x/', sections: [{ sectionClass: 'section', computed: { padding: '0px 0px 120px', margin: '0px' }, blocks: [nl] }] };
const out = toPages(cap, { hifiCss: true, buttonPresets });
const sec = out.pages[0].builder.find((n) => n.type === 'section');
const find = (n, pred) => { if (!n || typeof n !== 'object') return null; if (pred(n)) return n; for (const c of (n._items || [])) { const r = find(c, pred); if (r) return r; } return null; };
const node = find(sec, (n) => n.shortcode === 'newsletter');
const a = (node && node.atts) || {}; const css = a.custom_css || '';

console.log('\n=== newsletter signup lockup (PHP twin: golden [N]) ===');
ok(!!node, 'a form-less signup lockup → the native newsletter shortcode');
ok(a.design === 'stacked' && a.rounded === 'pill', 'design stacked (button below the field) + pill (from the WRAPPER radius)');
ok(a.email_placeholder === 'Email address' && a.button_label === 'Request a walkthrough' && a.show_name === 'no', 'placeholder / label / no name field');
ok(/selector \.fw-nl__input\{background:linear-gradient\(rgba\(255, 255, 255, 0\.62\)[^}]*border:1px solid rgba\(129, 108, 74, 0\.08\)[^}]*box-shadow:[^}]*backdrop-filter:blur\(26px\) saturate\(1\.1\)[^}]*padding:12px 16px[^}]*height:50px[^}]*font-size:16px[^}]*color:rgb\(45, 38, 31\)/.test(css), "the field wears the WRAPPER's paper skin (gradient, hairline, shadow, blur, padding, height, type)");
ok(/selector \.fw-nl__input::placeholder\{color:#7f7366;opacity:1;\}/.test(css), 'placeholder colour carried');
ok(/selector \.fw-nl__fields\{gap:12px;\}/.test(css), 'the 12px stack gap between field and button');
ok(a.field_icon && a.field_icon['svg-source'] === 'library' && a.field_icon['svg-id'] === 'lucide/mail', "an envelope from another icon set → the native field_icon (Lucide 'mail' by meaning)");
ok(a.field_icon_color && /^#84725d$/i.test(a.field_icon_color.custom || ''), 'field icon keeps its colour');
ok(typeof a.button_preset === 'string' && /^btn-silk( btn-md)?$/.test(a.button_preset) && !a.accent_color, 'the submit wears the silk Button Preset (shared matcher), no one-off accent colour');
ok(/selector \.fw-nl__btn\{font-size:14px !important;text-transform:none !important;letter-spacing:normal !important;line-height:20px !important;font-weight:400 !important;height:54px !important/.test(css), "the submit keeps its OWN type (14px sentence-case, 54px) over the preset's");

console.log(fails ? `\n✗ ${fails} FAIL` : '\n✓ ALL PASS — newsletter signup parity guarded');
process.exit(fails ? 1 : 0);
