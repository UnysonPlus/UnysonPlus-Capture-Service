// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// THE NOCTURNAL AUDIT parity (browser-free; 2026-09-16). A plain-CSS dark source: a 12-track BENTO grid (tiles spanning
// 8 / 4 tracks across three visual rows) was built as one row of slivers; a hero intro's `padding-bottom:240px` (the gap
// before the CTAs) was dropped; a button's ::before / ::after layers, the hover state of each, the hover shadow and the
// @keyframes never reached the preset. The browser-side twins (capture-extract bentoRowsOf, the capture's nested-rule hover
// harvest + keyframes) run in the corpus; what to-pages / to-theme-settings must guarantee from the capture record is here.
// PHP twin: tests/golden-fixture-1-test.php [R].   Run: node nocturnal-parity.test.mjs   (exit 1 on any failure)
import { toPages } from './to-pages.mjs';
import { buildButtonPresets } from './to-theme-settings.mjs';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + msg); if (!cond) fails++; };
const find = (n, pred) => { if (!n || typeof n !== 'object') return null; if (pred(n)) return n; for (const c of (n._items || [])) { const r = find(c, pred); if (r) return r; } return null; };
const mg = (n) => (n && n.atts && n.atts.spacing && n.atts.spacing.margin) || {};

console.log('\n=== THE NOCTURNAL AUDIT (PHP twin: golden [R]) ===');
{
  // (3) the intro paragraph's padding-bottom is the fold's below gap
  const cap = { url: 'http://x/', sections: [{ sectionClass: 'hero', computed: { padding: '110px 24px 42px', margin: '0px' }, blocks: [
    { t: 'heading', tag: 'h1', level: 1, html: 'Aether House', text: 'Aether House', cls: '', align: 'center', fontSize: '118px', fontWeight: '400', lineHeight: '106px', marginTop: '0px', marginBottom: '0px' },
    { t: 'text', html: '<p>Crafting the nocturnal web through artisanal digital architecture.</p>', text: 'Crafting the nocturnal web through artisanal digital architecture.', cls: '', align: 'center', fontSize: '16px', lineHeight: '31px', marginTop: '26px', marginBottom: '0px', paddingBottom: '240px' },
  ] }] };
  const out = toPages(cap, { hifiCss: true });
  const h1 = find(out.pages[0].builder[0], (n) => n.shortcode === 'special_heading');
  ok(h1 && mg(h1).bottom === 'mb-[240px]', "hero: the intro's OWN padding-bottom (240px) is the heading's below gap (the CTAs sit where the source puts them)");
}
{
  // (1) a bento stack of rows keeps each row's cell widths + tile heights
  const tile = (title, cw, minH) => ({ width: '', cls: '', fullCls: 'project', colId: 'c' + title.length, cw, minH, html: '<article>…</article>', card: { icon: '', customIcon: '', lucide: '', iconLayout: 'inline-left', iconColor: '', title, titleTag: 'h3', text: '<p>Typography-led landing pages.</p>', link: null, center: false, box: { bg: 'rgba(255, 255, 255, 0.05)', fill: 'rgba(255, 255, 255, 0.05)', gradient: '', radius: '24px', borderWidth: '0px', borderStyle: 'none', borderColor: '', shadow: '', backdrop: '', padding: '22px' } } });
  const row = (cols) => ({ t: 'row', valign: '', gap: 16, gapResp: null, html: '', mt: 0, mb: 0, nowrap: true, cols });
  const stack = { t: 'stack', gap: '16px', mt: 0, mb: 0, bento: true, items: [ row([tile('Midnight journal', 8, 320), tile('Editorial toolkits', 4, 320)]), row([tile('High-trust boutique', 4, 246), tile('Dark-mode design', 8, 246)]) ] };
  const out = toPages({ url: 'http://x/', sections: [{ sectionClass: 'projects', computed: { padding: '120px 24px', margin: '0px' }, blocks: [stack] }] }, { hifiCss: true });
  const sec = out.pages[0].builder[0];
  const boxes = []; const walk = (n) => { if (n.shortcode === 'icon_box') boxes.push(n); (n._items || []).forEach(walk); }; walk(sec);
  ok(boxes.length === 4, 'bento: four tiles → four icon_boxes across two rows');
  const rowOf = (t) => find(sec, (n) => n.type === 'flexbox' && (n._items || []).length === 2 && JSON.stringify(n).includes(t) && !JSON.stringify(n).includes(t === 'Midnight' ? 'High-trust' : 'Midnight'));
  const w = (r, i) => r && r._items[i] && r._items[i].atts.width && (r._items[i].atts.width.base || {}).preset;
  const r1 = rowOf('Midnight'), r2 = rowOf('High-trust');
  ok(r1 && w(r1, 0) === '8' && w(r1, 1) === '4' && r2 && w(r2, 0) === '4' && w(r2, 1) === '8', '…row 1 = 8 / 4, row 2 = 4 / 8 (each row keeps its own cell widths)');
  ok(r1 && JSON.stringify(r1._items[0].atts).includes('320') && r2 && JSON.stringify(r2._items[0].atts).includes('246'), "…each tile keeps its measured height as the cell's min-height");
}
{
  // (7) a button's full css → the preset
  const hov = 'before{content:"";position:absolute;inset:0px;transition:0.45s;background-image:radial-gradient(circle, rgba(255, 189, 98, 0.14), transparent 36%);opacity:0}|after{content:"";position:absolute;inset:-120%;transform:translateX(-140%) rotate(10deg);background-image:linear-gradient(120deg, transparent 44%, rgba(255, 193, 103, 0.52) 50%, transparent 56%);animation:9s ease-in-out 0s infinite normal none running sheen;animation-name:sheen}|hover-self{transform:translateY(-3px);box-shadow:rgba(255, 189, 98, 0.18) 0px 0px 0px 1px, rgba(0, 0, 0, 0.34) 0px 22px 60px}|hover-before{opacity:1}';
  const bp = buildButtonPresets({ buttonSkins: [{ role: 'Fill', cls: 'lantern-core', bg: 'rgb(20, 22, 24)', fg: 'rgb(255, 255, 255)', bd: '', bw: '', fs: '10px', px: '22px', py: '0px', radius: '999px', shadow: 'rgba(0, 0, 0, 0.28) 0px 18px 60px 0px', hov, kf: '@keyframes sheen { 100% { transform: translateX(240%) rotate(10deg); } }', tr: 'transform 0.45s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.45s' }] });
  const css = String((bp.button_colors[0] || {}).custom_css || '');
  ok(css.includes('{{SELECTOR}}::before {') && css.includes('opacity:0') && css.includes('{{SELECTOR}}::after {') && css.includes('translateX(-140%) rotate(10deg)'), "button: the preset carries the source's ::before (a glow) and ::after (a sheen) layers verbatim");
  ok(css.includes('{{SELECTOR}}:hover::before { opacity:1; }') && /\{\{SELECTOR\}\}:hover \{ box-shadow: rgba\(255, 189, 98, 0\.18\)/.test(css), '…the hover state of a layer and the hover shadow');
  ok(css.includes('@keyframes sheen') && css.includes('{{SELECTOR}} { position: relative; overflow: hidden; isolation: isolate; }'), '…the @keyframes the sheen animates with, and the button positioned + clipped');
  ok(!/expression\(|<\//.test(css), 'NEG: nothing hostile rides along');
}

console.log(fails ? `\n✗ ${fails} FAIL` : '\n✓ ALL PASS — nocturnal audit parity guarded');
process.exit(fails ? 1 : 0);
