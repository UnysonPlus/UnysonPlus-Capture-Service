// Browser-free fixture: a synthetic captured section list → section_style_presets. Guards the
// Section Styles clustering in to-presets.mjs sectionStyles(): only DISTINCTIVE bands (own bg /
// border / radius / shadow) become presets, near-identical bands cluster into one, colours are
// carried only when they differ from the page base (or the band is dark), and bands are named by
// luminance (Alt / Light / Dark). No browser — feeds a synthetic capture through the real function.
//
// Run: node to-presets.test.mjs   (exit 1 on any failure)
import { sectionStyles } from './to-presets.mjs';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + msg); if (!cond) fails++; };

const sec = (bg, text, heading, diag) => ({
  computed: { color: text, ...(bg ? { background: bg } : {}) },
  headingComputed: { color: heading },
  diag: diag || {},
});

// Page: 2 plain bands (base), 2 identical pink tint bands, 1 dark CTA band.
const BASE_TEXT = 'rgb(30, 30, 30)';
const BASE_HEAD = 'rgb(157, 23, 77)';
const home = { sections: [
  sec(null, BASE_TEXT, BASE_HEAD),                                  // plain → skipped
  sec('rgba(252, 231, 243, 0.4)', BASE_TEXT, BASE_HEAD),            // pink band A
  sec(null, BASE_TEXT, BASE_HEAD),                                  // plain → skipped
  sec('rgba(252, 231, 243, 0.4)', BASE_TEXT, BASE_HEAD),            // pink band B (clusters with A)
  sec('rgb(17, 24, 39)', 'rgb(255, 255, 255)', 'rgb(255, 255, 255)'), // dark CTA band
] };

const out = sectionStyles(home) || [];
ok(out.length === 2, `two distinctive bands → 2 presets (got ${out.length})`);

const alt = out.find((p) => p.style_name === 'Alt');
ok(!!alt, 'the tint band is named "Alt" (mid luminance)');
ok(alt && alt.background.color.value.custom === 'rgba(252, 231, 243, 0.4)', 'Alt carries the pink background');
ok(alt && alt.text_color.custom === '', 'Alt does NOT carry text colour (matches base)');
ok(alt && alt.heading_color.custom === '', 'Alt does NOT carry heading colour (matches base)');

const dark = out.find((p) => p.style_name === 'Dark');
ok(!!dark, 'the dark band is named "Dark" (low luminance)');
ok(dark && dark.background.color.value.custom === 'rgb(17, 24, 39)', 'Dark carries the dark background');
ok(dark && dark.text_color.custom === 'rgb(255, 255, 255)', 'Dark carries light text (dark band forces it even if == base)');
ok(dark && dark.heading_color.custom === 'rgb(255, 255, 255)', 'Dark carries light heading');

// Ordering: the more-common band (pink ×2) ranks before the single dark band.
ok(out[0].style_name === 'Alt', 'the more-frequent band is emitted first');

// A page with no distinctive bands emits nothing (keeps the plugin defaults).
const plain = sectionStyles({ sections: [ sec(null, BASE_TEXT, BASE_HEAD), sec(null, BASE_TEXT, BASE_HEAD) ] });
ok(plain === null, 'a plain page emits no section_style_presets (defaults preserved)');

// A border-only band (no bg) is still distinctive.
const bordered = sectionStyles({ sections: [ sec(null, BASE_TEXT, BASE_HEAD, { borderTop: '1px solid rgb(200, 200, 200)' }) ] });
ok(bordered && bordered.length === 1, 'a border-only band is distinctive → 1 preset');
ok(bordered && bordered[0].border.width.value === '1' && bordered[0].border.style === 'solid', 'the border width/style are carried');

console.log(fails ? `\n${fails} FAILED` : '\nAll passed');
process.exit(fails ? 1 : 0);
