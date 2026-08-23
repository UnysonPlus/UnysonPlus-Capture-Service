// Color Presets generator — turns a capture into a `presets.json` (`theme_colors`) so the
// converted site's Component Presets → Color Presets admin matches the captured /style-guide/.
// Without this the plugin's DEFAULT palette (Primary #0d6efd, Accent #fd7e14, …) is left in
// place and the style guide (which shows the real source colors) disagrees with the presets.
//
// Strategy: start from the SAME named palette the plugin ships (so the rich Material set is
// preserved), then OVERRIDE the brand/role entries with the captured values — using the exact
// same role→color mapping the style guide uses (Primary = brand accent, Secondary, the
// Bootstrap roles → their closest named preset). Only overrides where a value was captured.
//
// The plugin's FW_Site_Converter_Presets::import() writes the whole `theme_colors` array to the
// preset store, so emitting the full list (defaults + overrides) keeps every swatch intact.

import { buildIconBadgePresets } from './box-presets.mjs';

// The plugin's default palette — keep names/order in sync with
// framework/includes/presets/color-presets.php unysonplus_default_color_presets().
const DEFAULTS = [
  ['Primary', '#0d6efd'], ['Secondary', '#6c757d'], ['Accent', '#fd7e14'], ['Muted', '#adb5bd'],
  ['Black', '#000'], ['White', '#fff'], ['Gray', '#636c72'], ['Light Gray', '#bdbdbd'],
  ['Red', '#dc3545'], ['Pink', '#e91e63'], ['Purple', '#9c27b0'], ['Deep Purple', '#673ab7'],
  ['Indigo', '#3f51b5'], ['Blue', '#286090'], ['Light Blue', '#03a9f4'], ['Cyan', '#00bcd4'],
  ['Teal', '#009688'], ['Green', '#5cb85c'], ['Light Green', '#8bc34a'], ['Lime', '#cddc39'],
  ['Yellow', '#ffeb3b'], ['Amber', '#ffc107'], ['Orange', '#ff9800'], ['Deep Orange', '#ff5722'],
  ['Brown', '#795548'], ['Blue Gray', '#607d8b'],
];

// hsl token like "217 91% 53%" → hsl() string; pass-through hex/rgb; '' → ''. Mirrors the
// `col()` in to-styleguide.mjs so the presets and the style-guide swatches resolve identically.
const col = (v) => {
  v = String(v == null ? '' : v).trim();
  if (v === '') return '';
  if (/^(#|rgb|hsl)/i.test(v)) return v;
  if (/^\d+\s+[\d.]+%\s+[\d.]+%$/.test(v)) return `hsl(${v})`;
  return v;
};

// ------------------------------------------------------------------------------------
// Section Styles — cluster distinctive section BANDS into reusable presets.
//
// A section style is the reusable band SKIN: background + text/heading/link colours +
// border + radius. Per-section PADDING stays a native section option (the mapper already
// emits it), so presets leave padding empty, matching the plugin defaults.
//
// We emit a preset only for a section that DEVIATES from the base — one with its own
// background fill, border, radius, shadow or gradient — cluster near-identical bands into
// one preset, and only carry a text/heading colour when it actually differs from the page
// base (so a tinted band that keeps the body text does not force a colour). Plain bands are
// the theme default and get no preset. Output shape mirrors
// unysonplus_default_section_style_presets() in framework/includes/presets/section-style-presets.php.
const SS_U0    = { value: '', unit: 'px' };
const SS_EMPTY = { predefined: '', custom: '' };
const SS_PAD0  = {
  margin:  { all: '', top: '', right: '', bottom: '', left: '' },
  padding: { all: '', top: '', right: '', bottom: '', left: '' },
};
const ssCompact = (c) => ({ predefined: '', custom: c || '' });
const ssBgPro   = (c) => ({ color: { value: { predefined: '', custom: c } } });

function ssParse(s) {
  s = String(s == null ? '' : s).trim();
  let m = s.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+))?\s*\)$/i);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] != null ? +m[4] : 1 };
  m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) { let h = m[1]; if (h.length === 3) h = h.split('').map((c) => c + c).join(''); return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 }; }
  return null;
}
function ssNorm(s) {
  const c = ssParse(s);
  if (!c || c.a === 0) return '';                       // transparent / none = no fill
  return c.a < 1 ? `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})` : `rgb(${c.r}, ${c.g}, ${c.b})`;
}
const ssLum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; // 0..255

