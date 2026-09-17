// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// CORE PANEL parity (browser-free). A centred RING (a skinned panel: radial fill, hairline, glow + inset shadow, width
// min(78vw,42rem), aspect-ratio 1, two decor pseudo-layers — an inner hairline ring and a blurred bloom — content centred)
// holding a CARD (a skinned panel: translucent fill, hairline, shadow, radius 32, padding 26/28, width min(78vw,620px),
// text centred) holding eyebrow → fluid h2 → p → a centred chip row. Rules: a skinned wrapper around content is a panel
// (a flexbox column wearing its Box Preset); nested panels recurse; the sheet's width / aspect expressions ride as
// scoped CSS; centring is native; every decor layer survives (bordered ones too); a non-linear fill rides in the
// preset CSS; the eyebrow→title gap is exact (zero). PHP twin: tests/golden-fixture-1-test.php [R].
// Run: node core-panel-parity.test.mjs   (exit 1 on any failure)
import { toPages } from './to-pages.mjs';
import { buildBorderPresets } from './box-presets.mjs';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + msg); if (!cond) fails++; };

const ringGrad = 'radial-gradient(circle, rgba(255, 255, 255, 0.72), rgba(255, 255, 255, 0.22) 56%, rgba(255, 255, 255, 0.06) 74%, rgba(0, 0, 0, 0) 76%)';
const chip = (t) => ({ t: 'text', html: '<p>' + t + '</p>', text: t, tag: 'span', cls: '', fontSize: '10px', color: 'rgb(94, 82, 69)', lineHeight: '15px', letterSpacing: '2px', marginBottom: '0px', marginTop: '0px', textAlign: 'center', fontWeight: '400', textTransform: 'uppercase', bg: 'rgba(255, 255, 255, 0.56)', bgImage: '', border: '1px solid rgba(131, 108, 74, 0.08)', borderRadius: '999px', boxShadow: '', padding: '12px 16px', backdrop: '', position: 'static', maxWidth: 'none' });
const card = { t: 'panel', box: { bg: 'rgba(255, 255, 255, 0.28)', fill: 'rgba(255, 255, 255, 0.28)', gradient: '', radius: '32px', borderWidth: '1px', borderStyle: 'solid', borderColor: 'rgba(131, 108, 74, 0.08)', shadow: 'rgba(98, 78, 45, 0.08) 0px 18px 40px 0px', backdrop: '', padding: '', clip: false },
  pad: { base: { top: 26, right: 28, bottom: 26, left: 28 } }, width: 'min(78vw, 620px)', maxw: '', aspect: '', align: 'center', selfCenter: true, centerH: false, centerV: false, decor: [], mt: 0, mb: 0,
  blocks: [
    { t: 'overline', html: 'Golden Core', text: 'Golden Core', cls: 'section-label', pill: false, color: 'rgb(138, 124, 105)', bg: 'rgba(0, 0, 0, 0)', borderW: '0px', borderColor: '', radius: '0px', padding: '0px', backdropFilter: '', textTransform: 'uppercase', fontSize: '10px', lineHeight: '15px', letterSpacing: '3px', fontWeight: '400', gap: 'normal', iconSvg: '', iconPos: 'before', align: 'center' },
    { t: 'heading', level: 2, html: 'A quiet center for the entire landscape.', text: 'A quiet center for the entire landscape.', tag: 'h2', cls: 'serif', wrapCls: '', fsDecl: 'clamp(2.6rem,5vw,5.4rem)', lhDecl: '.92', lsDecl: '-.06em', fontSize: '72px', fontWeight: '400', color: 'rgb(42, 36, 28)', marginBottom: '0px', marginTop: '0px', lineHeight: '66.24px', letterSpacing: '-4.32px', align: 'center' },
    { t: 'text', html: '<p>Cyclical irrigation, light harvest, and soil balance converge here as a single living system rather than a set of isolated assets.</p>', text: 'Cyclical irrigation, light harvest, and soil balance converge here as a single living system rather than a set of isolated assets.', tag: 'p', cls: '', fontSize: '16px', color: 'rgb(98, 88, 77)', lineHeight: '32px', letterSpacing: 'normal', marginBottom: '0px', marginTop: '18px', textAlign: 'center', fontWeight: '400', bg: '', bgImage: '', border: '', borderRadius: '0px', boxShadow: '', padding: '0px', backdrop: '', position: 'static', maxWidth: 'none', align: 'center' },
    { t: 'chips', gap: '12px', align: 'center', mt: 24, mb: 0, items: [chip('Soil vitality 84%'), chip('Water reserve 92%'), chip('Harvest pulse stable')] },
  ] };
