// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// CARD STATES + EYEBROW parity guard (browser-free). A project tile captured with EVERY state (a ::before overlay, a
// hover lift + border, a hover-revealed child, :focus-visible) and a short mono eyebrow before its heading:
//   (1) buildBorderPresets → the Box Preset's Custom CSS carries the states {{SELECTOR}}-scoped (stateCss), the
//       exact hover transform (no library Lift substituted), the hover-child rule and NO hostile text;
//   (2) toPages → the tile's icon_box gets the native Overline + its type as scoped .icon-box__overline CSS and the
//       description measure as .icon-box__content{max-width}.
// PHP twins: state_css / read_card_skin / card_eyebrow / n_icon_box (golden fixture [T]).
//
// Run: node card-states-parity.test.mjs   (exit 1 on any failure)
import { toPages } from './to-pages.mjs';
import { buildBorderPresets, stateCss } from './box-presets.mjs';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + msg); if (!cond) fails++; };

const hov = 'before{content:"";position:absolute;inset:0px;background-image:linear-gradient(135deg, rgba(255, 189, 98, 0.12), rgba(0, 0, 0, 0) 40%);opacity:0.6;pointer-events:none}'
  + '|hover-self{transform:translateY(-3px);border-color:rgba(255, 255, 255, 0.18);box-shadow:rgba(0, 0, 0, 0.4) 0px 24px 60px}'
  + '|hover-child{.on-hover}{opacity:1;transform:translateY(0px)}'
  + '|focus-visible{outline:2px solid rgba(255, 189, 98, 0.8);outline-offset:3px}';
const box = { bg: 'rgba(255, 255, 255, 0.04)', fill: 'rgba(255, 255, 255, 0.04)', gradient: '', radius: '24px', borderWidth: '1px', borderStyle: 'solid', borderColor: 'rgba(255, 255, 255, 0.08)', shadow: '', backdrop: '', padding: '22px', clip: true, hov, kf: '', pseudoOwned: false };

console.log('\n=== (1) box preset: every state → preset Custom CSS ===');
const sc = stateCss(hov, '', false, ['background-color', 'background', 'border-color', 'box-shadow']);
ok(/\{\{SELECTOR\}\}::before \{[^}]*content:""[^}]*opacity:0\.6/.test(sc), 'the ::before overlay layer rides {{SELECTOR}}-scoped');
ok(/\{\{SELECTOR\}\}:hover \{ transform:translateY\(-3px\); \}/.test(sc), 'the EXACT hover transform (border / shadow skipped — the preset hover fields own them)');
ok(/\{\{SELECTOR\}\}:hover \.on-hover \{ opacity:1; transform:translateY\(0px\); \}/.test(sc), 'a hover-revealed child → {{SELECTOR}}:hover .on-hover');
ok(/\{\{SELECTOR\}\}:focus-visible \{ outline:2px solid rgba\(255, 189, 98, 0\.8\); outline-offset:3px; \}/.test(sc), ':focus-visible carried');
const presets = buildBorderPresets([box, box]);
const list = Array.isArray(presets) ? presets : (presets.presets || presets.border_presets || []);
const p0 = list[0] || {};
const pcss = String(p0.custom_css || '');
ok(list.length >= 1 && list.filter((x) => /::before/.test(String(x.custom_css || ''))).length === 1 && /:hover \{ transform:translateY\(-3px\)/.test(pcss), 'buildBorderPresets: ONE preset for the two identical tiles (plus the library defaults), its custom_css carries the states');
ok(!/btnfx-lift|hover_fx/.test(JSON.stringify(p0)) || /translateY\(-3px\)/.test(pcss), 'no library Lift substituted for the exact captured transform');
ok(!/expression\(|<\/|javascript:/i.test(pcss), 'NEG: nothing hostile rides along');

console.log('\n=== (2) icon_box: eyebrow → native Overline, description measure ===');
const overline = { text: 'Digital Architecture', fontSize: '10px', letterSpacing: '3.5px', textTransform: 'uppercase', color: 'rgba(255, 255, 255, 0.4)', fontWeight: '400', lineHeight: '15px', marginBottom: '0px', fontFamily: '"IBM Plex Mono", monospace' };
const tile = { width: '', cls: '', fullCls: 'project', colId: 'c1', cw: 6, minH: 320, html: '<article>…</article>', card: { icon: '', customIcon: '', lucide: '', iconLayout: 'inline-left', iconColor: '', title: 'Midnight journal', titleTag: 'h3', text: '<p>Typography-led landing pages.</p>', link: null, center: false, overline, bodyMaxWidth: '333px', box } };
const row = { t: 'row', valign: '', gap: 16, gapResp: null, html: '', mt: 0, mb: 0, nowrap: true, cols: [tile, { ...tile, colId: 'c2', card: { ...tile.card, title: 'Editorial toolkits' } }] };
const out = toPages({ url: 'http://x/', sections: [{ sectionClass: 'projects', computed: { padding: '120px 24px', margin: '0px' }, blocks: [row] }] }, { hifiCss: true });
const boxes = []; const walk = (n) => { if (n.shortcode === 'icon_box') boxes.push(n); (n._items || []).forEach(walk); }; walk(out.pages[0].builder[0]);
ok(boxes.length === 2, 'two tiles → two icon_boxes');
const ib = boxes[0] || { atts: {} };
ok(ib.atts.overline === 'Digital Architecture', 'the eyebrow → the native Overline option');
ok(/selector \.icon-box__overline\{[^}]*font-size:10px[^}]*letter-spacing:3\.5px[^}]*text-transform:uppercase[^}]*color:rgba\(255, 255, 255, 0\.4\)/.test(String(ib.atts.custom_css || '')), '…its size / tracking / case / translucent colour as scoped CSS');
ok(/selector \.icon-box__overline\{[^}]*font-family:'IBM Plex Mono', monospace/.test(String(ib.atts.custom_css || '')), '…and its mono family');
ok(/selector \.icon-box__content\{max-width:333px;\}/.test(String(ib.atts.custom_css || '')), "the description's own measure → .icon-box__content{max-width}");
ok(!/::before|:hover/.test(String(ib.atts.custom_css || '')), 'NEG: the states do NOT ride on the shortcode (they belong to the preset)');

console.log(fails ? `\n✗ ${fails} FAIL` : '\n✓ ALL PASS — card states + eyebrow parity guarded');
process.exit(fails ? 1 : 0);
