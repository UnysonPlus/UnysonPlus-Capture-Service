// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SWEEP PSEUDO-LAYER parity (browser-free). A painted `::after` that MOVES — the `.silk::after` sheen: inset:-120%, a
// diagonal light gradient, a declared transform, `animation: sheen 8s ease-in-out infinite`, mix-blend-mode:screen,
// on a host that clips (overflow:hidden). The capture reads the DECLARED rule (a computed style is one mid-animation
// frame) plus the @keyframes it names, and stamps it as a `sweep` decor layer on the card. to-pages must emit it
// VERBATIM on the icon_box's scoped CSS: host clips + isolates, the pseudo paints above the content (no z-index:-1),
// the animation and its keyframes are renamed to a per-element `sc-<name>-<hash>` so two sites' "sheen" never collide.
// A layer whose keyframes could not be read carries NO animation (no dangling name); hostile keyframes are dropped.
// PHP twin: tests/golden-fixture-1-test.php [K].   Run: node sweep-pseudo-parity.test.mjs   (exit 1 on any failure)
import { toPages } from './to-pages.mjs';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + msg); if (!cond) fails++; };

const kf = '@keyframes sheen { \n  0% { transform: translateX(-140%) rotate(12deg); }\n  100% { transform: translateX(140%) rotate(12deg); }\n}';
const sweep = { pe: 'after', sweep: true, inset: '-120%', background: 'linear-gradient(120deg, transparent 44%, rgba(255, 255, 255, 0.78) 50%, transparent 56%)', transform: 'translateX(-140%) rotate(12deg)', animation: 'sheen 8s ease-in-out infinite', blend: 'screen', clip: true, keyframes: kf };
const card = (title, decor) => ({ width: '1_2', cls: 'silk', fullCls: 'silk', colId: 'c1', cw: 6, html: '<div class="silk">…</div>', card: { icon: '', customIcon: '', lucide: '', iconLayout: 'inline-left', iconColor: '', title, titleTag: 'h2', text: '<p>The light band sweeps across every eight seconds.</p>', link: null, center: false, box: { bg: 'rgb(251, 247, 240)', radius: '28px', borderWidth: '1px', borderStyle: 'solid', borderColor: 'rgba(95, 73, 42, 0.12)', shadow: 'rgba(20, 24, 34, 0.08) 0px 20px 50px 0px' }, decor } });
const row = (cols) => ({ t: 'row', valign: '', gap: 28, gapResp: null, html: '<div class="grid">…</div>', mt: 0, mb: 0, cols });
const cap = { url: 'http://x/', sections: [
  { sectionClass: 'cards', computed: { padding: '120px 0px', margin: '0px' }, blocks: [row([card('A card with a sweeping sheen', [sweep]), card('A plain card', [])])] },
  { sectionClass: 'nokf', computed: { padding: '120px 0px', margin: '0px' }, blocks: [row([card('No keyframes readable', [{ ...sweep, keyframes: '' }])])] },
  { sectionClass: 'hostile', computed: { padding: '120px 0px', margin: '0px' }, blocks: [row([card('Hostile keyframes', [{ ...sweep, keyframes: '@keyframes sheen { 0% { background: url(javascript:alert(1)) } }' }])])] },
] };
const out = toPages(cap, { hifiCss: true });
const secs = out.pages[0].builder.filter((n) => n.type === 'section');
const find = (n, pred) => { if (!n || typeof n !== 'object') return null; if (pred(n)) return n; for (const c of (n._items || [])) { const r = find(c, pred); if (r) return r; } return null; };
const css = (n) => (n && n.atts && n.atts.custom_css) || '';

console.log('\n=== sweep pseudo-layer (PHP twin: golden [K]) ===');
const ib = find(secs[0], (n) => n.shortcode === 'icon_box' && /sweeping sheen/.test(n.atts.title || ''));
ok(!!ib, 'the silk card → icon_box');
const m = css(ib).match(/animation:(sc-sheen-[a-f0-9]{6}) 8s ease-in-out infinite/);
ok(!!m, 'its ::after carries the declared animation under a per-element name (sc-sheen-<hash> 8s ease-in-out infinite)');
ok(m && css(ib).includes('@keyframes ' + m[1] + ' {') && /translateX\(140%\) rotate\(12deg\)/.test(css(ib)), 'the @keyframes ride along, renamed to the same per-element name');
ok(/selector::after\{content:"";position:absolute;pointer-events:none;inset:-120%;background:linear-gradient\(120deg/.test(css(ib)), 'the pseudo keeps inset:-120% + the light gradient (no width/height, no z-index:-1 — it paints above the content)');
ok(/transform:translateX\(-140%\) rotate\(12deg\);/.test(css(ib)) && /mix-blend-mode:screen;/.test(css(ib)), 'the declared start transform + screen blend are kept');
ok(/selector\{position:relative;isolation:isolate;overflow:hidden;\}/.test(css(ib)), 'the host clips (overflow:hidden) + isolates, so the oversize band never spills');
const plain = find(secs[0], (n) => n.shortcode === 'icon_box' && /plain card/.test(n.atts.title || ''));
ok(plain && !/::after/.test(css(plain)), 'a card with no pseudo-layer gets nothing');
const nokf = find(secs[1], (n) => n.shortcode === 'icon_box');
ok(nokf && /::after\{/.test(css(nokf)) && !/animation:/.test(css(nokf)) && !/@keyframes/.test(css(nokf)), 'no readable keyframes → the static layer stays, with NO dangling animation');
const host = find(secs[2], (n) => n.shortcode === 'icon_box');
ok(host && !/url\(|javascript/.test(css(host)) && !/@keyframes/.test(css(host)), 'hostile keyframes are dropped entirely');

console.log(fails ? `\n✗ ${fails} FAIL` : '\n✓ ALL PASS — sweep pseudo-layer parity guarded');
process.exit(fails ? 1 : 0);
