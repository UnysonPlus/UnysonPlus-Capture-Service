// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// FEED-THEMES parity (browser-free). The shared-report feed's ranked themes, as the JS path sees them:
//  · a small mono/tracked kicker HEADING over the real headline is ONE special_heading (overline + title), and the
//    kicker's own gap below itself survives as the overline's margin-bottom;
//  · an <img> that pins its OWN box (`w-full h-[740px] object-cover`) keeps that height + cover, not height:auto;
//  · a button's preset follows its COMPUTED fill, so an opaque brand fill and a 10 % tint of the same brand never
//    collapse into one preset.
// PHP twin: tests/golden-fixture-1-test.php [AK].
// Run: node feed-themes-parity.test.mjs   (exit 1 on any failure)
import { toPages } from './to-pages.mjs';
import { makeButtonResolver } from './button-match.mjs';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + msg); if (!cond) fails++; };
const find = (n, pred) => { if (!n || typeof n !== 'object') return null; if (pred(n)) return n; for (const c of (n._items || [])) { const r = find(c, pred); if (r) return r; } return null; };
const findIn = (out, pred) => { for (const s of (out?.pages?.[0]?.builder || [])) { const r = find(s, pred); if (r) return r; } return null; };
const cap = (blocks) => ({ url: 'http://x/', sections: [{ sectionClass: 'section', computed: { padding: '96px 0px', margin: '0px' }, blocks }] });

console.log('\n=== a kicker HEADING over the headline is one special_heading (PHP twin: [AK]) ===');
{
  const blocks = [
    { t: 'heading', level: 2, tag: 'h2', html: 'Live Experience', text: 'Live Experience', cls: 'text-sm font-mono uppercase tracking-widest',
      fontSize: '14px', fontWeight: '400', lineHeight: '20px', letterSpacing: '2.8px', textTransform: 'uppercase', fontFamily: '"Space Mono", monospace',
      color: 'rgb(37, 99, 235)', marginBottom: '24px', marginTop: '0px', align: 'left' },
    { t: 'heading', level: 3, tag: 'h3', html: 'Upcoming Shows', text: 'Upcoming Shows', cls: 'text-5xl font-bold',
      fontSize: '48px', fontWeight: '700', lineHeight: '52px', letterSpacing: 'normal', fontFamily: 'Inter, system-ui, sans-serif',
      color: 'rgb(20, 20, 20)', marginBottom: '0px', marginTop: '0px', align: 'left' },
  ];
  const out = toPages(cap(blocks), { hifiCss: true });
  const sh = findIn(out, (n) => n.shortcode === 'special_heading');
  const a = (sh && sh.atts) || {};
  const css = String(a.custom_css || '');
  ok(!!sh, 'special_heading found');
  ok(/Live Experience/.test(String(a.overline || '')), 'the 14px mono kicker is the OVERLINE (the tag order h2→h3 says nothing)');
  ok(/Upcoming Shows/.test(String(a.title || '')), 'the 48px heading is the TITLE');
  ok(!findIn(out, (n) => n.shortcode === 'text_block' && /Live Experience/.test(String(n.atts?.text || ''))), 'the kicker is not ALSO left as its own block');
  ok(/\.heading-overline\{[^}]*margin-bottom:24px/.test(css), "the kicker's own 24px gap below itself rides the overline");
}

console.log('\n=== NEGATIVE: two headings of the same size stay two headings ===');
{
  const same = (txt) => ({ t: 'heading', level: 2, tag: 'h2', html: txt, text: txt, cls: '', fontSize: '32px', fontWeight: '700', lineHeight: '36px', letterSpacing: 'normal', fontFamily: 'Inter', color: 'rgb(20,20,20)', marginBottom: '0px', marginTop: '0px', align: 'left' });
  const out = toPages(cap([same('First Half'), same('Second Half')]), { hifiCss: true });
  const first = findIn(out, (n) => n.shortcode === 'special_heading' && /First Half/.test(String(n.atts?.title || '')));
  ok(!!first, 'the first heading keeps its own title');
  ok(!findIn(out, (n) => n.shortcode === 'special_heading' && /First Half/.test(String(n.atts?.overline || ''))), 'neither became the other\'s overline');
}

console.log('\n=== an <img> that pins its OWN box keeps it (PHP twin: [AK]) ===');
{
  const out = toPages(cap([{ t: 'image', src: 'https://example.com/story.jpg', alt: '', objectFit: 'cover', radius: '16px', pinnedH: 740 }]), { hifiCss: true });
  const im = findIn(out, (n) => n.shortcode === 'media_image');
  const css = String((im && im.atts && im.atts.custom_css) || '');
  ok(!!im, 'media_image found');
  ok(/height:740px/.test(css) && /object-fit:cover/.test(css), 'the pinned 740px box + cover (it had rendered height:auto)');
  ok(/border-radius:16px/.test(css), 'and its measured radius');
}

