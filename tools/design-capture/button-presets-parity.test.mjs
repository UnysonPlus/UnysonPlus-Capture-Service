// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Button colour/size preset parity guard (browser-free). Feeds synthetic button SKINS — the exact shape
// capture-extract.mjs stamps on home.buttonSkins — through the real buildButtonPresets() and asserts the
// two rules that regressed and were re-fixed:
//
//   1. GRADIENT FILL  — a `.btn-primary { background: linear-gradient(180deg, …) }` paints via
//      background-IMAGE (its background-COLOR is transparent). The preset must carry the gradient on
//      states.default.gradient = { type:'linear', angle:180, stops:[…] } (native Background Gradient),
//      NOT drop it or misclassify the button as Outline. Mirror of PHP build_button_presets() +
//      Mapper::parse_linear_gradient().
//   2. FIXED HEIGHT   — a button with a fixed height (`.btn{height:58px}` / `h-11`) and ~0 vertical
//      padding maps to the SIZE preset's Min Height (content centres to it) — the exact reproduction,
//      not a guessed Padding Y. A missing min_height renders "Large" as a giant circle.
//
// Run: node button-presets-parity.test.mjs   (exit 1 on any failure)
import { buildButtonPresets } from './to-theme-settings.mjs';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + msg); if (!cond) fails++; };

// ── 1. Gradient-filled primary button (the real `.btn-primary` shape: transparent bg-color, gradient bg-image,
//       fixed 58px height, uppercase 10px display type) ─────────────────────────────────────────────────────
const gradSkin = {
  role: 'Primary',
  bg: '', // gradient buttons resolve a transparent background-COLOR — the fill is the gradient below
  grad: 'linear-gradient(180deg, rgba(255,255,255,0.94), rgba(255,255,255,0.58))',
  fg: 'rgb(51, 41, 27)',
  bd: '', bw: '',
  shadow: 'rgba(0, 0, 0, 0.15) 0px 16px 42px 0px',
  radius: '999px',
  px: '32px', py: '0px', fs: '10px', lh: 'normal', height: '58px',
  ff: 'Inter, sans-serif', ls: '2.5px', tt: 'uppercase', fw: '600',
  hoverBg: '',
};
const out = buildButtonPresets({ buttonSkins: [gradSkin, gradSkin, gradSkin] });
ok(!!out && Array.isArray(out.button_colors) && out.button_colors.length >= 1, 'a colour preset is produced');
const primary = (out.button_colors || []).find((c) => c.color_name === 'Primary');
ok(!!primary, 'gradient button is classified Primary (not dropped / not Outline)');
const g = primary && primary.states && primary.states.default && primary.states.default.gradient;
ok(!!g && g.type === 'linear', 'states.default.gradient is a linear gradient');
ok(!!g && Number(g.angle) === 180, 'gradient angle = 180 (directionless `180deg`)');
ok(!!g && Array.isArray(g.stops) && g.stops.length === 2, 'gradient carries both colour stops');
ok(!!g && g.stops && g.stops[0].color === 'rgba(255,255,255,0.94)' && Number(g.stops[0].position) === 0, 'first stop = rgba(…,.94) @ 0%');
ok(!!g && g.stops && g.stops[1].color === 'rgba(255,255,255,0.58)' && Number(g.stops[1].position) === 100, 'second stop = rgba(…,.58) @ 100%');
// The solid bg_color must stay EMPTY so the gradient shows (a solid fill would paint over it).
const bgc = primary && primary.states.default.bg_color;
ok(!!bgc && (bgc.custom === '' || bgc.custom == null) && (bgc.predefined === '' || bgc.predefined == null), 'solid bg_color left empty (gradient wins)');

// ── 2. Fixed-height size preset → Min Height ────────────────────────────────────────────────────────────────
ok(!!out && Array.isArray(out.button_sizes) && out.button_sizes.length >= 1, 'a size preset is produced');
const sz = (out.button_sizes || [])[0];
const mh = sz && sz.min_height;
ok(!!mh && (mh.value === 58 || mh.value === '58') && mh.unit === 'px', 'size preset min_height = 58px (from fixed height, not padding_y)');

// ── 3. Source-named roles + border fidelity + preset matching (to-pages _buttonPresetFor, offline) ──────────
//       The capture names the skin role from the source's own class (`btn-primary` → Primary, `btn-secondary` →
//       Secondary — that regex runs in-browser, so the skins below carry the role the way capture-extract stamps
//       it); the page builder must then resolve each body button to that preset — no `sc-btn-*` transplant —
//       incl. a gradient primary with NO semantic class (matched by its gradient's first stop).
const { toPages } = await import('./to-pages.mjs');
const secSkin = { role: 'Secondary', bg: 'rgba(255, 255, 255, 0.08)', grad: '', fg: 'rgb(255, 255, 255)', bd: 'rgba(255, 255, 255, 0.16)', bw: '1px',
  shadow: '', radius: '999px', px: '32px', py: '0px', fs: '10px', lh: 'normal', height: '58px', ff: 'Inter, sans-serif', ls: '2.5px', tt: 'uppercase', fw: '600', hoverBg: '' };
