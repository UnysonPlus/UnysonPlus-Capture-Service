// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// PER-SECTION CONTENT BAND parity (browser-free). These sources cap their content on a centred CHILD
// (`<section class="px-6 py-20"><div class="max-w-3xl mx-auto">`), which neither the section's own
// computed max-width nor its class list can see — so every such section came back UNCAPPED and inherited
// the site-wide container, rendering wider than the source. capture-extract now MEASURES the band
// (`sec.bandW`) and to-pages prefers it. PHP twin: tests/golden-fixture-1-test.php [SB].
// Run: node section-band-parity.test.mjs
import { toPages } from './to-pages.mjs';

let fails = 0;
const ok = (c, m, got) => { console.log((c ? '  ✓ ' : '  ✗ FAIL ') + m + (c ? '' : '  (got: ' + JSON.stringify(got) + ')')); if (!c) fails++; };
const eq = (m, want, got) => ok(JSON.stringify(want) === JSON.stringify(got), m + ' == ' + JSON.stringify(want), got);

const sectionWith = (extra) => ({ url: 'http://x/', sections: [Object.assign({
  sectionClass: 'px-6 py-20', computed: { padding: '80px 24px', margin: '0px' },
  blocks: [{ t: 'heading', tag: 'h2', level: 2, html: 'Title', text: 'Title', cls: '', align: 'center',
             fontSize: '40px', fontWeight: '700', lineHeight: '48px', marginTop: '0px', marginBottom: '0px' },
           { t: 'text', html: '<p>Body copy long enough to be a real paragraph of text.</p>',
             text: 'Body copy long enough to be a real paragraph of text.', cls: '', align: 'center' }],
}, extra)] });

const cwOf = (extra) => {
  const pages = toPages(sectionWith(extra));
  const page = Array.isArray(pages) ? pages[0] : (pages.pages ? pages.pages[0] : pages);
  const tree = page.builder || page;
  const sec = (Array.isArray(tree) ? tree : []).find((n) => n && n.type === 'section');
  return sec ? (sec.atts || {}).container_width : undefined;
};

console.log('\n=== per-section content band (PHP twin: golden [SB]) ===');

eq('a MEASURED 768 band becomes narrow', { preset: 'narrow' }, cwOf({ bandW: 768 }));
eq('a MEASURED 1024 band becomes wide', { preset: 'wide' }, cwOf({ bandW: 1024 }));
// The step list started at 768, so a 576 band was rounded UP and rendered a third too wide.
eq('a 576 band gets its OWN preset, not rounded up to narrow', { preset: 'content-576' }, cwOf({ bandW: 576 }));
eq('an off-scale 1400 band mints a content preset', { preset: 'content-1400' }, cwOf({ bandW: 1400 }));
// Below the floor the measurement is not a band at all; fall through rather than inventing one.
ok(!cwOf({ bandW: 120 }), 'a below-floor measurement is ignored', cwOf({ bandW: 120 }));
ok(!cwOf({}), 'no band and no cap → inherit the site container', cwOf({}));
// The section's own cap still works when there is no measured band (the pre-existing path).
eq('the section OWN max-w-3xl class still caps it', { preset: 'narrow' }, cwOf({ sectionClass: 'px-6 py-20 max-w-3xl mx-auto' }));
eq('a measured band WINS over the class', { preset: 'wide' }, cwOf({ bandW: 1024, sectionClass: 'px-6 py-20 max-w-3xl' }));

console.log(fails === 0 ? '\n✓ ALL PASS — the measured per-section band reaches container_width\n' : '\n✗ ' + fails + ' FAILURE(S)\n');
process.exit(fails === 0 ? 0 : 1);