console.log('\n=== a button preset follows the COMPUTED fill (PHP twin: [AK]) ===');
{
  const st = (bg, fg) => ({ states: { default: { bg_color: { custom: bg }, text_color: { custom: fg }, border_color: { custom: '' } } } });
  const presets = {
    button_colors: [
      { id: 'primary', color_name: 'Primary', ...st('rgb(153, 51, 255)', 'rgb(255, 255, 255)') },
      { id: 'primary-2', color_name: 'Primary 2', ...st('rgba(153, 51, 255, 0.1)', 'rgb(153, 51, 255)') },
    ],
    button_sizes: [],
  };
  const r = makeButtonResolver(presets);
  const solid = r.presetFor({ cls: 'bg-primary text-primary-foreground', bs: { bg: 'rgb(153, 51, 255)', fg: 'rgb(255, 255, 255)' } });
  const tint = r.presetFor({ cls: 'bg-primary/10 text-primary', bs: { bg: 'rgba(153, 51, 255, 0.1)', fg: 'rgb(153, 51, 255)' } });
  ok(!!solid.style, 'the opaque brand fill resolves to a preset');
  ok(!!tint.style, 'the 10 % tint resolves to a preset');
  ok(solid.style !== tint.style, `they are TWO presets (${solid.style} vs ${tint.style}) — the role word alone had given both the solid one`);
}

console.log('\n=== a grid of photos is a GALLERY whose corners come from the tiles (PHP twin: [AI]) ===');
{
  const imgs = (n) => Array.from({ length: n }, (_, i) => ({ url: `https://example.com/p${i + 1}.jpg`, alt: '', caption: '' }));
  const gal = (tileRadius) => toPages(cap([{ t: 'gallery', images: imgs(6), tileRadius, colCount: 3, gap: '32px', ratio: '1-1', captions: 'none' }]), { hifiCss: true });
  const of = (out) => findIn(out, (n) => n.shortcode === 'gallery');
  const g0 = of(gal(0)), g6 = of(gal(6)), g16 = of(gal(16));
  ok(!!g0, 'gallery node built (the JS path had no gallery builder at all)');
  ok(g0 && (g0.atts.source?.media?.images || []).length === 6, 'the six source images ride the media source');
  ok(g0 && g0.atts.rounded === 'rounded-0', 'square-cornered tiles -> Corners: Square');
  ok(g6 && g6.atts.rounded === 'rounded', '6px tiles -> Corners: Rounded');
  ok(g16 && g16.atts.rounded === 'rounded-lg', '16px tiles -> Corners: Rounded large');
  ok(g0 && g0.atts.design_settings?.grid?.columns?.count === '3' && g0.atts.design_settings?.grid?.ratio === '1-1', 'the measured 3 columns + square tile ratio');
}

console.log('\n=== a hero scroll cue is the native SCROLL INDICATOR, pinned (PHP twin: [AJ]) ===');
{
  const out = toPages(cap([{ t: 'scroll_cue', abs: true, text: 'Scroll', layout: 'stacked',
    labelStyle: { fontSize: '10px', letterSpacing: '3px', textTransform: 'uppercase', fontWeight: '400', lineHeight: '15px', color: 'rgba(255, 255, 255, 0.5)' },
    svg: '<svg class="lucide lucide-arrow-down"></svg>', lucide: 'lucide/arrow-down', fa: '', size: 16, color: 'rgba(255, 255, 255, 0.5)',
    target: '', pinCls: 'absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2',
    pos: { position: 'absolute', top: 'auto', right: 'auto', bottom: '32px', left: '720px', zIndex: 'auto' }, transform: 'matrix(1, 0, 0, 1, -28.5, 0)', gap: '8px' }]), { hifiCss: true });
  const cue = findIn(out, (n) => n.shortcode === 'scroll_indicator');
  const a = (cue && cue.atts) || {}; const css = String(a.custom_css || '');
  ok(!!cue, 'scroll_indicator node built (the cue had been a text block + a lone icon in the flow)');
  ok(a.text === 'Scroll' && a.icon?.['svg-id'] === 'lucide/arrow-down' && a.layout === 'stacked', 'the label, the library glyph and label-above-icon');
  ok(a.icon_size?.value === '16' && /255/.test(a.icon_color?.custom || ''), "the glyph's measured size and its own ink");
  ok(a.element_position?.position === 'absolute' && a.element_position.absolute.pos_offsets.left.unit === '%' && a.element_position.absolute.pos_offsets.bottom.value === '32', 'pinned: bottom 32px, left 50%');
  ok(/transform:translateX\(-50%\)/.test(css) && /\.sc-scroll-cue__label\{[^}]*font-size:10px[^}]*text-transform:uppercase/.test(css), "the half-width centring + the label's measured type");
}