const ring = { t: 'panel', box: { bg: '', fill: '', gradient: ringGrad, radius: '999px', borderWidth: '1px', borderStyle: 'solid', borderColor: 'rgba(131, 108, 74, 0.08)', shadow: 'rgba(86, 120, 168, 0.08) 0px 0px 120px 0px, rgba(255, 255, 255, 0.12) 0px 0px 70px 0px inset', backdrop: '', padding: '', clip: false },
  pad: { base: { top: 0, right: 0, bottom: 0, left: 0 } }, width: 'min(78vw, 42rem)', maxw: '', aspect: '1', align: '', selfCenter: true, centerH: true, centerV: true, mt: 0, mb: 0,
  decor: [
    { pe: 'before', top: '14%', left: '14%', width: '72%', height: '72%', border: '1px solid rgba(131, 108, 74, 0.08)', shadow: 'rgba(215, 170, 97, 0.06) 0px 0px 40px 0px inset', radius: '999px' },
    { pe: 'after', top: '28%', left: '28%', width: '44%', height: '44%', background: 'radial-gradient(circle, rgba(215, 170, 97, 0.18), rgba(0, 0, 0, 0) 58%)', filter: 'blur(10px)', radius: '999px' },
  ], blocks: [card] };
const cap = { url: 'http://x/', sections: [{ sectionClass: 'terrain-core', computed: { padding: '120px 0px', margin: '0px' }, blocks: [ring] }] };
const out = toPages(cap, { hifiCss: true });
const sec = out.pages[0].builder.find((n) => n.type === 'section');
const find = (n, pred) => { if (!n || typeof n !== 'object') return null; if (pred(n)) return n; for (const c of (n._items || [])) { const r = find(c, pred); if (r) return r; } return null; };
const css = (n) => (n && n.atts && n.atts.custom_css) || '';

console.log('\n=== core panel (PHP twin: golden [R]) ===');
const rn = find(sec, (n) => n.type === 'flexbox' && /aspect-ratio:1/.test(css(n)));
ok(!!rn, 'ring → a flexbox column wearing its skin (aspect-ratio 1 scoped)');
ok(rn && /selector\{width:min\(78vw, 42rem\);max-width:100%;aspect-ratio:1;margin-left:auto;margin-right:auto;\}/.test(css(rn)), "ring keeps the sheet's width expression + aspect, centred by its parent (margin auto)");
ok(rn && rn.atts.justify_content && rn.atts.justify_content.base === 'center' && rn.atts.align_items && rn.atts.align_items.base === 'center', 'ring centres its content (native justify/align center)');
ok(rn && rn.atts._box && rn.atts._box.gradient === ringGrad, 'ring skin carries the radial fill');
ok(rn && /selector::before\{[^}]*border:1px solid rgba\(131, 108, 74, 0\.08\)[^}]*box-shadow:rgba\(215, 170, 97, 0\.06\) 0px 0px 40px 0px inset[^}]*border-radius:999px/.test(css(rn)), 'inner hairline ring (a BORDERED decor layer) survives as ::before');
ok(rn && /selector::after\{[^}]*background:radial-gradient\(circle, rgba\(215, 170, 97, 0\.18\)[^}]*filter:blur\(10px\)/.test(css(rn)), 'blurred bloom survives as ::after');
const cn = rn && find(rn, (n) => n !== rn && n.type === 'flexbox' && /padding-top:26px/.test(css(n)));
ok(!!cn, 'card → a nested flexbox column with its 26/28 padding');
ok(cn && /selector\{width:min\(78vw, 620px\);max-width:100%;margin-left:auto;margin-right:auto;\}/.test(css(cn)), 'card keeps its width cap, centred');
ok(cn && cn.atts.text_align === 'center' && cn.atts._box && cn.atts._box.radius === '32px' && cn.atts._box.bg === 'rgba(255, 255, 255, 0.28)', 'card text centred + skin (radius 32, translucent fill)');
const sh = cn && find(cn, (n) => n.shortcode === 'special_heading');
ok(sh && sh.atts.overline === 'Golden Core' && sh.atts.title === 'A quiet center for the entire landscape.' && /Cyclical irrigation/.test(sh.atts.subtitle || ''), 'eyebrow → h2 → p fold into one special heading');
ok(sh && /selector \.heading-title\{font-size:clamp\(2\.6rem,5vw,5\.4rem\) !important;line-height:\.92 !important;letter-spacing:-\.06em !important;\}/.test(css(sh)), 'fluid h2 keeps its clamp() + relative metrics');
ok(sh && /selector \.heading-overline\{[^}]*margin-bottom:0px !important/.test(css(sh)), 'eyebrow→title gap is exactly 0 (the theme default must not open it)');
const chips = cn && find(cn, (n) => n.type === 'flexbox' && n.atts.justify_content && n.atts.justify_content.base === 'center' && (n._items || []).length === 3);
ok(!!chips, 'chip row → a centred flex row of three chips');
ok(chips && chips.atts.spacing && chips.atts.spacing.margin.top === 'mt-4', 'chip row margin-top 24');
// The census: the ring's radial fill lands in its preset CSS (no native field for a non-linear gradient).
const bp = buildBorderPresets([rn.atts._box, cn.atts._box]).presets;
const ringP = bp.find((p) => /radial-gradient/.test(p.custom_css || ''));
ok(!!ringP && /\{\{SELECTOR\}\}\{background-image:radial-gradient\(circle, rgba\(255, 255, 255, 0\.72\)/.test(ringP.custom_css), "ring's radial fill rides in the Box Preset CSS");

console.log(fails ? `\n✗ ${fails} FAIL` : '\n✓ ALL PASS — core panel parity guarded');
process.exit(fails ? 1 : 0);
