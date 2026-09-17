// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// BAND INSET parity (browser-free). A plain-CSS shell wrapper between a section and its content band
// (`.section-shell{margin:0 24px}`, or a `px-6` wrapper) is flattened by the extractor's dive, which stamps its
// side inset on every block it produced as `mxAdd {l,r}` (nested wrappers add up; a centred cap is NOT an inset).
// The section shortcode renders a flexbox child with NO .fw-container, so that inset is the only thing keeping the
// band off the viewport edge — to-pages must carry it as the node's native Spacing margin (ms-/me- tokens): on a
// grid ROW band, on a special_heading, and (via scoped CSS) on a node without a Spacing option.
// PHP twin: tests/golden-fixture-1-test.php [I].   Run: node band-inset-parity.test.mjs   (exit 1 on any failure)
import { toPages } from './to-pages.mjs';
import { toThemeSettings } from './to-theme-settings.mjs';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + msg); if (!cond) fails++; };

const leaf = (t) => ({ t: 'text', html: '<p>' + t + '</p>', text: t, tag: 'p', cls: '', fontSize: '16px', color: 'rgb(38, 33, 28)', lineHeight: '24px', fontWeight: '400', textAlign: '', textTransform: 'none', letterSpacing: 'normal', marginTop: '0px', marginBottom: '0px' });
const head = (t, lvl, mx) => ({ t: 'heading', level: lvl, html: t, text: t, tag: 'h' + lvl, cls: '', wrapCls: '', fontSize: '44px', fontWeight: '400', color: 'rgb(38, 33, 28)', lineHeight: '48px', letterSpacing: 'normal', textAlign: '', marginTop: '0px', marginBottom: '12px', ...(mx ? { mxAdd: mx } : {}) });
const cell = (t, id) => ({ width: '1_2', cls: '', fullCls: '', colId: id, cw: 6, track: 700, html: '<div>…</div>', pad: { base: { top: 70, right: 70, bottom: 70, left: 70 } }, blocks: [head(t, 3), leaf('Body copy for the ' + t.toLowerCase() + ' cell.')] });
// story: shell(24) > grid row → the row carries mxAdd 24/24
const storyRow = { t: 'row', valign: '', gap: 28, gapResp: null, html: '<div class="split-grid">…</div>', mt: 0, mb: 0, tracks: '1.08fr 0.92fr', nowrap: true, mxAdd: { l: 24, r: 24 }, cols: [cell('Left', 'sccol-1'), cell('Right', 'sccol-2')] };
// fields: shell(24) > px-6(24) > h2 + p → the heading carries the SUM (48)
const fieldsHead = head('Staggered layers like terraced fields.', 2, { l: 48, r: 48 });
// a node WITHOUT a Spacing option (verbatim html) inside a shell → scoped CSS margin
const htmlLeaf = { t: 'html', html: '<div class="sc-tw"><svg viewBox="0 0 10 10"></svg></div>', mxAdd: { l: 24, r: 24 } };

const cap = { url: 'http://x/', sections: [
  { sectionClass: 'story',  computed: { padding: '120px 0px', margin: '0px' }, blocks: [storyRow] },
  { sectionClass: 'fields', computed: { padding: '120px 0px', margin: '0px' }, blocks: [fieldsHead] },
  { sectionClass: 'intro',  computed: { padding: '120px 0px', margin: '0px' }, blocks: [{ ...leaf('Intro copy under the heading.'), mxAdd: { l: 48, r: 48 } }] },
  { sectionClass: 'ring',   computed: { padding: '120px 0px', margin: '0px' }, blocks: [{ t: 'panel', box: { bg: 'rgba(255,255,255,0.5)', fill: 'rgba(255,255,255,0.5)', gradient: '', radius: '999px', borderWidth: '', borderStyle: '', borderColor: '', shadow: '', backdrop: '' }, pad: { base: { top: 40, right: 40, bottom: 40, left: 40 } }, width: '659px', maxw: '', aspect: '', align: 'center', selfCenter: true, centerH: true, centerV: false, shell: false, decor: [], mt: 0, mb: 0, mxAdd: { l: 24, r: 24 }, blocks: [head('A quiet center', 2)] }] },
  { sectionClass: 'decor',  computed: { padding: '120px 0px', margin: '0px' }, blocks: [htmlLeaf] },
] };
const out = toPages(cap, { hifiCss: true });
const secs = out.pages[0].builder.filter((n) => n.type === 'section');
const find = (n, pred) => { if (!n || typeof n !== 'object') return null; if (pred(n)) return n; for (const c of (n._items || [])) { const r = find(c, pred); if (r) return r; } return null; };
const css = (n) => (n && n.atts && n.atts.custom_css) || '';