// diag → { border:{width,style,color}, sides:[…] } from the first present side, or null.
function ssBorder(diag) {
  const map = { top: diag.borderTop, right: diag.borderRight, bottom: diag.borderBottom, left: diag.borderLeft };
  const sides = Object.keys(map).filter((k) => map[k]);
  if (!sides.length) return null;
  const mm = String(map[sides[0]]).match(/^([\d.]+)px\s+(\w+)\s+(.+)$/);
  return {
    border: { width: { value: mm ? mm[1] : '', unit: 'px' }, style: mm ? mm[2] : 'solid', color: ssCompact(mm ? ssNorm(mm[3]) : '') },
    sides,
  };
}

export function sectionStyles(capture) {
  const secs = (capture && Array.isArray(capture.sections)) ? capture.sections : [];
  if (!secs.length) return null;
  const mode = (arr) => { const m = {}; arr.forEach((v) => v && (m[v] = (m[v] || 0) + 1)); return Object.entries(m).sort((a, b) => b[1] - a[1])[0]?.[0] || ''; };
  const baseText = mode(secs.map((s) => ssNorm((s.computed || {}).color)));
  const baseHead = mode(secs.map((s) => ssNorm((s.headingComputed || {}).color)));

  const groups = new Map();
  for (const s of secs) {
    const cmp = s.computed || {}, diag = s.diag || {};
    // Capture stores the resolved fill as `backgroundColor` (not the `background` shorthand) — reading
    // the shorthand left `bg` always empty, so pure colour-fill bands were dropped from the clustering.
    const bg = ssNorm(cmp.backgroundColor || cmp.background);
    const bd = ssBorder(diag);
    const radius = diag.borderRadius && diag.borderRadius !== '0px' ? diag.borderRadius : '';
    if (!(bg || bd || radius || diag.boxShadow || diag.gradient)) continue; // plain band = default
    const text = ssNorm(cmp.color);
    const head = ssNorm((s.headingComputed || {}).color);
    const key = [bg, radius, bd ? bd.sides.join('') + bd.border.style + bd.border.color.custom + bd.border.width.value : ''].join('|');
    if (!groups.has(key)) groups.set(key, { bg, bd, radius, text, head, count: 0 });
    groups.get(key).count++;
  }
  if (!groups.size) return null;

  const used = {};
  const nameFor = (bg) => {
    const c = ssParse(bg);
    let base = 'Band';
    if (c) { const L = ssLum(c); base = L < 90 ? 'Dark' : L > 245 ? 'Light' : 'Alt'; }
    used[base] = (used[base] || 0) + 1;
    return used[base] > 1 ? `${base} ${used[base]}` : base;
  };

  let n = 0;
  return [...groups.values()].sort((a, b) => b.count - a.count).map((g) => {
    const c = ssParse(g.bg);
    const isDark = c ? ssLum(c) < 90 : false;
    return {
      id: 's' + String(1000000001 + n++),
      style_name: nameFor(g.bg),
      background: g.bg ? ssBgPro(g.bg) : { color: { value: SS_EMPTY } },
      text_color:    (g.text && (isDark || g.text !== baseText)) ? ssCompact(g.text) : SS_EMPTY,
      heading_color: (g.head && (isDark || g.head !== baseHead)) ? ssCompact(g.head) : SS_EMPTY,
      link_color:    SS_EMPTY,
      border:        g.bd ? g.bd.border : { width: SS_U0, style: '', color: SS_EMPTY },
      border_sides:  g.bd ? g.bd.sides : ['top', 'right', 'bottom', 'left'],
      border_extent: { mode: 'full' },
      border_radius: g.radius ? { value: String(parseInt(g.radius, 10) || ''), unit: 'px' } : SS_U0,
      padding:       SS_PAD0,
    };
  });
}

