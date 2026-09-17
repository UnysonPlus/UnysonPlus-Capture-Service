// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// STRUCTURAL parity for the feed's last open items (browser-free, on the shapes capture-extract emits):
//   · a card whose photo carries a pinned chip → a RELATIVE frame stack (image + floating_card) at the frame's height, then a
//     padded `flex-grow justify-between` body stack whose `time | link` row stays a row;
//   · a stacked chip → overline + title with its own leading, no inner gap, the source min-width;
//   · a FIXED SMALL BOX cell (a numeral disc) → the inner wrapper's size, the glyph centred; a one-line pill → nowrap;
//   · a CSS-painted photo cell → a cover media image at the cell's box.
// PHP twin: tests/golden-fixture-1-test.php [AA].
// Run: node badge-card-parity.test.mjs   (exit 1 on any failure)
import { toPages } from './to-pages.mjs';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + msg); if (!cond) fails++; };
const text = (t, extra = {}) => ({ t: 'text', html: '<p>' + t + '</p>', text: t, tag: 'p', cls: '', fontSize: '16px', color: 'rgb(60, 60, 60)', lineHeight: '24px', bg: '', bgImage: '', border: '', borderRadius: '0px', boxShadow: '', padding: '0px', backdrop: '', position: 'static', ...extra });
const findAll = (n, pred, out = []) => { if (!n || typeof n !== 'object') return out; if (pred(n)) out.push(n); for (const c of (n._items || [])) findAll(c, pred, out); return out; };
const css = (n) => String((n && n.atts && n.atts.custom_css) || '');

const chip = { title: '08', titleTag: 'h4', subtitle: '', iconLayout: 'top-title', center: true, titleExtra: 'font-size:18px;line-height:18px;margin-bottom:0px',
  overline: { text: 'JUN', fontSize: '12px', letterSpacing: '1.2px', lineHeight: '12px', textTransform: 'uppercase', fontWeight: '800', color: 'rgb(79, 70, 229)', fontFamily: 'Inter, sans-serif', marginBottom: '4px' },
  minWidth: '64px', innerGap: '0', pos: { cls: 'absolute bottom-4 left-4', bg: 'rgba(255, 255, 255, 0.95)', radius: '12px', shadow: 'none', padding: '8px 16px' } };
const cap = { url: 'http://x/', sections: [
  { sectionClass: 'events', computed: { padding: '96px 0px', margin: '0px' }, assets: ['http://x/e.jpg'], blocks: [
    { t: 'row', role: 'columns', gap: '32px', gapResp: null, cols: [
      { width: '1_3', cls: '', fullCls: 'ecard', colId: 'sccol-0', cw: 4, html: '<img src="http://x/e.jpg"><p>Studio open evening</p>', cardBox: { fill: 'rgb(255, 255, 255)', radius: '16px', borderWidth: '2px', borderColor: 'rgb(255, 59, 48)', shadow: '', padding: '' },
        blocks: [
          { t: 'stack', gap: '0px', mt: 0, mb: 0, rel: true, frameH: 224, items: [{ t: 'image', src: 'http://x/e.jpg', alt: '', objectFit: 'cover' }, { t: 'floating_card', card: chip }] },
          { t: 'stack', gap: '16px', mt: 0, mb: 0, padPx: { top: 24, right: 24, bottom: 24, left: 24 }, grow: true, items: [
            { t: 'heading', level: 3, html: 'Studio open evening', text: 'Studio open evening' }, text('Walk the floor.'),
            { t: 'row', role: 'columns', valign: 'center', gap: 0, mt: 0, mb: 0, nowrap: true, justify: 'space-between', cols: [{ cls: '', blocks: [text('10:00 AM', { contentSized: true })] }, { cls: '', blocks: [text('<a href="#">Learn More</a>', { contentSized: true })] }] },
          ] },
        ] },
      { width: '1_3', cls: '', fullCls: 'x', colId: 'sccol-1', cw: 4, html: '<p>Aside</p>', blocks: [text('Aside')] },
    ] },
  ] },
  { sectionClass: 'proc', computed: { padding: '120px 0px', margin: '0px' }, blocks: [
    { t: 'row', role: 'columns', gap: '32px', gapResp: null, cols: [
      { width: '1_12', cls: '', fullCls: 'disc', colId: 'sccol-2', cw: 1, track: 80, html: '<p>01</p>', cardBox: { fill: 'rgba(201, 169, 110, 0.06)', radius: '50%', borderWidth: '1px', borderColor: 'rgba(201, 169, 110, 0.3)', shadow: '', padding: '' }, fixedBox: { w: 52, h: 52 }, blocks: [text('01')] },
      { width: '5_6', cls: '', fullCls: 'copy', colId: 'sccol-3', cw: 10, track: 812, html: '<p>Discovery call</p>', blocks: [{ t: 'heading', level: 3, html: 'Discovery call', text: 'Discovery call' }] },
      { width: '1_12', cls: '', fullCls: 'pill', colId: 'sccol-4', cw: 1, track: 73, html: '<p>60 min</p>', cardBox: { fill: 'rgba(255, 255, 255, 0.04)', radius: '100px', borderWidth: '1px', borderColor: 'rgba(255, 255, 255, 0.07)', shadow: '', padding: '6px 16px' }, nowrapText: true, blocks: [text('60 min')] },
    ] },
  ] },
  { sectionClass: 'split', computed: { padding: '0px', margin: '0px' }, assets: ['http://x/shed.jpg'], blocks: [
    { t: 'row', role: 'columns', gap: '0px', gapResp: null, cols: [
      { width: '1_2', cls: '', fullCls: 'panel', colId: 'sccol-5', cw: 6, html: '<h2>Made slowly</h2>', blocks: [{ t: 'heading', level: 2, html: 'Made slowly', text: 'Made slowly' }] },
      { width: '1_2', cls: '', fullCls: 'photo', colId: 'sccol-6', cw: 6, html: '', image: { src: 'http://x/shed.jpg', alt: '', bgPhoto: { h: 600, pos: '50% 50%' } } },
    ] },
  ] },
] };