const home = { buttonSkins: [gradSkin, secSkin] };
const presets = buildButtonPresets(home);
const pnames = presets.button_colors.map((c) => c.color_name);
ok(pnames.includes('Primary') && pnames.includes('Secondary'), 'source-named skins → presets named Primary + Secondary (' + pnames.join(',') + ')');
ok(!pnames.includes('Fill') && !pnames.includes('Outline'), 'no Fill / Outline fallback names when the source names its buttons');
const sec = presets.button_colors.find((c) => c.color_name === 'Secondary');
ok(!!sec && sec.states.default.border_width && String(sec.states.default.border_width.value) === '1' && sec.states.default.border_style === 'solid', 'Secondary keeps its 1px solid border');
ok(!!sec && sec.states.default.bg_color.custom === 'rgba(255, 255, 255, 0.08)', 'Secondary translucent fill verbatim');
const secBs = { bg: 'rgba(255, 255, 255, 0.08)', fg: 'rgb(255, 255, 255)', bd: 'rgba(255, 255, 255, 0.16)', bds: 'solid', bw: '1px', grad: '' };
const priBs = { bg: 'rgba(0, 0, 0, 0)', fg: 'rgb(51, 41, 27)', bd: 'rgba(0, 0, 0, 0)', bds: 'none', bw: '0px', grad: gradSkin.grad };
const btnFixture = (cls, bs) => ({ url: 'http://x/', home, sections: [{ sectionClass: '', computed: { padding: '0px', margin: '0px' },
  blocks: [{ t: 'button', label: 'CTA', href: '#', cls, bs, fs: '10px', pad: '0px 32px' }] }] });
const styleOf = (cls, bs) => {
  const out = toPages(btnFixture(cls, bs));
  let found = null;
  const walk = (n) => { if (!n || found) return; if (n.shortcode === 'button') { found = n; return; } for (const c of (n._items || [])) walk(c); };
  for (const s of (out?.pages?.[0]?.builder || [])) walk(s);
  return found ? String(found.atts.style || '') : '(no button node)';
};
ok(styleOf('btn-secondary', secBs) === 'btn-secondary', '`btn-secondary` + cs → style btn-secondary');
ok(styleOf('btn-primary', priBs) === 'btn-primary', '`btn-primary` + gradient cs → style btn-primary');
ok(styleOf('hero-cta', priBs) === 'btn-primary', 'gradient button with NO semantic class still matches the gradient preset');
ok(styleOf('button--secondary', secBs) === 'btn-secondary', 'BEM `button--secondary` resolves the Secondary preset');

// ── 4. Hover fidelity: the preset owns the source's hover MOTION + its real transition ─────────────────────────
//       (capture stamps the resolved hover as data-sc-hover → skin.hov, and the resting transition → skin.tr)
const priHov = { ...gradSkin, hov: 'hover-self{transform:translateY(-4px)}', tr: 'all 0.45s cubic-bezier(0.16, 1, 0.3, 1) 0s' };
const secHov = { ...secSkin, hov: 'hover-self{background-color:rgba(255, 255, 255, 0.14);background-image:initial}', tr: 'all 0.35s ease 0s', hoverBg: 'rgba(255, 255, 255, 0.14)' };
const hp = buildButtonPresets({ buttonSkins: [priHov, secHov] });
const hPri = hp.button_colors.find((c) => c.color_name === 'Primary');
const hSec = hp.button_colors.find((c) => c.color_name === 'Secondary');
ok(!!hPri && hPri.custom_css.includes('{{SELECTOR}}:hover { transform: translateY(-4px); }'), 'Primary preset Custom CSS carries the hover transform verbatim');
ok(!!hPri && hPri.custom_css.includes('transition: all 0.45s cubic-bezier(0.16, 1, 0.3, 1) 0s'), 'Primary preset eases with the SOURCE transition');
ok(!!hPri && Object.keys(hPri.states.hover || {}).length === 0, 'Primary hover state has NO colour change (source changes only transform)');
ok(!!hSec && hSec.states.hover.bg_color.custom === 'rgba(255, 255, 255, 0.14)', 'Secondary hover fill = source rgba(…,0.14)');
ok(!!hSec && hSec.custom_css.includes('transition: all 0.35s ease 0s') && !hSec.custom_css.includes('transform'), 'Secondary (colour-only hover) carries the source transition, no transform');
ok(buildButtonPresets({ buttonSkins: [{ ...gradSkin, hov: '', tr: 'all 0s ease 0s' }] }).button_colors[0].custom_css === '', 'no hover motion + zero transition → empty Custom CSS');

