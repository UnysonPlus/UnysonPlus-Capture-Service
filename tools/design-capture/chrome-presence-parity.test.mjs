// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// CHROME PRESENCE parity (browser-free). A capture with no footer → the page entry asks the importer for the theme's native
// per-page 'Hide Site Footer' switch (hide_site_footer = yes); a capture with a footer asks for nothing; no header → hide the
// site header. PHP twin: tests/golden-fixture-1-test.php [P]. Run: node chrome-presence-parity.test.mjs
import { toPages } from './to-pages.mjs';
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + msg); if (!cond) fails++; };
const sec = { sectionClass: 'section', computed: { padding: '120px 0px', margin: '0px' }, blocks: [{ t: 'heading', level: 2, html: 'Closing band', text: 'Closing band', tag: 'h2', cls: '', wrapCls: '', fontSize: '48px', align: 'left' }] };
const mk = (extra) => toPages({ url: 'http://x/', sections: [sec], ...extra }, { hifiCss: true }).pages[0].page_options || {};
console.log('\n=== chrome presence (PHP twin: golden [P]) ===');
const a = mk({ header: { nav: [] }, footer: null });
ok(a.hide_site_footer === 'yes' && !a.hide_site_header, 'no footer in the capture → hide_site_footer = yes (header kept)');
const b = mk({ header: { nav: [] }, footer: { columns: [] } });
ok(!b.hide_site_footer && !b.hide_site_header, 'a capture with a footer asks for nothing');
const c = mk({ header: null, footer: { columns: [] } });
ok(c.hide_site_header === 'yes', 'no header in the capture → hide_site_header = yes');
console.log(fails ? `\n✗ ${fails} FAIL` : '\n✓ ALL PASS — chrome presence parity guarded');
process.exit(fails ? 1 : 0);
