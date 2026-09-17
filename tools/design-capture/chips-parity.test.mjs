// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// CHIP ROW parity (browser-free). A flex row of short pill-shaped labels (capture-extract chipRowOf → a `chips`
// block) → ONE wrapping flex row (source gap + margin above) of Text Blocks, each stashing the SAME pill skin for
// the Box-Preset census, with its 10px uppercase tracked type — never a 3-column grid of bare text. PHP twin:
// tests/golden-fixture-1-test.php [G3]. Run: node chips-parity.test.mjs   (exit 1 on any failure)
import { toPages } from './to-pages.mjs';
import { buildBorderPresets } from './box-presets.mjs';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + msg); if (!cond) fails++; };

const chip = (text) => ({ t: 'text', html: '<div>' + text + '</div>', text, tag: 'div', cls: 'metric',
  fontSize: '10px', color: 'rgb(86, 75, 61)', lineHeight: '15px', letterSpacing: '2.2px', marginBottom: '0px', textAlign: 'start', fontWeight: '400', textTransform: 'uppercase',
  bg: 'rgba(255, 255, 255, 0.5)', bgImage: '', border: '1px solid rgba(131, 108, 74, 0.08)', borderRadius: '999px', boxShadow: '', padding: '12px 16px', backdrop: '', position: 'static' });
const cap = { url: 'http://x/', sections: [{ sectionClass: 'section', computed: { padding: '120px 0px', margin: '0px' }, blocks: [
  { t: 'heading', level: 2, html: 'Metrics', text: 'Metrics' },
  { t: 'chips', gap: '12px', align: '', mt: 28, mb: 0, items: [chip('Seasonal equilibrium'), chip('Water rhythm'), chip('Zen-organic harmonics')] },
] }] };
const out = toPages(cap, { hifiCss: true });
const find = (n) => { if (!n || typeof n !== 'object') return null; if (n.type === 'flexbox' && (n._items || []).length === 3 && n._items[0].shortcode === 'text_block') return n; for (const c of (n._items || [])) { const r = find(c); if (r) return r; } return null; };
let row = null; for (const s of (out?.pages?.[0]?.builder || [])) { row = find(s); if (row) break; }

console.log('\n=== chip row → flex row of boxed Text Blocks (PHP twin: golden [G3]) ===');
ok(!!row, 'chip row → ONE flex row of three text_blocks');
ok(row && row.atts.display === 'flex' && row.atts.wrap && row.atts.wrap.base === 'yes', 'chip row is a wrapping flex row');
ok(row && row.atts.gap && row.atts.gap.base === '[12px]', 'chip row gap = the source 12px');
ok(row && row.atts.spacing && row.atts.spacing.margin.top === 'mt-[28px]', 'chip row margin-top = the source 28px');
const c0 = row && row._items[0].atts, c2 = row && row._items[2].atts;
ok(c0 && !(c0.width && c0.width.base && /^\d+$/.test(String(c0.width.base.preset || ''))), 'chips carry NO width (they size to content, never equal thirds)');
ok(c0 && /Seasonal equilibrium/.test(c0.text || ''), 'chip text');
ok(c0 && c0._box && c0._box.radius === '999px' && c0._box.fill === 'rgba(255, 255, 255, 0.5)' && c0._box.padding === '12px 16px', 'each chip stashes its pill skin (fill / radius / padding) for the Box Preset');
ok(c0 && c2 && JSON.stringify(c0._box) === JSON.stringify(c2._box), 'all three chips share ONE skin (→ one preset)');
ok(c0 && /font-size:10px/.test(c0.custom_css || '') && /text-transform:uppercase/.test(c0.custom_css || '') && /letter-spacing:2\.2px/.test(c0.custom_css || ''), 'chip typography carried (10px, uppercase, tracked)');
ok(c0 && !/background-color|border-radius|padding:/.test(c0.custom_css || ''), 'chip base carries NO fill / radius / padding (the preset owns them)');
const bp = buildBorderPresets([c0._box, c2._box]);
const pill = bp.presets.find((p) => String(p.border_radius && p.border_radius.value) === '999');
ok(!!pill, 'the pill preset exists (one for the shared skin)');
ok(!!pill && /padding:12px 16px/.test(pill.custom_css || ''), 'pill preset padding 12px 16px (in the preset CSS)');
ok(!!pill && pill.states.default.background.color.value.custom === 'rgba(255, 255, 255, 0.5)', 'pill preset fill = 50% white');

console.log(fails ? `\n✗ ${fails} FAIL` : '\n✓ ALL PASS — chip row parity guarded');
process.exit(fails ? 1 : 0);
