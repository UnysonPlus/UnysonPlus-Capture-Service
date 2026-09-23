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

console.log(fails ? `\n✗ ${fails} FAILED` : '\n✓ ALL PASS — feed-theme rules guarded in the JS path');
process.exit(fails ? 1 : 0);