console.log('\n=== a PINNED LABEL over a photo rides the media node as a pseudo-element (PHP twin: [AN]) ===');
{
  const label = { text: 'Terroir · 1923', vAnchor: ['top', 24], hAnchor: ['left', 24],
    color: 'rgb(255, 255, 255)', fontFamily: '"Cormorant Garamond", Georgia, serif', fontSize: '12px',
    fontWeight: '400', lineHeight: '16px', letterSpacing: '3.36px', textTransform: 'uppercase',
    opacity: '0.4', bg: '', padding: '' };
  const out = toPages(cap([{ t: 'image', src: 'https://example.com/story-farmer.png', alt: '', objectFit: 'cover', labels: [label] }]), { hifiCss: true });
  const im = findIn(out, (n) => n.shortcode === 'media_image');
  const css = String((im && im.atts && im.atts.custom_css) || '');
  ok(!!im, 'media_image found');
  ok(/::after\{[^}]*content:"Terroir · 1923"/.test(css), 'the label is pseudo-element text on the photo, not a paragraph in the flow');
  ok(/::after\{[^}]*top:24px/.test(css) && /::after\{[^}]*left:24px/.test(css) && !/bottom:/.test(css), 'anchored to the NEARER measured edges (top/left), not their computed complements');
  ok(/::after\{[^}]*font-size:12px/.test(css) && /Cormorant/.test(css) && /letter-spacing:3.36px/.test(css) && /text-transform:uppercase/.test(css) && /opacity:0.4/.test(css), 'wearing its own face, tracking, case and the wrapper opacity');
  const bare = toPages(cap([{ t: 'image', src: 'https://example.com/story-farmer.png', alt: '', objectFit: 'cover' }]), { hifiCss: true });
  const bcss = String(findIn(bare, (n) => n.shortcode === 'media_image')?.atts?.custom_css || '');
  ok(!/::after/.test(bcss), 'NEGATIVE: a photo with no label gets no pseudo-element');
}


console.log('\n=== a step numeral drawn as a BADGE is the native marker (PHP twin: [AL]) ===');
{
  const step = (n, t) => ({ number: n, title: t, content: 'Body copy for the step.', icon: null });
  const dz = { design: 'vertical', numInline: true, numBadge: true, markerSize: 32, numShape: 'circle',
    connector: 'none', numBadgeCs: { bg: 'rgba(0, 0, 0, 0)', bw: '1px', bc: 'rgb(184, 168, 152)',
      color: 'rgb(18, 18, 18)', fs: '12px', fw: '400', ff: 'Helvetica', ls: 'normal' } };
  const out = toPages(cap([{ t: 'steps', items: [step('01', 'Naturally fermented'), step('02', 'Premium ingredients'), step('03', 'No shortcuts')], design: dz }]), { hifiCss: true });
  const st = findIn(out, (n) => n.shortcode === 'steps');
  const a = (st && st.atts) || {}; const css = String(a.custom_css || '');
  const rows = Array.isArray(a.card_rows) ? a.card_rows : [];
  ok(!!st, 'steps node built');
  ok(a.marker === 'number' && a.marker_shape === 'circle', 'the badge is the native MARKER, laid beside the body — not a stacked body row');
  ok(!rows.some((r) => (r.slots || []).includes('number')), '…so the number is NOT also a card row (it had stacked above the title)');
  ok(/--st-size:32px/.test(css), "the badge's measured size");
  ok(/\.fw-steps__marker\{[^}]*background:transparent/.test(css) && /\.fw-steps__marker\{[^}]*border:1px solid/.test(css), "its outlined skin (the marker's default is a solid accent fill)");
  ok(a.connector === 'none', 'the spine is only drawn when the source draws one');
  const plain = toPages(cap([{ t: 'steps', items: [step('01', 'One'), step('02', 'Two')], design: { design: 'vertical', numInline: true } }]), { hifiCss: true });
  const pa = (findIn(plain, (n) => n.shortcode === 'steps') || {}).atts || {};
  const prow = (Array.isArray(pa.card_rows) ? pa.card_rows : []).find((r) => (r.slots || []).includes('number'));
  ok(pa.marker === 'none' && !!prow && prow.justify === 'start', 'NEGATIVE: an unpainted INLINE numeral stays a left-aligned body row');
}

console.log(fails ? `\n✗ ${fails} FAILED` : '\n✓ ALL PASS — feed-theme rules guarded in the JS path');
process.exit(fails ? 1 : 0);
