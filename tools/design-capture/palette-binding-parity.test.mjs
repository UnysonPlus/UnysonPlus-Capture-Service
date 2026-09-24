/**
 * JS twin of PHP golden [AV]/[AW]: a converted colour binds to the palette the same conversion
 * generated, with the four guards that make the binding safe.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bindPaletteColors } from './to-pages.mjs';

const palette = [
  { name: 'Primary', color: '#ffffff' },
  { name: 'Ink', color: '#f5f5f5' },
  { name: 'Muted', color: 'rgb(115, 115, 115)' },
  { name: 'Black', color: '#000' },
];

test('an opaque ink binds to the palette role built from it, as a text- class, with custom cleared', () => {
  const n = { atts: { title_color: { predefined: '', custom: 'rgb(245, 245, 245)' } } };
  bindPaletteColors(n, palette);
  assert.deepEqual(n.atts.title_color, { predefined: 'text-ink', custom: '' });
});

test('a fill binds with the bg- prefix — the wrong prefix would paint the wrong property', () => {
  const n = { atts: { bg_color: { predefined: '', custom: '#000000' } } };
  bindPaletteColors(n, palette);
  assert.equal(n.atts.bg_color.predefined, 'bg-black');
});

test('a 3-digit palette entry still matches its 6-digit literal', () => {
  const n = { atts: { text_color: { predefined: '', custom: '#000' } } };
  bindPaletteColors(n, palette);
  assert.equal(n.atts.text_color.predefined, 'text-black');
});

test('NEG: a translucent value keeps its literal — alpha has no preset form', () => {
  const n = { atts: { title_color: { predefined: '', custom: 'rgba(245, 245, 245, 0.6)' } } };
  bindPaletteColors(n, palette);
  assert.deepEqual(n.atts.title_color, { predefined: '', custom: 'rgba(245, 245, 245, 0.6)' });
});

test('NEG: a colour no palette entry holds stays a literal (the deliberately-unique colour)', () => {
  const n = { atts: { overline_color: { predefined: '', custom: '#ff2d55' } } };
  bindPaletteColors(n, palette);
  assert.deepEqual(n.atts.overline_color, { predefined: '', custom: '#ff2d55' });
});

test('NEG: a key of unknown kind is left alone — its prefix cannot be chosen safely', () => {
  const n = { atts: { border_color: { predefined: '', custom: '#f5f5f5' } } };
  bindPaletteColors(n, palette);
  assert.deepEqual(n.atts.border_color, { predefined: '', custom: '#f5f5f5' });
});

test('NEG: an already-bound value is never rewritten, and no palette means no change', () => {
  const bound = { atts: { title_color: { predefined: 'text-primary', custom: '' } } };
  bindPaletteColors(bound, palette);
  assert.equal(bound.atts.title_color.predefined, 'text-primary');
  const n = { atts: { title_color: { predefined: '', custom: '#f5f5f5' } } };
  bindPaletteColors(n, []);
  assert.deepEqual(n.atts.title_color, { predefined: '', custom: '#f5f5f5' });
});

test('it reaches nested builder nodes, not just the top level', () => {
  const n = { items: [{ children: [{ atts: { subtitle_color: { predefined: '', custom: 'rgb(115,115,115)' } } }] }] };
  bindPaletteColors(n, palette);
  assert.equal(n.items[0].children[0].atts.subtitle_color.predefined, 'text-muted');
});

test('NEG: a PRESET DEFINITION keeps its literal — it is what other values point at', () => {
  // A button preset's own fill bound to `bg-primary` left the preset emitting NO background, because its
  // CSS generator reads the literal. The header CTA then rendered as a small unstyled white box with its
  // label invisible on it (a real-site audit).
  const n = {
    button_colors: [{
      color_name: 'Primary',
      states: { default: { bg_color: { predefined: '', custom: '#ffffff' }, text_color: { predefined: '', custom: '#000000' } } },
    }],
    theme_colors: [{ name: 'Primary', color: '#ffffff' }],
    atts: { title_color: { predefined: '', custom: '#f5f5f5' } },
  };
  bindPaletteColors(n, palette);
  assert.deepEqual(n.button_colors[0].states.default.bg_color, { predefined: '', custom: '#ffffff' },
    'a button preset definition must keep its literal fill');
  assert.deepEqual(n.theme_colors[0], { name: 'Primary', color: '#ffffff' },
    'the palette must never be rewritten to reference itself');
  assert.equal(n.atts.title_color.predefined, 'text-ink',
    'values that POINT at a preset still bind');
});
