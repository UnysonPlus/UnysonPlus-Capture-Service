// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Boxed text + floating chip parity guard (browser-free). Feeds a synthetic section — a paragraph that IS a box
// (glass fill + border + radius + padding + blur) and two short texts pinned over the band (`absolute
// left-[8%] top-[18%]`, `bottom-[18%] left-[12%]`) — through the real toPages() and asserts the rules the PHP
// twin proves in golden-fixture-1 [C3]:
//   • a boxed paragraph stashes its skin on `_box` (capture.mjs clusters it into border_presets and assigns the
//     text block's native Box Style) and keeps its OWN line-height at normal specificity;
//   • a pinned text gets the NATIVE Position option with the DECLARED sides only (a % stays a %), z-index 2;
//   • pinned texts are HOISTED to be direct children of the section, the section becomes Position: relative, and
//     the chips' auto container is freed from the theme's media-band positioning (scoped :has()).
// Run: node boxed-text-parity.test.mjs   (exit 1 on any failure)
import { toPages } from './to-pages.mjs';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + msg); if (!cond) fails++; };

const para = { t: 'text', html: '<p>A regenerative landscape for sustainable estates.</p>', text: 'A regenerative landscape for sustainable estates.', tag: 'p', cls: 'hero-copy',
  fontSize: '18px', color: 'rgba(255, 255, 255, 0.88)', lineHeight: '35.1px', letterSpacing: 'normal', marginBottom: '0px', textAlign: 'center', fontWeight: '400',
  bg: 'rgba(255, 255, 255, 0.08)', bgImage: '', border: '1px solid rgba(255, 255, 255, 0.12)', borderRadius: '32px', boxShadow: '', padding: '22px 26px', backdrop: 'blur(30px) saturate(1.2)',
  position: 'static', top: 'auto', right: 'auto', bottom: 'auto', left: 'auto', zIndex: 'auto' };
const chip = (text, cls, pos) => ({ t: 'text', html: '<div>' + text + '</div>', text, tag: 'div', cls,
  fontSize: '10px', color: 'rgb(255, 255, 255)', lineHeight: '15px', letterSpacing: '2.2px', marginBottom: '0px', textAlign: 'start', fontWeight: '400',
  bg: 'rgba(255, 255, 255, 0.18)', bgImage: '', border: '1px solid rgba(255, 255, 255, 0.18)', borderRadius: '999px', boxShadow: 'rgba(0, 0, 0, 0.12) 0px 14px 32px 0px', padding: '11px 16px', backdrop: 'blur(24px) saturate(1.2)',
  position: 'absolute', ...pos, zIndex: 'auto' });
const capture = { url: 'http://x/', sections: [{ sectionClass: 'hero', computed: { padding: '0px', margin: '0px', position: 'relative' },
  blocks: [ { t: 'heading', level: 1, html: 'Autumn Flow', text: 'Autumn Flow' }, para,
            chip('Golden fields · Harvest 12', 'floating-note left-[8%] top-[18%]', { top: '162px', right: 'auto', bottom: 'auto', left: '115px' }),
            chip('Riparian restoration active', 'floating-note bottom-[18%] left-[12%]', { top: 'auto', right: 'auto', bottom: '162px', left: '172px' }) ] }] };

const out = toPages(capture, { hifiCss: true });
const sec = out?.pages?.[0]?.builder?.find((n) => n.type === 'section') || out?.pages?.[0]?.builder?.[0];
const findText = (n, needle) => { if (!n) return null; if (n.shortcode === 'text_block' && String(n.atts.text || '').includes(needle)) return n; for (const c of (n._items || [])) { const r = findText(c, needle); if (r) return r; } return null; };

// boxed paragraph
const p = findText(sec, 'regenerative');
ok(!!p, 'boxed intro paragraph is a text_block (not folded away)');
ok(!!p && p.atts._box && p.atts._box.fill === 'rgba(255, 255, 255, 0.08)' && p.atts._box.radius === '32px' && p.atts._box.padding === '22px 26px' && p.atts._box.borderWidth === '1px' && /blur\(30px\)/.test(p.atts._box.backdrop), 'its skin is stashed on _box (fill, radius, 2-value padding, border, blur) for the Box Preset');
ok(!!p && /selector,selector p\{line-height:35\.1px;\}/.test(p.atts.custom_css || ''), 'it keeps its own line-height at normal specificity');
ok(!!p && !/background-color|border-radius|padding|backdrop-filter/.test(p.atts.custom_css || ''), 'its base carries NO per-node fill / radius / padding / blur (the preset owns them)');

// chips
const c1 = findText(sec, 'Golden fields'); const c2 = findText(sec, 'Riparian');
ok(!!c1 && c1.atts._box && c1.atts._box.radius === '999px' && c1.atts._box.padding === '11px 16px', 'floating chip stashes its pill skin for a Box Preset');
const ep = c1 && c1.atts.element_position;
ok(!!ep && ep.position === 'absolute', 'chip → native Position: absolute');
ok(!!ep && ep.absolute.pos_offsets.top.value === '18' && ep.absolute.pos_offsets.top.unit === '%' && ep.absolute.pos_offsets.left.value === '8' && ep.absolute.pos_offsets.left.unit === '%' && ep.absolute.pos_offsets.right.unit === 'auto' && ep.absolute.pos_offsets.bottom.unit === 'auto', 'chip offsets = the DECLARED sides only: top 18%, left 8%');
const ep2 = c2 && c2.atts.element_position;
ok(!!ep2 && ep2.absolute.pos_offsets.bottom.value === '18' && ep2.absolute.pos_offsets.left.value === '12' && ep2.absolute.pos_offsets.top.unit === 'auto', 'second chip: bottom 18%, left 12%');
ok(!!ep && ep.absolute.element_zindex === '2', 'chip z-index sits above the band media/overlay (2)');
const direct = (sec._items || []).filter((n) => n.shortcode === 'text_block').length;
ok(direct === 2, 'chips are HOISTED to be direct children of the section (' + direct + ')');
ok(!!sec.atts.element_position && sec.atts.element_position.position === 'relative', 'the section is the positioned ancestor (Position: relative)');
ok(/selector > \.fw-container:has\(\.u[a-z0-9]{8}\)\{position:static !important;\}/.test(sec.atts.custom_css || ''), 'the section frees the chips\' auto container from the media-band positioning (scoped :has())');

// negative: a plain in-flow paragraph has no _box and no element_position
const plain = toPages({ url: 'http://x/', sections: [{ sectionClass: '', computed: { padding: '0px', margin: '0px' }, blocks: [{ t: 'text', html: '<p>Just a paragraph.</p>', text: 'Just a paragraph.', tag: 'p', cls: '', fontSize: '16px', color: 'rgb(60, 60, 60)', lineHeight: '24px', bg: '', bgImage: '', border: '', borderRadius: '0px', boxShadow: '', padding: '0px', backdrop: '', position: 'static' }] }] }, { hifiCss: true });
const plainNode = findText(plain?.pages?.[0]?.builder?.[0], 'Just a paragraph');
ok(!!plainNode && !plainNode.atts._box && !plainNode.atts.element_position, 'negative: a plain paragraph gets no _box and no Position option');

if (fails) { console.log('\n' + fails + ' FAILED'); process.exit(1); }
console.log('\nAll boxed-text parity checks passed.');