const out = toPages(cap, { hifiCss: true });
const builder = out?.pages?.[0]?.builder || [];
const all = []; for (const s of builder) findAll(s, () => true, all);

console.log('\n=== the badge card: relative frame + floating chip, padded growing body, the meta row ===');
{
  const frame = all.find((n) => /position:relative;overflow:hidden;height:224px/.test(css(n)));
  ok(!!frame, 'the photo frame is a relative 224px stack');
  ok(frame && /selector \.image img\{width:100%;height:100%;object-fit:cover/.test(css(frame)), '…the photo covers the frame');
  const imgs = frame ? findAll(frame, (n) => n.shortcode === 'media_image') : []; const chips = frame ? findAll(frame, (n) => n.shortcode === 'icon_box') : [];
  ok(imgs.length === 1 && chips.length === 1, 'the frame holds the media image + ONE icon_box chip');
  const c = chips[0];
  ok(c && c.atts.overline === 'JUN' && c.atts.title === '08', 'the chip: month as the overline, day as the title');
  ok(c && /\.icon-box__overline\{[^}]*margin-bottom:4px/.test(css(c)), '…the overline takes the title\'s mt-1 as its gap');
  ok(c && /font-size:18px;line-height:18px;margin-bottom:0px/.test(css(c)), '…the title keeps its 18px leading-none');
  ok(c && /min-width:64px/.test(css(c)) && /\.icon-box__inner\{gap:0;\}/.test(css(c)), '…the source min-width, no inner gap');
  const body = all.find((n) => /flex:1 1 auto;justify-content:space-between/.test(css(n)));
  ok(!!body && /padding-top:24px;padding-right:24px;padding-bottom:24px;padding-left:24px/.test(css(body)), 'the body is a padded flex-grow justify-between stack');
  const meta = body ? findAll(body, (n) => n.type === 'flexbox' && n.atts && n.atts.direction && n.atts.direction.base === 'row' && (n._items || []).length === 2) : [];
  ok(meta.length >= 1, 'the time | link meta row stays a two-cell row inside the body');
  ok(meta[0] && meta[0].atts.justify_content && meta[0].atts.justify_content.base === 'between', '…with the source justify (space-between)');
}
console.log('\n=== the process row: a fixed 52px disc cell, a one-line pill ===');
{
  const outer = all.find((n) => /sc-fixbox p\{margin:0;\}/.test(css(n)));
  const disc = outer ? findAll(outer, (n) => /^selector\{width:52px;height:52px/.test(css(n))) : [];
  ok(!!outer && disc.length === 1, 'the numeral disc cell carries the fixed box on its INNER wrapper (the track keeps its width)');
  ok(disc[0] && /display:flex;align-items:center;justify-content:center;padding:0/.test(css(disc[0])), '…52×52, the glyph centred, no inset');
  const pill = all.find((n) => /white-space:nowrap/.test(css(n)));
  ok(!!pill, 'the one-line pill cell is nowrap');
}
console.log('\n=== the split band: a CSS-painted photo half → a cover media image ===');
{
  const shed = all.find((n) => n.shortcode === 'media_image' && /shed\.jpg/.test(JSON.stringify(n.atts.image || '')));
  ok(!!shed, 'the bg-cover cell is a media image (not dropped as empty)');
  ok(shed && /min-height:600px/.test(css(shed)) && /object-fit:cover;object-position:50% 50%/.test(css(shed)), '…covering the cell\'s 600px box at the source position');
}

console.log(fails ? `\n✗ ${fails} FAIL` : '\n✓ ALL PASS — badge card / fixed box / bg photo parity guarded');
process.exit(fails ? 1 : 0);