// Background Patterns — turn the captured per-section decorative backgrounds (findPattern's
// { image, repeat, size, opacity }: SVG data-URIs + repeating gradients) into `background_patterns`
// presets ({ id, pattern_name, root_class, html, css }), matching unysonplus_default_pattern_presets().
// Only distinct patterns are kept; for a faithful clone these ARE the site's patterns, so (like
// section styles) the key is emitted only when the source actually has one.
export function backgroundPatterns(capture) {
  const secs = (capture && Array.isArray(capture.sections)) ? capture.sections : [];
  // PREVIEW-ONLY: the resolved background COLOUR of the section a pattern was captured on. A light/white mark
  // from a coloured band (the green section-9) is invisible on the editor's white preview, so the row's preview
  // iframe is painted with the band's colour. NEVER emitted into the pattern's output CSS. Parity w/ PHP.
  const bodyBg = (capture && capture.tokens && capture.tokens.body && capture.tokens.body.backgroundColor) ? String(capture.tokens.body.backgroundColor) : '';
  const _transp = (c) => !c || /transparent/i.test(c) || /rgba\([^)]*,\s*0(?:\.0+)?\s*\)/i.test(c);
  const sectionPreviewBg = (s) => {
    const cmp = (s && s.computed) || {};
    let pv = cmp.backgroundColor ? String(cmp.backgroundColor) : '';
    if (_transp(pv)) {
      const gi = String(cmp.backgroundImage || cmp.background || '');
      const gm = gi.match(/(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))/i);
      pv = (/gradient/i.test(gi) && gm) ? gm[1] : '';
    }
    if (_transp(pv)) pv = _transp(bodyBg) ? '' : bodyBg;
    return _transp(pv) ? '' : pv;
  };
  const seen = new Map();
  for (const s of secs) {
    const bp = s && s.bgPattern;
    if (!bp || !bp.image || bp.image === 'none') continue;
    const image = String(bp.image).trim();
    if (!image || image.length > 3000) continue;
    if (!seen.has(image)) {
      seen.set(image, { image, repeat: bp.repeat || '', size: bp.size || '', opacity: (bp.opacity != null ? bp.opacity : 1), count: 0, preview_bg: sectionPreviewBg(s) });
    }
    const e = seen.get(image);
    e.count++;
    if (!e.preview_bg) { e.preview_bg = sectionPreviewBg(s); } // first band that resolves a colour wins
  }
  if (!seen.size) return []; // no captured pattern → emit nothing, so the saved default library is preserved
  const derived = [...seen.values()].sort((a, b) => b.count - a.count).slice(0, 5).map((g, i) => {
    const n = i + 1;
    // Deterministic id from the image so a section's applied-pattern option (to-pages) resolves to THIS preset.
    // MUST match patternPresetId() in to-pages.mjs.
    const id = 'captured-' + (() => { const s = String(g.image || ''); let h = 5381; for (let j = 0; j < s.length; j++) h = ((h << 5) + h + s.charCodeAt(j)) >>> 0; return h.toString(16).padStart(8, '0').slice(0, 8); })();
    const cls = 'pat-' + id;
    const decls = [
      `background-image:${g.image}`,
      (g.repeat && g.repeat !== 'repeat') ? `background-repeat:${g.repeat}` : '',
      (g.size && g.size !== 'auto') ? `background-size:${g.size}` : '',
      (g.opacity < 1) ? `opacity:${g.opacity}` : '',
    ].filter(Boolean).join(';');
    return {
      id,
      pattern_name: 'Captured Pattern ' + n,
      root_class: cls,
      html: `<div class="${cls}"></div>`,
      css: `.${cls}{width:100%;height:100%;${decls}}`,
      // PREVIEW-ONLY editor metadata (the section colour the pattern sits on). NOT part of `decls`/`css`.
      preview_bg: g.preview_bg || '',
    };
  });
  // The importer REPLACES the whole option — so emit the captured patterns ON TOP of the plugin defaults,
  // or the built-in library is erased. (Same rule as Box Presets.) Mirror of unysonplus_default_pattern_presets().
  return derived.concat(DEFAULT_PATTERNS);
}