console.log('\n=== band inset (PHP twin: golden [I]) ===');
const grid = secs[0]._items.find((n) => n.type === 'flexbox');
ok(!!grid, 'story: the split band is a flexbox directly under the section');
ok(grid && grid.atts.spacing && grid.atts.spacing.margin.left === 'ms-4', "story: the shell's 24px left margin → the band's native Spacing margin-left (ms-4)");
ok(grid && grid.atts.spacing && grid.atts.spacing.margin.right === 'me-4', 'story: …and margin-right (me-4)');
const cellA = grid && grid._items[0];
ok(cellA && !(cellA.atts.spacing && cellA.atts.spacing.margin.left), 'story: the CELLS carry no inset of their own (the band owns it)');
const h2 = find(secs[1], (n) => n.shortcode === 'special_heading');
ok(!!h2, 'fields: the heading was built');
ok(h2 && h2.atts.spacing && h2.atts.spacing.margin.left === 'ms-5' && h2.atts.spacing.margin.right === 'me-5', 'fields: nested wrappers ADD UP — 24 + 24 → ms-5 / me-5 (48px) on the heading');
const p = find(secs[2], (n) => n.shortcode === 'text_block');
ok(p && p.atts.spacing && p.atts.spacing.margin.left === 'ms-5', 'fields: the intro paragraph carries the same inset');
const ring = find(secs[3], (n) => n.type === 'flexbox' && /margin-left:auto/.test(css(n)));
ok(ring && !(ring.atts.spacing && ring.atts.spacing.margin.left), 'a SELF-CENTRED panel inside the shell keeps its auto margins — no inset (it would shove the ring left)');
const code = find(secs[4], (n) => n.shortcode === 'code_block' || (n.atts && /sc-tw/.test(String(n.atts.code || n.atts.content || ''))));
ok(code && (/(margin-left:24px;margin-right:24px;)/.test(css(code)) || (code.atts.spacing && code.atts.spacing.margin.left === 'ms-4')), 'a node with no Spacing option gets the inset as scoped CSS (or its Spacing when it has one)');

// The site container's DECLARED gutter (capture stamp → home.contentGutter) → the native Container Gutter, so the
// flexbox Content Width cap (min(cap, 100% - 2×gutter)) keeps the source inset at every viewport. PHP: declared_container_gutter.
const ts = toThemeSettings({ colors: { bg: '#f8f1e6', ink: '#26211c' } }, { contentGutter: 24, contentWidth: 1440 });
ok(ts && ts.values.general_layout && ts.values.general_layout.layout_container_gutter && ts.values.general_layout.layout_container_gutter.value === '24' && ts.values.general_layout.layout_container_gutter.unit === 'px', 'declared shell gutter (48px both sides) → Theme Settings Container Gutter 24px');
ok(ts && ts.values.general_layout && ts.values.general_layout.layout_container_width && ts.values.general_layout.layout_container_width.lg.value === '1440', 'a stamped site content width with no header/footer container → Container Width 1440');
const ts0 = toThemeSettings({ colors: { bg: '#fff', ink: '#000' } }, {});
ok(!(ts0 && ts0.values.general_layout && ts0.values.general_layout.layout_container_gutter), 'no declared gutter → the theme default is left alone');

console.log(fails ? `\n✗ ${fails} FAIL` : '\n✓ ALL PASS — band inset parity guarded');
process.exit(fails ? 1 : 0);