// ── 5. "Native first, the rest advanced": multi-layer shadow → native field = the MOST VISIBLE layer (the drop,
//       not the inset highlight); the exact full shadow rides the preset Custom CSS; single-layer → native only ──
const twoLayer = { ...gradSkin, shadow: 'rgba(255, 255, 255, 0.76) 0px 1px 0px 0px inset, rgba(0, 0, 0, 0.15) 0px 16px 42px 0px', hov: '', tr: '' };
const tl = buildButtonPresets({ buttonSkins: [twoLayer] }).button_colors[0];
ok(tl.states.default.box_shadow && tl.states.default.box_shadow.blur === 42 && tl.states.default.box_shadow.y === 16 && !tl.states.default.box_shadow.inset, 'native box_shadow = the DROP layer (0 16px 42px), not the inset highlight');
ok(tl.states.default.box_shadow.color === 'rgba(0, 0, 0, 0.15)', 'native box_shadow colour verbatim');
ok(tl.custom_css.includes('{{SELECTOR}} { box-shadow: ') && tl.custom_css.includes('0px 16px 42px'), 'multi-layer shadow → preset Custom CSS carries the exact full box-shadow');
const oneLayer = { ...gradSkin, shadow: 'rgba(0, 0, 0, 0.2) 0px 4px 12px 0px', hov: '', tr: '' };
const ol = buildButtonPresets({ buttonSkins: [oneLayer] }).button_colors[0];
ok(ol.states.default.box_shadow.blur === 12 && !ol.custom_css.includes('box-shadow'), 'single-layer shadow → native field only, NO box-shadow in Custom CSS');

// ── 6. SIZE NAMING: source names win; else the MOST-USED size is "Default" (md) and the rest are named relative
//       to it (bigger → Large, X-Large; smaller → Small, X-Small). 1 → Default; 2 → Default + Large/Small; … ─────
const szSkin = (fs, py, px, extra = {}) => ({ role: 'Primary', bg: 'rgb(10, 20, 30)', fg: 'rgb(255, 255, 255)', bd: '', bw: '', grad: '', shadow: '', radius: '8px',
  px: px + 'px', py: py + 'px', fs: fs + 'px', lh: 'normal', height: '', ff: '', ls: '', tt: '', fw: '', hoverBg: '', cls: '', ...extra });
const rep = (skin, n) => Array.from({ length: n }, () => ({ ...skin }));
const namesOf = (skins) => (buildButtonPresets({ buttonSkins: skins }).button_sizes || []).map((s) => s.size_name + '=' + s.slug).join(' | ');
ok(namesOf(rep(szSkin(14, 10, 20), 3)) === 'Default=md', '1 size → Default (md), never a lone "Large"');
ok(namesOf([...rep(szSkin(14, 10, 20), 4), ...rep(szSkin(18, 16, 32), 1)]) === 'Large=lg | Default=md', '2 sizes, most-used smaller → Default + Large');
ok(namesOf([...rep(szSkin(16, 12, 24), 4), ...rep(szSkin(12, 6, 12), 1)]) === 'Default=md | Small=sm', '2 sizes, most-used bigger → Default + Small');
ok(namesOf([...rep(szSkin(20, 16, 32), 1), ...rep(szSkin(15, 10, 20), 5), ...rep(szSkin(12, 6, 12), 2)]) === 'Large=lg | Default=md | Small=sm', '3 sizes around the default → Large / Default / Small');
ok(namesOf([...rep(szSkin(18, 14, 28), 5), ...rep(szSkin(14, 8, 16), 2), ...rep(szSkin(11, 4, 10), 1)]) === 'Default=md | Small=sm | X-Small=xs', '3 sizes, default biggest → Default / Small / X-Small');
ok(namesOf([...rep(szSkin(24, 20, 40), 1), ...rep(szSkin(19, 14, 28), 1), ...rep(szSkin(15, 10, 20), 5), ...rep(szSkin(12, 6, 12), 2)]) === 'X-Large=xl | Large=lg | Default=md | Small=sm', '4 sizes, two above → X-Large / Large / Default / Small');
ok(namesOf([...rep(szSkin(18, 14, 28, { cls: 'btn btn-lg' }), 3), ...rep(szSkin(12, 6, 12, { cls: 'btn btn-sm' }), 1)]) === 'Large (Default)=lg | Small=sm', 'source-named sizes win (btn-lg / btn-sm; the most-used one still marked Default)');
ok(namesOf([...rep(szSkin(18, 14, 28, { cls: 'button button--large' }), 1), ...rep(szSkin(14, 10, 20, { cls: 'button' }), 4)]) === 'Large=lg | Default=md', 'BEM button--large + unnamed most-used → Large + Default');
ok(namesOf([...rep(szSkin(10, 0, 32, { height: '58px' }), 1), ...rep(szSkin(14, 16, 20), 3)]) === 'Large=lg | Default=md', 'height-sized 58px pill ranks above a padded 54px button (size = box, not type)');

if (fails) { console.log('\n' + fails + ' FAILED'); process.exit(1); }
console.log('\nAll button-preset parity checks passed.');
