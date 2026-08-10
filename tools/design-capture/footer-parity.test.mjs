// Footer element-TYPE parity guard (browser-free). Feeds a synthetic footer config through the real
// toThemeSettings() and asserts each footer column maps to the correct NATIVE element type — matching the
// PHP Stitch footer_group_to_column()/build_footer_bar(). Locks the JS↔PHP drift the audit flagged: the
// CONTACT column must be native `icon_text` rows, NOT an HTML blob inside one Text element.
//
// Run: node footer-parity.test.mjs   (exit 1 on any failure)
import { toThemeSettings } from './to-theme-settings.mjs';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + msg); if (!cond) fails++; };

const config = {
  colors: { bg: '#1a1a1a', ink: '#eee' },
  footer: {
    menu: [
      { label: 'Quick Links', url: '#', children: [{ label: 'Home', url: '/' }, { label: 'About', url: '/about' }] },
      { label: 'Explore', url: '#', children: [{ label: 'Shop', url: '/shop' }, { label: 'Blog', url: '/blog' }] },
    ],
    contact: { title: 'Contact', rows: [
      { icon: '<svg viewBox="0 0 24 24" stroke="currentColor"><path d="M12 2"/></svg>', color: '#21c45d', text: '123 Fresh Meadow Lane', link: '' },
      { icon: '<svg viewBox="0 0 24 24" stroke="currentColor"><path d="M2 6"/></svg>', color: '#21c45d', text: '+1 (555) 123-4567', link: 'tel:+15551234567' },
      { icon: '', text: 'hello@maison.com', link: 'mailto:hello@maison.com' },
    ] },
    social: [],
    copyright: '© 2026 Maison',
  },
};

const ts = toThemeSettings(config, {});
const values = ts && ts.values ? ts.values : ts;
const mfc = values.main_footer_columns;

console.log('\n=== footer element-type parity ===');
ok(!!mfc && mfc.count, 'main_footer_columns emitted');

// Flatten every element across all footer columns.
const bar = mfc ? mfc[mfc.count] : {};
const allEls = Object.keys(bar)
  .filter((k) => /_col_\d+$/.test(k))
  .flatMap((k) => (Array.isArray(bar[k]) ? bar[k] : []))
  .map((n) => n && n.element_type)
  .filter(Boolean);

const iconTextEls = allEls.filter((et) => et.element === 'icon_text');
ok(iconTextEls.length >= 2, `contact rows are native icon_text elements (found ${iconTextEls.length}, expected >= 2)`);

const anyContactBlob = allEls.some((et) => et.element === 'text' && et.text && /fw-footer-contact/.test(String(et.text.text_content || '')));
ok(!anyContactBlob, 'NO fw-footer-contact HTML blob (the old drift) present');

// icon_text payload shape: text + tinted inline-svg icon + tel/mailto link type.
const phoneRow = iconTextEls.map((et) => et.icon_text).find((it) => it && /555/.test(String(it.icontext_text || '')));
ok(phoneRow && phoneRow.icontext_link_type === 'phone', 'tel: row → icontext_link_type "phone"');
const addrRow = iconTextEls.map((et) => et.icon_text).find((it) => it && /Meadow/.test(String(it.icontext_text || '')));
ok(addrRow && addrRow.icontext_icon && addrRow.icontext_icon['svg-source'] === 'inline' && /21c45d/i.test(String(addrRow.icontext_icon.markup || '')), 'address row → inline-svg icon tinted with source colour');
const mailRow = iconTextEls.map((et) => et.icon_text).find((it) => it && /maison\.com/.test(String(it.icontext_text || '')));
ok(mailRow && mailRow.icontext_link_type === 'email', 'mailto: row → icontext_link_type "email"');

console.log(fails ? `\nFAILED (${fails})` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
