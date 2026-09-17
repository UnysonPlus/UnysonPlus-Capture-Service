// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// HEADING RHYTHM parity (browser-free). An eyebrow + h2 + body-size intro paragraph → ONE special_heading whose
// Overline keeps its exact type and the title's margin-top as its gap; the subtitle keeps 16px / 32px (no Text
// Style preset matches); the title→subtitle gap comes from the SUBTITLE's margin-top; an explicit zero subtitle
// bottom margin → mb-0; a declared clamp() title size stays fluid. PHP twin: tests/golden-fixture-1-test.php [G4].
// Run: node heading-rhythm-parity.test.mjs   (exit 1 on any failure)
import { toPages } from './to-pages.mjs';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + msg); if (!cond) fails++; };

const blocks = (fsDecl) => [
  { t: 'overline', html: 'Floating Mountain Split', text: 'Floating Mountain Split', cls: 'section-label', pill: false, color: 'rgb(138, 124, 105)', bg: 'rgba(0, 0, 0, 0)', borderW: '0px', borderColor: '', radius: '0px', padding: '0px', backdropFilter: '', textTransform: 'uppercase', fontSize: '10px', lineHeight: '15px', letterSpacing: '3px', fontWeight: '400', gap: 'normal', iconSvg: '', iconPos: 'before' },
  { t: 'heading', level: 2, html: 'Designed to breathe with the river.', text: 'Designed to breathe with the river.', tag: 'h2', cls: 'section-title serif', wrapCls: '', fsDecl, ...(fsDecl ? { lhDecl: '.9', lsDecl: '-.06em' } : {}), fontSize: '80.64px', fontWeight: '400', color: 'rgb(42, 36, 28)', marginBottom: '0px', marginTop: '16px', lineHeight: '72.576px', letterSpacing: '-4.8384px', align: 'left' },
  { t: 'text', html: '<p>The landscape follows the natural movement of the valley, layering soft mountain silhouettes.</p>', text: 'The landscape follows the natural movement of the valley, layering soft mountain silhouettes.', tag: 'p', cls: 'section-copy',
    fontSize: '16px', color: 'rgb(98, 88, 77)', lineHeight: '32px', letterSpacing: 'normal', marginBottom: '0px', marginTop: '22px', textAlign: 'start', fontWeight: '400', bg: '', bgImage: '', border: '', borderRadius: '0px', boxShadow: '', padding: '0px', backdrop: '', position: 'static' },
];
const cap = (fsDecl) => ({ url: 'http://x/', sections: [{ sectionClass: 'section', computed: { padding: '120px 0px', margin: '0px' }, blocks: blocks(fsDecl) }] });
const findSh = (n) => { if (!n || typeof n !== 'object') return null; if (n.shortcode === 'special_heading') return n; for (const c of (n._items || [])) { const r = findSh(c); if (r) return r; } return null; };
const shOf = (out) => { for (const s of (out?.pages?.[0]?.builder || [])) { const r = findSh(s); if (r) return r; } return null; };

console.log('\n=== heading rhythm (PHP twin: golden [G4]) ===');
{
  const sh = shOf(toPages(cap('clamp(2.9rem,5.6vw,6rem)'), { hifiCss: true }));
  const a = sh && sh.atts; const css = (a && a.custom_css) || '';
  ok(!!sh, 'special_heading found');
  ok(a && a.overline === 'Floating Mountain Split', 'eyebrow → native Overline');
  ok(a && a.overline_uppercase === 'yes', 'overline uppercase (native)');
  ok(/selector \.heading-overline\{[^}]*font-size:10px !important[^}]*letter-spacing:3px !important[^}]*line-height:15px !important[^}]*margin-bottom:16px !important/.test(css), "overline exact type + the title's 16px margin-top as its gap");
  ok(a && /The landscape follows/.test(a.subtitle || ''), 'subtitle folded');
  ok(/selector \.heading-title\{margin-bottom:22px !important;\}/.test(css), "title→subtitle gap = the SUBTITLE's 22px margin-top");
  ok(/selector \.heading-subtitle\{[^}]*font-size:16px !important[^}]*line-height:32px !important/.test(css), 'body-size subtitle keeps 16px / 32px (no preset matched)');
  ok(/selector \.heading-title\{font-size:clamp\(2\.9rem,5\.6vw,6rem\) !important;line-height:\.9 !important;letter-spacing:-\.06em !important;\}/.test(css), 'declared clamp() title size carried (fluid) + its RELATIVE line-height / letter-spacing');
  ok(!a.display_size && !/font-size:80\.64px/.test(css), 'a fluid title is never pinned to a display preset or its px snapshot');
  ok(a && a.spacing && a.spacing.margin && a.spacing.margin.bottom === 'mb-0', "explicit zero subtitle bottom margin → the block's outer margin-bottom = 0");
}
console.log('\n=== NEGATIVE: a static px title carries no fluid rule ===');
{
  const sh = shOf(toPages(cap(''), { hifiCss: true }));
  ok(sh && !/clamp\(/.test(sh.atts.custom_css || ''), 'no fsDecl → no fluid font-size rule');
}

console.log(fails ? `\n✗ ${fails} FAIL` : '\n✓ ALL PASS — heading rhythm parity guarded');
process.exit(fails ? 1 : 0);
