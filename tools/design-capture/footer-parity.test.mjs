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

// EVERY footer row (nav links + contact rows) is now the UNIFIED `list_item` element. No `link`,
// `icon_text`, or `<ul>`/contact HTML blobs. 2 menu groups × 2 children = 4 nav + 3 contact = 7 list items.
const listEls = allEls.filter((et) => et.element === 'list_item');
ok(listEls.length >= 7, `rows are unified list_item elements (found ${listEls.length}, expected >= 7)`);
ok(!allEls.some((et) => et.element === 'link' || et.element === 'icon_text'), 'NO legacy link / icon_text elements emitted');
const anyBlob = allEls.some((et) => et.element === 'text' && et.text && /<ul\b|fw-footer-links|fw-footer-contact/.test(String(et.text.text_content || '')));
ok(!anyBlob, 'NO <ul> / contact HTML blob inside a Text element');

// list_item payload shape: li_text + tinted inline-svg li_icon + tel/mailto/url li_link_type.
const li = listEls.map((et) => et.list_item);
const phoneRow = li.find((it) => it && /555/.test(String(it.li_text || '')));
ok(phoneRow && phoneRow.li_link_type === 'phone', 'tel: row → li_link_type "phone"');
const addrRow = li.find((it) => it && /Meadow/.test(String(it.li_text || '')));
ok(addrRow && addrRow.li_icon && addrRow.li_icon['svg-source'] === 'inline' && /21c45d/i.test(String(addrRow.li_icon.markup || '')), 'address row → inline-svg icon tinted with source colour');
const mailRow = li.find((it) => it && /maison\.com/.test(String(it.li_text || '')));
ok(mailRow && mailRow.li_link_type === 'email', 'mailto: row → li_link_type "email"');
const navRow = li.find((it) => it && /Home|About|Shop|Blog/.test(String(it.li_text || '')));
ok(navRow && navRow.li_link_type === 'url', 'nav row → li_link_type "url"');

console.log(fails ? `\nFAILED (${fails})` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