const _dp = (id, pattern_name, cls, decls) => ({ id, pattern_name, root_class: cls, html: `<div class="${cls}"></div>`, css: `.${cls}{width:100%;height:100%;${decls}}` });
const DEFAULT_PATTERNS = [
  _dp('dots', 'Dots', 'pat-dots', 'background-image:radial-gradient(rgba(0,0,0,.18) 1.6px,transparent 1.7px);background-size:22px 22px'),
  _dp('grid', 'Grid', 'pat-grid', 'background-image:linear-gradient(rgba(0,0,0,.12) 1px,transparent 1px),linear-gradient(90deg,rgba(0,0,0,.12) 1px,transparent 1px);background-size:26px 26px'),
  _dp('diagonal-stripes', 'Diagonal Stripes', 'pat-diagonal', 'background:repeating-linear-gradient(45deg,rgba(0,0,0,.07) 0 10px,transparent 10px 20px)'),
  _dp('vertical-stripes', 'Vertical Stripes', 'pat-vertical', 'background:repeating-linear-gradient(90deg,rgba(0,0,0,.07) 0 10px,transparent 10px 20px)'),
  _dp('horizontal-stripes', 'Horizontal Stripes', 'pat-horizontal', 'background:repeating-linear-gradient(0deg,rgba(0,0,0,.07) 0 10px,transparent 10px 20px)'),
  _dp('checkerboard', 'Checkerboard', 'pat-checker', 'background-image:linear-gradient(45deg,rgba(0,0,0,.1) 25%,transparent 25%,transparent 75%,rgba(0,0,0,.1) 75%),linear-gradient(45deg,rgba(0,0,0,.1) 25%,transparent 25%,transparent 75%,rgba(0,0,0,.1) 75%);background-size:28px 28px;background-position:0 0,14px 14px'),
  _dp('crosshatch', 'Crosshatch', 'pat-crosshatch', 'background-image:repeating-linear-gradient(45deg,rgba(0,0,0,.08) 0 1px,transparent 1px 12px),repeating-linear-gradient(-45deg,rgba(0,0,0,.08) 0 1px,transparent 1px 12px)'),
  _dp('triangles', 'Triangles', 'pat-triangles', 'background-image:linear-gradient(45deg,rgba(0,0,0,.09) 25%,transparent 25%),linear-gradient(-45deg,rgba(0,0,0,.09) 25%,transparent 25%);background-size:20px 20px'),
  _dp('chevron', 'Chevron', 'pat-chevron', 'background:linear-gradient(135deg,rgba(0,0,0,.08) 25%,transparent 25%) -12px 0/24px 24px,linear-gradient(225deg,rgba(0,0,0,.08) 25%,transparent 25%) -12px 0/24px 24px,linear-gradient(315deg,rgba(0,0,0,.08) 25%,transparent 25%) 0 0/24px 24px,linear-gradient(45deg,rgba(0,0,0,.08) 25%,transparent 25%) 0 0/24px 24px'),
  _dp('circles', 'Circles', 'pat-circles', 'background-image:radial-gradient(circle at 50% 50%,transparent 5px,rgba(0,0,0,.09) 6px,transparent 7px);background-size:24px 24px'),
  _dp('scales', 'Scales', 'pat-scales', 'background-image:radial-gradient(circle at 50% 100%,transparent 9px,rgba(0,0,0,.08) 10px,transparent 11px);background-size:24px 12px'),
  _dp('confetti', 'Confetti', 'pat-confetti', 'background-image:radial-gradient(rgba(0,0,0,.15) 1.6px,transparent 1.7px),radial-gradient(rgba(0,0,0,.1) 1.6px,transparent 1.7px);background-size:30px 30px,30px 30px;background-position:0 0,15px 15px'),
];

export function toPresets(designConfig, capture, iconBadgeSkins) {
  const cfg = designConfig || {};
  const cap = capture || {};
  const colors = cfg.colors || {};
  const vars = (cap.tokens && cap.tokens.vars) || {};

  // Role → named-preset overrides, matching to-styleguide.mjs's roleColors mapping exactly.
  // Primary = the detected brand accent first (to-design-config already corrects Bootstrap's
  // default --primary for sites that brand via the CTA), falling back to the raw --primary var.
  const overrides = {
    'Primary':    colors.accent || vars['--primary'],
    'Secondary':  vars['--secondary'],
    'Accent':     colors.accent,
    'Red':        vars['--danger'],
    'Green':      vars['--success'],
    'Amber':      vars['--warning'],
    'Cyan':       vars['--info'],
    'Black':      vars['--dark'] || colors.ink,
    'White':      vars['--light'],
    'Gray':       vars['--gray'] || vars['--gray-600'] || vars['--gray-700'],
    'Light Gray': vars['--gray-400'] || vars['--gray-300'] || vars['--gray-200'],
  };

  const theme_colors = DEFAULTS.map(([name, def]) => {
    const over = col(overrides[name]);
    return { name, color: over || def };
  });

  // Section styles come from the captured per-section bands. Only emit the key when the
  // source actually has ≥1 distinctive band, so a plain site keeps the plugin's Alt/Light/
  // Dark defaults (the importer skips absent keys) rather than getting an empty list.
  const section_style_presets = sectionStyles(cap);
  const background_patterns = backgroundPatterns(cap);

  // Icon Badge presets — cluster the captured icon-tile skins into `icon_badge_presets` (the JS
  // counterpart of PHP build_icon_badge_presets). Emitted only when the source actually has icon
  // tiles, so a plain site keeps the plugin's default Icon Badge library (the importer skips
  // absent keys). Rides the SAME presets bundle as theme_colors → same importer, same store.
  const icon_badge_presets = buildIconBadgePresets(iconBadgeSkins || []);

  return {
    values: {
      theme_colors,
      ...(section_style_presets && section_style_presets.length ? { section_style_presets } : {}),
      ...(background_patterns && background_patterns.length ? { background_patterns } : {}),
      ...(icon_badge_presets && icon_badge_presets.length ? { icon_badge_presets } : {}),
    },
  };
}
