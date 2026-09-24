// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Map a design-capture's body sections → an editable page-builder page (the "copy the
// whole thing" body path). Emits the { pages: [ … ] } payload the Site Converter's Pages
// importer consumes — which sets the post's page-builder option so the plugin's own encoder
// regenerates post_content (nothing hand-coded), leaving every section editable in the builder.
//
// VERBATIM MIRROR (same technique as the header/footer raw-chrome path): each source
// <section> becomes a full-width builder `section` → one `column` → one `code-block` holding
// the section's EXACT outerHTML (captured in capture-extract.mjs as `section.rawHtml`, URLs
// absolutized + scripts stripped). `code-block` is the universal FALLBACK shortcode for any
// markup we don't yet map to a dedicated shortcode — its `code-editor` field outputs raw,
// un-processed HTML and survives the builder save intact. The section's OWN CSS (captured as
// `section.css`) rides in the section's Advanced → Custom CSS, so it travels with the section
// and renders late enough to win the cascade. Shared framework CSS (Bootstrap, fonts, :root,
// chrome) stays global in the theme (raw_chrome.css). <img src> is re-pointed to the imported
// attachment at import time.
//
// The builder section/column are neutral wrappers (full-width + a `.sc-mirror` reset zeroes
// their container/gutter padding in the theme CSS) so the source markup owns its own layout.
// Heavy default att-blobs are cloned from atom-templates.json (real nodes from a proven
// export); only the CONTENT is swapped, per "clone shapes from a real export, only swap content."

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { sectionStyles } from './to-presets.mjs';
import { buildButtonPresets } from './to-theme-settings.mjs';
import { parseLinearGradient } from './box-presets.mjs';
import { makeButtonResolver } from './button-match.mjs';

// 32-hex unique id for each builder node (matches the export's unique_id shape).
// Web Crypto works in both Node (19+) and Cloudflare Workers, so the mapper is
// portable to the hosted renderer without a Node-only dependency.
const uid = () => {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};

// Default atom templates are read from disk lazily (Node CLI only). A hosted/Worker
// caller passes opts.atoms (an imported JSON), so the filesystem is never touched there.
let _atoms = null;
const defaultAtoms = () => {
  if (!_atoms) _atoms = JSON.parse(readFileSync(new URL('./atom-templates.json', import.meta.url), 'utf8'));
  return _atoms;
};

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Flatten a decomposed section's CSS so wrapper-scoped rules map onto the rebuilt markup:
// `.banner .block h1` → `.banner h1`. Recurses @media/@supports; leaves @font-face/@keyframes
// and 1-2 token selectors untouched. (Mirrors FW_Site_Converter_Mapper::flatten_css.)
const flattenSelectors = (sel) => sel.split(',').map((p) => {
  p = p.trim();
  if (!p) return '';
  const toks = p.split(/\s*[>+~]\s*|\s+/).filter(Boolean);
  return toks.length <= 2 ? p : toks[0] + ' ' + toks[toks.length - 1];
}).filter(Boolean).join(', ');
// Standard Tailwind @keyframes (mirror of to-mirror.mjs TW_KEYFRAMES). The per-section CSS harvest keeps
// only STYLE rules, so a decomposed section that uses `animate-bounce` (e.g. the hero's verbatim "24/7
// Care" badge) gets the `.animate-bounce` rule — which sets `animation-name: bounce` — but NOT the
// `@keyframes bounce`, so the browser names an animation that has no frames and NOTHING moves. Re-emit the
// standard keyframes for any known Tailwind animation a section uses (its content HTML or carried CSS) and
// hasn't already defined, so the animation actually runs.
const TW_KEYFRAMES = {
  bounce: '@keyframes bounce{0%,100%{transform:translateY(-25%);animation-timing-function:cubic-bezier(.8,0,1,1)}50%{transform:none;animation-timing-function:cubic-bezier(0,0,.2,1)}}',
  pulse: '@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}',
  spin: '@keyframes spin{to{transform:rotate(360deg)}}',
  ping: '@keyframes ping{75%,100%{transform:scale(2);opacity:0}}',
};
const missingKeyframes = (haystack) => {
  haystack = String(haystack || '');
  const used = new Set(); let m;
  const re = /\banimate-(bounce|pulse|spin|ping)\b|animation(?:-name)?\s*:\s*(bounce|pulse|spin|ping)\b/gi;
  while ((m = re.exec(haystack))) { used.add((m[1] || m[2]).toLowerCase()); }
  let out = '';
  for (const name of used) { if (TW_KEYFRAMES[name] && !new RegExp('@keyframes\\s+' + name + '\\b').test(haystack)) { out += '\n' + TW_KEYFRAMES[name]; } }
  return out;
};
const flattenCss = (css) => {
  css = String(css || '');
  if (!css.trim()) return '';
  let out = '', buf = '', i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '{') {
      const prelude = buf.trim(); buf = '';
      let depth = 1; i++; let body = '';
      while (i < css.length && depth > 0) { const c = css[i]; if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; } body += c; i++; }
      i++;
      if (prelude[0] === '@') {
        out += /^@(media|supports)/i.test(prelude) ? prelude + '{' + flattenCss(body) + '}' : prelude + '{' + body + '}';
      } else {
        out += flattenSelectors(prelude) + '{' + body + '}';
      }
    } else { buf += ch; i++; }
  }
  return out;
};

/* ---------------------------------------------------------------------- *
 * HI-FI FAITHFUL BASE (Pass-2) — JS twin of PHP FW_Site_Converter_Mapper.
 *
 * For every APPEARANCE property the native shortcode/preset mapping does NOT already reproduce, emit a
 * specificity-0 `:where(selector){…}` rule so the element looks EXACTLY like the source, while theme
 * settings / presets / builder edits still override. Byte-shape identical to the PHP output: the property
 * ORDER is CS_APPEARANCE (== PHP $cs_appearance), values as-captured, wrapped in `:where(selector){…}`.
 * ---------------------------------------------------------------------- */

// APPEARANCE properties the faithful base reproduces (SAME order as PHP $cs_appearance → byte-shape parity).
// Layout/structure + spacing are intentionally EXCLUDED (handled natively / by Pass-1 spacing→native).
const CS_APPEARANCE = [
  'background-color', 'background-image', 'color', 'font-family', 'font-size', 'font-weight',
  'line-height', 'letter-spacing', 'text-align', 'text-transform', 'text-decoration-line',
  'border', 'border-radius', 'box-shadow', 'opacity', 'transform',
  // Gradient TEXT (background-clip:text) — the clip + transparent fill that make a gradient
  // background paint the TEXT instead of a block. Captured only when the source paints gradient
  // text; csValueInert drops any non-`text` clip / non-transparent fill (parity with PHP $cs_appearance).
  '-webkit-background-clip', 'background-clip', '-webkit-text-fill-color',
];

// Is a computed appearance value visually INERT (a browser initial that carries no look)? Twin of PHP
// Mapper::cs_value_inert — keeps the base lean (an element at the CSS default for a prop gets no rule).
const csValueInert = (prop, v) => {
  v = String(v == null ? '' : v).trim().toLowerCase();
  if (v === '') return true;
  switch (prop) {
    case 'background-color':     return v === 'transparent' || v === 'rgba(0, 0, 0, 0)';
    case 'background-image':     return v === 'none';
    case 'box-shadow':           return v === 'none';
    case 'transform':            return v === 'none';
    case 'opacity':              return v === '1';
    case 'border':               return v.indexOf('0px') === 0 || v.indexOf(' none ') !== -1 || /^0(px)?\s/.test(v);
    case 'border-radius':        return v === '0px' || v === '0';
    case 'text-transform':       return v === 'none';
    case 'text-decoration-line': return v === 'none';
    case 'letter-spacing':       return v === 'normal';
    case 'line-height':          return v === 'normal';
    case 'font-weight':          return v === '400' || v === 'normal';
    case 'text-align':           return v === 'start' || v === 'left';
    // Gradient-text clip: only `text` carries a look; default `border-box` is inert.
    case '-webkit-background-clip':
    case 'background-clip':       return v !== 'text';
    // The transparent fill reveals the gradient through glyphs; any solid fill is just `color` → inert.
    case '-webkit-text-fill-color': return v !== 'transparent' && v !== 'rgba(0, 0, 0, 0)';
  }
  return false;
};

/**
 * Pass-2 FAITHFUL BASE — the specificity-0 `:where(selector){…}` rule of every appearance property in the
 * element's computed style (`cs`, a { cssProp: value } map == PHP's parsed data-sc-cs) that the native
 * mapping (`already`) did NOT cover, minus visually-inert defaults. '' when nothing remains (hi-fi off /
 * no cs / everything already covered). Byte-shape identical to PHP Mapper::hifi_base_css.
 *
 * @param {Object} cs      { cssProp: value } computed appearance map
 * @param {string[]} already property names the node already reproduces natively (skip → lean base)
 * @param {boolean} on     hi-fi master switch (default ON; false → '')
 * @returns {string} a `:where(selector){…}` rule, or ''
 */
const hifiBaseCss = (cs, already = [], on = true) => {
  if (!on || !cs || typeof cs !== 'object') return '';
  const flip = {};
  for (const p of already) flip[p] = true;
  let body = '';
  for (const pr of CS_APPEARANCE) {
    if (flip[pr]) continue;
    const v = cs[pr];
    if (v == null || String(v).trim() === '') continue;
    if (csValueInert(pr, v)) continue;
    body += pr + ':' + String(v).trim() + ';';
  }
  return body === '' ? '' : ':where(selector){' + body + '}';
};

// Append a faithful base (built from `cs` minus `already`) to a node's Custom CSS (additive). Twin of PHP
// Mapper::apply_hifi_base — the node's `selector` token is substituted for the element selector at render.
const applyHifiBase = (node, cs, already = [], on = true) => {
  if (!node || !node.atts || typeof node.atts !== 'object') return node;
  const base = hifiBaseCss(cs, already, on);
  if (base === '') return node;
  const cur = node.atts.custom_css ? String(node.atts.custom_css) : '';
  node.atts.custom_css = (cur + (cur !== '' ? '\n' : '') + base).trim();
  return node;
};

// Deterministic Background Pattern preset id from its background-image — MUST match the copy in to-presets.mjs
// so a section's applied-pattern option resolves to the registered preset. (A djb2 hash, not the PHP md5, but
// the two JS modules agree with each other, which is what matters within the capture-service path.)
export const patternPresetId = (img) => {
  const s = String(img || ''); let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return 'captured-' + h.toString(16).padStart(8, '0').slice(0, 8);
};

// UnysonPlus spacing scale (rem → slug); px = rem × 16. Twin of PHP Mapper::rem_to_spacing_slug.
const _SPACING_SCALE_HIFI = [[0, '0'], [0.25, '1'], [0.5, '2'], [1, '3'], [1.5, '4'], [3, '5'], [3.5, '6'], [4, '7'], [4.5, '8'], [5, '9'], [6, '10'], [7, '11'], [8, '12']];
const spacingPxToSlug = (px) => {
  const rem = parseFloat(px) / 16;
  let best = '0', bd = Infinity;
  for (const [r, s] of _SPACING_SCALE_HIFI) { const d = Math.abs(r - rem); if (d < bd) { bd = d; best = s; } }
  return best;
};
const _pxOfHifi = (v) => { const m = String(v == null ? '' : v).match(/(-?[0-9.]+)\s*px/); return m ? parseFloat(m[1]) : 0; };

/**
 * Pass-1 SPACING → NATIVE — read the element's computed vertical MARGIN from `cs` and map each side to the
 * nearest spacing-scale token, merged into a native `spacing` box (only sides not already set). Horizontal
 * margin / padding stay structural. Twin of PHP Mapper::apply_native_margin.
 */
const applyNativeMargin = (spacing, cs, on = true) => {
  if (!on || !cs || typeof cs !== 'object' || !spacing || !spacing.margin) return spacing;
  const pairs = { 'margin-top': ['top', 'mt'], 'margin-bottom': ['bottom', 'mb'] };
  for (const prop of Object.keys(pairs)) {
    const [side, pref] = pairs[prop];
    const v = cs[prop];
    if (v == null || String(v).trim() === '') continue;
    if (spacing.margin[side] && spacing.margin[side] !== '') continue;         // don't overwrite a class-mapped side
    if (String(v).indexOf('var(') !== -1 || String(v).indexOf('auto') !== -1) continue;
    const px = _pxOfHifi(v);
    if (px < 6) continue;                                                        // ignore hairline/zero margins
    const slug = spacingPxToSlug(px);
    if (slug === '0') continue;
    spacing.margin[side] = pref + '-' + slug;
  }
  return spacing;
};

/**
 * Pass #6 — PER-BREAKPOINT RESPONSIVE CARRY (visibility). PHP twin: Mapper::responsive_hide_from_classes().
 * Map a source element's Tailwind responsive VISIBILITY utilities (already in the carried markup) → the
 * native `responsive_hide` selection (hide-xs <768 / hide-sm 768–991 / hide-md ≥992, rendered by
 * sc_build_wrapper_attr + frontend-grid.css). Class-derived only — no extra capture pass, no body-wide CSS.
 * Two unambiguous single-toggle families; anything else → {} (no guess). A bare `hidden` (no responsive
 * un-hide) is ignored — that's a removed element, not a per-breakpoint change.
 */
const responsiveHideFromClasses = (cls) => {
  const c = ' ' + String(cls == null ? '' : cls).toLowerCase().replace(/\s+/g, ' ').trim() + ' ';
  if (c.trim() === '') return {};
  const disp = 'block|flex|grid|inline|inline-block|inline-flex|table|inline-table|flow-root|contents';
  const baseHidden = / hidden /.test(c);
  const showM = c.match(new RegExp(' (sm|md|lg|xl|2xl):(' + disp + ') '));
  const hideM = c.match(/ (sm|md|lg|xl|2xl):hidden /);
  // Family A — base hidden, re-shown from {bp} up → hide BELOW {bp}. Skip if it also re-hides (ambiguous).
  if (baseHidden && showM && !hideM) {
    return (showM[1] === 'sm' || showM[1] === 'md') ? { 'hide-xs': true } : { 'hide-xs': true, 'hide-sm': true };
  }
  // Family B — base visible, hidden from {bp} up. Skip if it also re-shows at a larger bp (ambiguous).
  if (!baseHidden && hideM && !showM) {
    return (hideM[1] === 'sm' || hideM[1] === 'md') ? { 'hide-sm': true, 'hide-md': true } : { 'hide-md': true };
  }
  return {};
};

/**
 * Assemble a data-sc-cs-equivalent { cssProp: value } map from a block's flat computed fields (+ an optional
 * nested `styles` object, the shape capture-extract's styleOf() emits). Matches PHP's data-sc-cs prop set so
 * hifiBaseCss / applyNativeMargin see the SAME appearance properties the PHP path reads.
 */
const csFromFields = (f) => {
  f = f || {};
  const st = f.styles || {};
  const cs = {};
  const put = (k, ...cands) => { for (const c of cands) { if (c != null && String(c).trim() !== '') { cs[k] = String(c).trim(); return; } } };
  put('background-color', f.bg, st.bg, f.backgroundColor);
  put('background-image', f.bgImage, st.bgImage, f.backgroundImage);
  put('color', f.color, st.color);
  put('font-family', f.fontFamily, st.fontFamily);
  put('font-size', f.fontSize, st.fontSize);
  put('font-weight', f.fontWeight, st.fontWeight);
  put('line-height', f.lineHeight, st.lineHeight);
  put('letter-spacing', f.letterSpacing, st.letterSpacing);
  put('text-align', f.textAlign, f.align, st.textAlign);
  put('text-transform', f.textTransform, st.textTransform);
  // styleOf stores the full text-decoration shorthand; PHP's prop is text-decoration-line (first token).
  const td = f.textDecoration != null ? f.textDecoration : st.textDecoration;
  if (td && String(td).trim() !== '') cs['text-decoration-line'] = String(td).trim().split(/\s+/)[0];
  put('border', f.border, st.border);
  put('border-radius', f.borderRadius, st.borderRadius);
  put('box-shadow', f.boxShadow, st.boxShadow);
  put('opacity', f.opacity, st.opacity);
  put('transform', f.transform, st.transform);
  put('margin-top', f.marginTop, st.marginTop);
  put('margin-bottom', f.marginBottom, st.marginBottom);
  return cs;
};

// Named exports for parity tests (node --test). The pure Pass-1/Pass-2 twins + the spacing mapping.
export { CS_APPEARANCE, csValueInert, hifiBaseCss, applyHifiBase, applyNativeMargin, spacingPxToSlug, csFromFields };

/**
 * Bind compact colour values to the palette the same conversion generated: an exact OPAQUE match becomes
 * `{predefined:'text-<slug>'|'bg-<slug>', custom:''}`, so editing that preset in Theme Settings moves every
 * element the source painted with it. MIRROR of PHP Stitch::bind_palette_colors.
 *
 * Guards (all four matter): the `predefined` half is a PREFIXED CLASS, so only keys of a known kind bind —
 * a `bg-` class on a text field paints the wrong property; the halves are mutually exclusive, so `custom`
 * is cleared; a translucent value has no preset to point at; and a colour with no palette entry stays a
 * literal (the deliberately-unique colour).
 */
const BIND_TEXT_KEYS = new Set(['title_color','subtitle_color','overline_color','text_color','heading_color','link_color','color','font_color','label_color','menu_color','nav_color','scroll_link_color']);
const BIND_BG_KEYS = new Set(['bg_color','background_color','scroll_bg_color','fill_color','header_bg_color','footer_bg_color','section_bg_color']);
// A PRESET DEFINITION holds a LITERAL — it is the thing other values point AT, so a reference inside one
// is circular, and its consumer generates CSS from that literal (a class name yields no declaration at
// all). A real-site audit: a button preset's `bg_color` bound to `bg-primary`, the preset emitted no
// background, and the header CTA rendered as a small unstyled white box with its label invisible on it.
// Values that POINT at these presets still bind; only the definitions are skipped. PHP twin: $preset_keys.
const PRESET_DEF_KEYS = new Set(['theme_colors', 'button_colors', 'box_presets', 'table_presets', 'section_style_presets', 'container_width_presets', 'badge_presets', 'card_presets']);
export function bindPaletteColors(node, palette) {
  if (!Array.isArray(palette) || !palette.length) return node;
  const map = new Map();
  for (const e of palette) {
    if (!e || !e.name || !e.color) continue;
    const slug = String(e.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const hex = toHexOpaque(String(e.color));
    if (slug && hex && !map.has(hex)) map.set(hex, slug); // first wins = the derived brand roles, which lead
  }
  if (!map.size) return node;
  const walk = (n, key) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const v of n) walk(v, key); return; }
    if ('predefined' in n && 'custom' in n && !String(n.predefined || '').trim() && String(n.custom || '').trim()) {
      const kind = BIND_BG_KEYS.has(key) ? 'bg' : (BIND_TEXT_KEYS.has(key) ? 'text' : '');
      if (kind) {
        const lit = String(n.custom).trim();
        if (!/rgba?\([^)]*[,/]\s*(?:0?\.\d+|0)\s*\)$/i.test(lit) && !/hsla\(/i.test(lit)) {
          const hex = toHexOpaque(lit);
          if (hex && map.has(hex)) { n.predefined = (kind === 'bg' ? 'bg-' : 'text-') + map.get(hex); n.custom = ''; }
        }
      }
      return;
    }
    for (const k of Object.keys(n)) { if (PRESET_DEF_KEYS.has(k)) continue; walk(n[k], k); }
  };
  walk(node, '');
  return node;
}
/** An OPAQUE colour as lowercase #rrggbb; '' for anything translucent or unparseable. */
function toHexOpaque(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return '';
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return '#' + m[1].split('').map((c) => c + c).join('');
  m = /^#([0-9a-f]{6})$/.exec(s);
  if (m) return '#' + m[1];
  m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(s);
  if (m) {
    if (m[4] !== undefined) { const a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]); if (a < 0.995) return ''; }
    return '#' + [m[1], m[2], m[3]].map((x) => Math.max(0, Math.min(255, parseInt(x, 10))).toString(16).padStart(2, '0')).join('');
  }
  return '';
}

export function toPages(capture, opts = {}) {
  const atoms = opts.atoms || defaultAtoms();
  // Hi-fi faithful base master switch — DEFAULT ON (parity with PHP build_bundle's `hifi_css` default).
  const hifiCss = opts.hifiCss !== false;
  const clone = (k) => structuredClone(atoms[k]);
  // TEXT STYLE presets for THIS conversion (capture-extract typography.textStyles) — BODY roles only
  // (non-`display-*`, non-empty class), so a text block's computed font-size maps to Lead/Subtitle/Small/…
  // rather than to a Display or the style-only Eyebrow. MIRROR of PHP Mapper::set_text_presets/text_preset_for.
  const textPresets = (((capture && capture.typography && capture.typography.textStyles) || []))
    .filter((e) => e && e.class && !String(e.class).startsWith('display-') && parseFloat(e.size) > 0)
    .map((e) => ({ class: String(e.class), size: parseFloat(e.size) }));
  // A computed font-size (px) → the nearest BODY size-preset CLASS within ±1.5px, or '' (Default/base).
  const textPresetFor = (px) => {
    if (px === null || !textPresets.length) return '';
    let best = '', bestd = Infinity;
    for (const p of textPresets) { const d = Math.abs(p.size - px); if (d < bestd) { bestd = d; best = p.class; } }
    return bestd <= 1.5 ? best : '';
  };
  // EVERY Text Style (the full treatment): a style with no class is picked by its name slug (font-<slug>), the class the
  // Text Style dropdown offers — so the style-only Eyebrow counts. PHP: Mapper::$text_styles.
  const textStyles = (((capture && capture.typography && capture.typography.textStyles) || []))
    .filter((e) => e && parseFloat(e.size) > 0)
    .map((e) => ({ class: String(e.class || '').trim() || ('font-' + String(e.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')), size: parseFloat(e.size), weight: String(e.weight || '').trim(), lh: String(e.line_height || '').trim(), ls: String(e.letter_spacing || '').trim(), transform: String(e.transform || '').trim().toLowerCase() }))
    .filter((e) => e.class && e.class !== 'font-' && !e.class.startsWith('display-'));
  // A text's FULL measured treatment (size + transform + tracking + weight) → the matching Text Style entry, or null. A
  // tracked uppercase 12px label matches the Eyebrow, never the 11px Caption the size-only match would pick. Each
  // property the preset declares must agree (size ±1.5px; transform equal; tracking within 0.2px — an em preset scaled by
  // its size; weight equal when both set); a preset with a transform never matches plain text. PHP: text_style_for.
  const textStyleFor = (t) => {
    const px = parseFloat(t && t.size) || 0; if (px <= 0 || !textStyles.length) return null;
    let tt = String(t.transform || '').trim().toLowerCase(); if (tt === 'none') tt = '';
    const ls = String(t.ls || '').trim(); let lsv = (ls === '' || ls === 'normal') ? 0 : parseFloat(ls) || 0; if (/^-?[0-9.]+r?em$/.test(ls)) lsv = parseFloat(ls) * px;
    let wt = String(t.weight || '').trim(); if (wt === 'normal') wt = '400'; if (wt === 'bold') wt = '700';
    let best = null, bestd = Infinity;
    for (const st of textStyles) {
      const d = Math.abs(st.size - px); if (d > 1.5) continue;
      const stt = st.transform === 'none' ? '' : st.transform; if (stt !== tt) continue;
      if (st.ls !== '') { let pls = parseFloat(st.ls) || 0; if (!/px$/.test(st.ls)) pls = pls * st.size; if (Math.abs(pls - lsv) > 0.2) continue; }
      else if (Math.abs(lsv) > 0.2 && tt === '') continue;
      if (st.weight !== '' && wt !== '' && st.weight !== wt) continue;
      const score = d + (st.ls !== '' ? 0 : 0.5) + (stt !== '' ? 0 : 0.25);
      if (score < bestd) { bestd = score; best = st; }
    }
    return best;
  };
  const origin = (() => { try { return new URL(capture.url || '').origin; } catch { return ''; } })();
  // De-brand absolute links back to the source origin → site-relative (used for carousel buttons).
  const localize = (href) => {
    href = (href || '').trim();
    if (!href || href === '#') return '#';
    if (origin && href.toLowerCase().startsWith(origin.toLowerCase())) {
      const rest = href.slice(origin.length) || '/';
      return rest[0] === '/' ? rest : '/' + rest;
    }
    return href;
  };

  // Fresh unique_id, and clear any css_id baked into the cloned atom (the `section` atom
  // carries a stale id="hero" from the export it was traced from — without this every
  // section would render id="hero").
  const stamp = (n) => { if (n.atts) { n.atts.unique_id = uid(); n.atts.css_id = ''; } return n; };

  // SECTION BAND FILL → the section's NATIVE background. Parity with the PHP mapper's n_section:
  // a detected full-bleed band fill LINKS to an existing Section Style preset when the colour matches
  // one within tolerance (set `variant` = its slug — the CTA green → the built "Alt" preset), else it
  // stays a direct background.color.custom. Linking avoids hardcoding the same colour twice.
  const _rgb = (c) => {
    c = String(c == null ? '' : c).trim().toLowerCase();
    if (!c || c === 'transparent' || c.includes('gradient')) return null;
    let m = c.match(/rgba?\(\s*(\d{1,3})[,\s]+(\d{1,3})[,\s]+(\d{1,3})(?:[,\s/]+([\d.]+))?/);
    if (m) { if (m[4] != null && m[4] !== '' && parseFloat(m[4]) < 0.85) return null; return [+m[1], +m[2], +m[3]]; }
    m = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
    if (m) { let h = m[1]; if (h.length === 3) h = h.split('').map((x) => x + x).join(''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
    return null;
  };
  // Build the SAME Section Style presets theme-settings carries → { slug, rgb } for colour-matching. The
  // slug is derived from style_name exactly like PHP's unysonplus_section_style_preset_slug_map().
  const _secPresets = (() => {
    const out = []; const seen = {};
    for (const sp of (sectionStyles(capture) || [])) {
      const bg = sp && sp.background && sp.background.color && sp.background.color.value ? sp.background.color.value.custom : '';
      const rgb = _rgb(bg);
      if (!rgb) continue;
      let slug = String(sp.style_name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      if (!slug) slug = String(sp.id || '').toLowerCase();
      if (!slug) continue;
      const base = slug; let n = 1;
      while (seen[slug]) { n++; slug = base + '-' + n; }
      seen[slug] = true;
      out.push({ slug, rgb });
    }
    return out;
  })();
  const _matchPreset = (rgb) => {
    if (!rgb || !_secPresets.length) return '';
    let best = '', bestd = Infinity;
    for (const p of _secPresets) {
      const d = Math.abs(p.rgb[0] - rgb[0]) + Math.abs(p.rgb[1] - rgb[1]) + Math.abs(p.rgb[2] - rgb[2]);
      if (d < bestd) { bestd = d; best = p.slug; }
    }
    return bestd <= 18 ? best : ''; // tight tolerance so distinct bands don't collapse
  };
  // Apply a detected band-fill colour onto a built section node: link a preset (variant) when it matches,
  // else keep the direct custom bg. Returns true when it linked a preset (caller must NOT also set custom).
  const applyBandFill = (sNode, bgColor) => {
    const rgb = _rgb(bgColor);
    if (!rgb || !sNode || !sNode.atts) return false;
    const slug = _matchPreset(rgb);
    if (slug) {
      sNode.atts.variant = slug;
      if (sNode.atts.background && sNode.atts.background.color && sNode.atts.background.color.value) {
        sNode.atts.background.color.value.custom = ''; // preset paints it — no double-apply
      }
      return true;
    }
    return false;
  };

  // BUTTON preset linking — parity with the PHP mapper's set_button_presets()/button_preset_for(): the
  // SAME button_colors / button_sizes presets theme-settings carries → a converted BODY button attaches
  // the matching color-preset slug (style=btn-{slug}) + size-preset slug (size=btn-{slug}), exactly like
  // the header CTA. Built from capture.home.buttonSkins (or opts.buttonPresets when the caller precomputed
  // them). The per-node custom_css (exact fill/padding) stays as the ADDITIVE safety net.
  // BUTTON preset linking — the SHARED resolver (button-match.mjs, also used for the header CTAs in
  // to-theme-settings.mjs): the SAME button_colors / button_sizes presets theme-settings carries → a converted
  // BODY button attaches the matching color-preset slug (style=btn-{slug}) + size-preset slug (size=btn-{slug}),
  // exactly like the header CTA. Built from capture.home.buttonSkins (or opts.buttonPresets when the caller
  // precomputed them). The per-node custom_css (exact fill/padding) stays as the ADDITIVE safety net.
  const _btnResolver = makeButtonResolver(opts.buttonPresets || (() => { try { return buildButtonPresets(capture.home || capture); } catch { return null; } })());
  const _btnPresets = _btnResolver.presets;
  const _pxNum = (v) => { const m = String(v == null ? '' : v).trim().match(/^(-?[0-9.]+)\s*px?$/i); return m ? parseFloat(m[1]) : null; };
  const _buttonPresetFor = (b) => _btnResolver.presetFor(b);

  // Optional conversion-report trace (no-op unless opts.trace is an array). Records the
  // per-section decision and per-element source→shortcode mapping so the deterministic
  // capture can emit a report with NO AI. Additive: it never affects the returned tree, and
  // keeping it here (the real mapper) means the report can't drift from the actual conversion.
  const trace = Array.isArray(opts.trace) ? opts.trace : null;
  const rec = (e) => { if (trace) trace.push(e); };
  const snip = (h) => String(h == null ? '' : h).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
  // Richer fields for the HTML report's click-to-expand detail (kept out of the CSV).
  const snipFull = (h) => String(h == null ? '' : h).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
  const rawCap = (h) => String(h == null ? '' : h).slice(0, 1600);

  // Strip NUMERIC/arbitrary spacing utilities (mb-10, p-8, px-[12px], gap-4, space-y-2) from the class
  // attributes INSIDE a carried HTML string — they collide 1:1 BY NAME with the plugin's own spacing
  // utilities on a DIFFERENT scale (`.mb-10` → 96px, not Tailwind's 40px), and content HTML isn't
  // class-sanitized so they'd otherwise slip through. Keeps `-auto` (mx-auto centring) and non-spacing
  // classes. The real margin/padding is reproduced from the computed value in custom_css.
  const stripSpacingInHtml = (html) => String(html || '').replace(/\sclass="([^"]*)"/g, (m, cls) => {
    const kept = cls.split(/\s+/).filter((c) => {
      const base = c.replace(/^-/, '').replace(/^(?:[\w]+:)+/, '');
      return !/^(?:[pm][xytrbl]?|gap(?:-[xy])?|space-[xy])-(?:\d|\[)/.test(base);
    }).join(' ');
    return ' class="' + kept + '"';
  });

  const textBlock = (html, s) => {
    const n = stamp(clone('text_block'));
    n.atts.text = stripSpacingInHtml(html);
    n.atts.css_class = '';
    // Reproduce the source text's computed style so NO class effect is dropped: colour → native
    // text_color; font-size / line-height / letter-spacing / weight / alignment / bottom margin → the
    // shortcode's Advanced Custom CSS (`selector` = the text block). Only non-default values are set.
    let fontSizePreset = '';
    let owned = {};
    if (s) {
      const clean = (v) => String(v || '').trim();
      if (/^rgb/i.test(clean(s.color))) { n.atts.text_color = { predefined: '', custom: rgbToCss(s.color) }; }
      // TEXT STYLE preset — match the block's OWN computed font-size to the nearest BODY preset (Lead/
      // Subtitle/Small/Caption) so the text references an editable preset CLASS instead of a frozen px.
      // Base (16) / no match within tolerance → '' (Default). MIRROR of PHP n_text. When a preset IS
      // assigned, the redundant `font-size` decl below is dropped so the editable preset owns the size.
      const fsm = clean(s.fontSize).match(/^([0-9.]+)px$/);
      fontSizePreset = fsm ? (() => { const st = textStyleFor({ size: parseFloat(fsm[1]), transform: clean(s.textTransform), ls: clean(s.letterSpacing), weight: clean(s.fontWeight) }); return st ? st.class : textPresetFor(parseFloat(fsm[1])); })() : ''; // the FULL treatment first (a tracked uppercase label → the Eyebrow), the size-only body role second (PHP: n_text)
      n.atts.font_size_preset = fontSizePreset;
      // what the matched Text Style OWNS (the weight / tracking / transform / leading it declares) is not repeated on the block (PHP: the mirror leaf's owned list)
      owned = fontSizePreset ? (textStyles.find((e) => e.class === fontSizePreset) || {}) : {};
      const d = [];
      // PASS #2 NATIVE STRUCTURE PROMOTION — horizontal alignment → the text_block's NATIVE, editable
      // `text_align` option (a Bootstrap `text-*` class on the wrapper — node-scoped, never body-wide)
      // instead of a scoped `selector{text-align}` rule. Parity with the PHP n_text promotion. `justify`
      // has no native alignment option, so it stays on the scoped custom CSS.
      const ta = clean(s.textAlign);
      if (/^(center|right)$/.test(ta)) { n.atts.text_align = ta; }
      else if (ta === 'justify') { d.push('text-align:justify'); }
      const fs = clean(s.fontSize); if (fs && fs !== '16px' && !fontSizePreset) d.push('font-size:' + fs);
      const lh = clean(s.lineHeight); if (lh && lh !== 'normal' && !owned.lh) d.push('line-height:' + lh);
      const ls = clean(s.letterSpacing); if (ls && ls !== 'normal' && !owned.ls) d.push('letter-spacing:' + ls);
      const fw = parseInt(s.fontWeight, 10) || 0; if (fw >= 600 && !owned.weight) d.push('font-weight:' + fw);
      const tt = clean(s.textTransform); if (tt && tt !== 'none' && !owned.transform) d.push('text-transform:' + tt);
      const mb = clean(s.marginBottom); if (mb && mb !== '0px') d.push('margin-bottom:' + mb + ' !important');
      if (d.length) { n.atts.custom_css = 'selector{' + d.map((x) => x.replace(/[{}<>;]/g, '')).join(';') + ';}'; }
      // PHONE PASS: the paragraph's measured phone size (differs from desktop) → a max-width:767px rule. PHP parity: csSm.
      { const fsm = String(s.fontSizeSm || '').trim(); if (/^[0-9.]+px$/.test(fsm)) { const lsm = String(s.lineHeightSm || '').trim(); n.atts.custom_css = ((n.atts.custom_css || '') + '\n@media (max-width:767px){selector,selector p{font-size:' + fsm + ' !important;' + (/^[0-9.]+px$/.test(lsm) ? 'line-height:' + lsm + ' !important;' : '') + '}}').trim(); } }
      // The first inline link's own skin (capture-extract linkSkin). PHP: linkCs → selector a{…}.
      { const lk = String(s.linkSkin || '').trim(); if (lk && /^[a-z0-9()%.,:;\s#-]+$/i.test(lk)) n.atts.custom_css = ((n.atts.custom_css || '') + '\nselector a{' + lk + ';}').trim(); }
      // The text long tail (capture-extract textLongTailOf). PHP: the 'text' profile + block_rule_fixups.
      { const lt = String(s.longTail || '').trim(); if (lt && /^[a-z0-9()%.,:;"'\s#\/-]+$/i.test(lt)) n.atts.custom_css = ((n.atts.custom_css || '') + '\nselector,selector p{' + lt + ';}').trim(); }
    }
    // HI-FI Pass-2 faithful base — text_block has no native spacing slot, so its vertical margins + the
    // font/color/line-height the unified styler re-asserts are `already`; the base fills the rest (font-weight,
    // letter-spacing, text-transform, background, border, …). Parity with PHP text builder.
    if (s) { // (the box / position mapping below is NOT hi-fi-only; only the faithful base is)
      // FONT-SIZE single source of truth (parity with PHP text builder): the faithful base NEVER emits
      // font-size — when a Text Style preset is assigned the preset owns the size, and when none is
      // assigned the `selector{font-size:…}` custom_css above already carries the faithful px fallback.
      // (Previously the `fontSizePreset ? filter-out : keep` was INVERTED, re-emitting font-size in the
      // base exactly when a preset already owned it → a double-applied size.)
      const props = ['font-family', 'font-size', 'line-height', 'color', 'text-align', 'margin-top', 'margin-bottom'];
      if (owned.weight) props.push('font-weight'); if (owned.ls) props.push('letter-spacing'); if (owned.transform) props.push('text-transform'); // the matched Text Style owns these too
      // A text block that IS a box (a glass callout, a floating note) → its skin becomes a real Box Preset on the
      // block's native Box Style — never a per-node background/border/shadow base. Stashed on _box; capture.mjs
      // clusters every _box into border_presets and assigns box_style. The preset owns fill / border / radius /
      // shadow / padding / backdrop, so the base skips them; the block keeps its OWN line-height at normal
      // specificity (the section styler would otherwise average it with a band's chips). Parity with PHP.
      const bd = String(s.border || '').match(/^([0-9.]+px)\s+(\w+)\s+(.+)$/);
      const boxed = !!(s.bg || s.bgImage || bd || s.boxShadow);
      if (boxed) {
        n.atts._box = { fill: s.bg || '', gradient: s.bgImage || '', radius: s.borderRadius || '', shadow: s.boxShadow || '', borderWidth: bd ? bd[1] : '', borderStyle: bd ? bd[2] : '', borderColor: bd ? bd[3] : '', backdrop: s.backdrop || '', padding: s.padding || '' };
        props.push('background-color', 'background-image', 'border', 'border-radius', 'box-shadow', 'padding', 'backdrop-filter', 'transition');
        const lh = String(s.lineHeight || '').trim();
        if (lh && lh !== 'normal') n.atts.custom_css = ((n.atts.custom_css || '') + '\nselector,selector p{line-height:' + lh.replace(/[{}<>;]/g, '') + ';}').trim();
        // A BOXED SHORT LABEL that sat content-sized in the source (a flex item / inline-block "SCAN_01" chip) stays so — a
        // block-level text block would stretch its fill across the cell. PHP: the text builder's contentSized rule.
        if (s.contentSized) n.atts.custom_css = ((n.atts.custom_css || '') + '\nselector{display:inline-block;width:max-content;max-width:100%;}').trim();
      }
      // The leaf's OWN face (a mono chip / value / label inside a sans card) rides the block — no section styler reaches a
      // nested block. PHP: nested_face_decl.
      { const of = String(s.ownFace || '').trim(); if (of && /^[a-z0-9"',\s-]+$/i.test(of)) n.atts.custom_css = ((n.atts.custom_css || '') + '\nselector,selector p{font-family:' + of + ';}').trim(); }
      // An out-of-flow text (a chip pinned over a hero) → the native Position option: the DECLARED sides from the
      // source's Tailwind classes (`left-[8%] top-[18%]` — a % stays a %), else the computed offsets anchored to
      // the nearer edge per axis (a computed `auto` resolves to px on every side). Parity with PHP.
      if (s.position === 'absolute' || s.position === 'fixed') {
        const AUTO = { value: '', unit: 'auto' };
        const off = { top: AUTO, right: AUTO, bottom: AUTO, left: AUTO };
        let declared = false;
        const cls = ' ' + String(s.cls || '') + ' ';
        for (const side of ['top', 'right', 'bottom', 'left']) {
          const m = cls.match(new RegExp('\\s-?' + side + '-(\\[([-0-9.]+)(px|%|rem|em|vh|vw)\\]|(\\d+(?:\\.\\d+)?))\\s'));
          if (!m) continue;
          const neg = /\s-/.test(m[0].slice(0, 2)) ? -1 : 1;
          off[side] = m[2] !== undefined ? { value: String(neg * parseFloat(m[2])), unit: m[3] } : { value: String(neg * parseFloat(m[4]) * 4), unit: 'px' };
          declared = true;
        }
        if (!declared) {
          const num = (v) => { const x = parseFloat(v); return Number.isNaN(x) ? null : x; };
          const px = (v) => ({ value: String(Math.round(v)), unit: 'px' });
          const t = num(s.top), r = num(s.right), b2 = num(s.bottom), l = num(s.left);
          if (t != null && (b2 == null || Math.abs(t) <= Math.abs(b2))) off.top = px(t); else if (b2 != null) off.bottom = px(b2);
          if (l != null && (r == null || Math.abs(l) <= Math.abs(r))) off.left = px(l); else if (r != null) off.right = px(r);
        }
        const z = String(s.zIndex || '').trim();
        n.atts.element_position = { position: s.position, [s.position]: { pos_offsets: off, element_zindex: (z && z !== 'auto' && z !== '0') ? z : '' } };
        props.push('position', 'top', 'right', 'bottom', 'left', 'z-index');
      }
      if (hifiCss) applyHifiBase(n, csFromFields(s), props, hifiCss);
    }
    return n;
  };
  const column = (width, items) => {
    const c = stamp(clone('column'));
    c.width = width;
    if (c.atts) c.atts.css_class = '';
    c._items = items;
    return c;
  };
  // --- Flexbox ("Div") emission — PHP twin of Mapper::n_flexbox / flex_width_preset / slug_to_span /
  //     row_flex_safe / column_to_flexbox_cell. A clean multi-cell row → ONE flexbox (display:flex,
  //     direction row) whose cells are child flexbox Divs carrying their Width, instead of loose
  //     columns the builder would wrap in a Bootstrap .fw-row. Keeps PHP↔JS parity (see
  //     CONVERSION-ALGORITHM-SYNC.md). ---
  const flexWidthPreset = (n) => { n = parseInt(n, 10); return (n >= 1 && n <= 12) ? String(n) : 'none'; };
  const slugToSpan = (slug) => {
    const m = /^(\d+)_(\d+)$/.exec(String(slug == null ? '' : slug));
    if (m && +m[2] > 0) return Math.max(1, Math.min(12, Math.round((+m[1] / +m[2]) * 12)));
    return 12;
  };
  const nFlexbox = (items, over = {}) => {
    const fx = stamp(clone('flexbox'));
    fx._items = items;
    if (fx.atts) for (const k in over) fx.atts[k] = over[k]; // whole-key override
    return fx;
  };
  const rowFlexSafe = (cols) => {
    if (!Array.isArray(cols) || cols.length < 2) return false;
    for (const col of cols) {
      if (!col || col.type !== 'column') return false;
    }
    // inner_class (inner-wrapper box/max-width CSS) and element_position (floating-card ancestor) no longer
    // veto flexing — columnToFlexboxCell now emits a TWO-NODE cell for inner-wrapper columns and carries
    // element_position onto the cell. PHP twin: Mapper::row_flex_safe() / column_to_flexbox_cell().
    return true;
  };
  // The column's inner CONTENT-layout options → a flexbox's own flex props (axis-aware). Shared by the
  // single-node cell (props on the cell) and the two-node cell (props on the inner Div). PHP: content_layout_over().
  const contentLayoutOver = (a) => {
    const over = {};
    const cd = String(a.content_direction || '');
    const cgap = (a.content_gap && a.content_gap.base != null) ? String(a.content_gap.base) : '';
    const ch = String(a.content_h || ''), cv = String(a.content_v || '');
    const isRow = cd === 'row';
    const hMap = { left: 'start', start: 'start', center: 'center', right: 'end', end: 'end', between: 'between', around: 'around' };
    const vMap = { top: 'start', start: 'start', middle: 'center', center: 'center', bottom: 'end', end: 'end', between: 'between', around: 'around' };
    const h = hMap[ch] || '', v = vMap[cv] || '';
    if (isRow || cgap !== '' || h !== '' || v !== '') {
      over.display = 'flex';
      over.direction = { base: isRow ? 'row' : 'column', md: '', lg: '' };
      // A COLUMN-direction flex is a vertical STACK — it must NOT wrap (wrap:yes, the row default, makes a
      // stack whose items exceed a constrained height wrap into side-by-side columns and overflow).
      if (!isRow) over.wrap = { base: 'no', md: '', lg: '' };
      if (cgap !== '') over.gap = { base: cgap, md: '', lg: '' };
      const main = isRow ? h : v, cross = isRow ? v : h;
      if (main !== '') over.justify_content = { base: main, md: '', lg: '' };
      if (cross !== '') over.align_items = { base: cross, md: '', lg: '' };
      if ((a.content_order || '') === 'reverse') over.reverse = { base: 'yes', md: '', lg: '' };
    } else {
      over.display = 'block';
    }
    return over;
  };
  // Split a column's custom_css for the two-node cell: inner-wrapper rules (selector .CLS{…} whose CLS is one
  // of the column's inner_class names) → rewritten to selector{…} for the INNER Div; the rest (bare selector{…}
  // column-level rules, e.g. gutter padding) stays on the OUTER track. PHP twin: split_col_css().
  const splitColCss = (css, innerClasses) => {
    css = String(css || '');
    const inner = [];
    const rest = css.replace(/selector\s+\.([A-Za-z0-9_-]+)\s*\{([^}]*)\}/g, (m, cls, body) => {
      if (innerClasses.indexOf(cls) !== -1) { inner.push('selector{' + body.trim() + '}'); return ''; }
      return m;
    });
    return [rest.trim(), inner.join('\n').trim()];
  };
  const columnToFlexboxCell = (col) => {
    const a = (col && col.atts) || {};
    const over = {};
    const isNum = (v) => (typeof v === 'string' || typeof v === 'number') && String(v) !== '' && /^\d+$/.test(String(v));
    const wp = a.w_phone != null ? a.w_phone : 'default';
    const wt = a.w_tablet != null ? a.w_tablet : 'default';
    const wd = a.w_desktop != null ? a.w_desktop : 'default';
    if (isNum(wd) || isNum(wt) || isNum(wp)) {
      over.width = {
        base: { preset: isNum(wp) ? flexWidthPreset(wp) : 'none' },
        md:   { preset: isNum(wt) ? flexWidthPreset(wt) : 'none' },
        lg:   { preset: isNum(wd) ? flexWidthPreset(wd) : 'none' },
      };
    } else {
      const span = slugToSpan(col.width != null ? col.width : '1_1');
      over.width = { base: { preset: flexWidthPreset(span) }, md: { preset: 'none' }, lg: { preset: 'none' } };
    }
    // OUTER-track carries (grid-cell level). element_position (floating-card ancestor) now CARRIED.
    if (a.align_self && typeof a.align_self === 'object') over.align_self = a.align_self;
    if (a.order && typeof a.order === 'object' && a.order.base) over.order = a.order; // a source order:-1 (PHP: column_to_flexbox_cell)
    if (a.responsive_hide && (Array.isArray(a.responsive_hide) ? a.responsive_hide.length : Object.keys(a.responsive_hide).length)) over.responsive_hide = a.responsive_hide;
    if (a.spacing) over.spacing = a.spacing;
    if (a.animation) over.animation = a.animation;
    if (a.gsap_motion && a.gsap_motion.effect && a.gsap_motion.effect !== 'none') over.gsap_motion = a.gsap_motion; // a measured CSS-class reveal on the cell (the stagger); PHP twin
    if (a.css_id) over.css_id = String(a.css_id);
    if (a.custom_attrs) over.custom_attrs = a.custom_attrs;
    if (a.element_position) over.element_position = a.element_position;
    // Source cell geometry: the exact grid track (read by flexifyItems) + a fixed min-height card. PHP twin.
    if (a.track_px > 0) over.track_px = a.track_px;
    if (a._row_box) over._row_box = a._row_box;
    if (a._row_minh > 0) over._row_minh = a._row_minh;
    if (a.bg_gradient || (a.bg_color && a.bg_color.custom)) over.background = { color: { value: (a.bg_color && a.bg_color.custom) ? a.bg_color : { predefined: '', custom: '' } }, gradient: a.bg_gradient || { data: { type: 'linear', angle: 90, stops: [] } }, image: { src: [], position: 'center center', size: { selected: 'cover', custom: '' }, repeat: 'no-repeat', attachment: 'scroll' }, video: { enabled: 'no', external_url: '', source_mp4: [], source_webm: [], poster: [], fallback: [], loop: 'yes', autoplay: 'yes', mute: 'yes', playsinline: 'yes' }, advanced: [] };
    if (a.min_height_px > 0) over.min_height = { base: { value: String(Math.round(a.min_height_px)), unit: 'px' }, md: { value: '', unit: 'vh' }, lg: { value: '', unit: 'vh' } };
    // PHONE PASS: a different (or no) phone minimum → base = phone, desktop → lg. PHP parity: min_height_sm_px.
    if (a.min_height_px > 0 && a.min_height_sm_px !== undefined) over.min_height = { base: { value: a.min_height_sm_px > 0 ? String(a.min_height_sm_px) : '', unit: 'px' }, md: { value: (a.min_height_md_px !== undefined && a.min_height_md_px !== a.min_height_sm_px) ? (a.min_height_md_px > 0 ? String(a.min_height_md_px) : '0') : '', unit: 'px' }, lg: { value: String(Math.round(a.min_height_px)), unit: 'px' } };
    // RECURSE: flex any nested column runs inside this cell too (mutual recursion with flexifyItems()).
    const items = Array.isArray(col._items) ? flexifyItems(col._items) : [];
    // TWO-NODE cell: an inner-wrapper column (box skin / max-width cap on inner_class) → OUTER width track
    // wrapping an INNER Div that carries the box + content-layout. Keeps max-width;margin:auto on a BLOCK
    // child (classic left-align) not a flex item. PHP twin: column_to_flexbox_cell() two-node branch.
    const innerClass = String(a.inner_class || '').trim();
    if (innerClass !== '') {
      const innerOver = contentLayoutOver(a);
      const [outerCss, innerCss0] = splitColCss(a.custom_css || '', innerClass.split(/\s+/).filter(Boolean));
      let innerCss = innerCss0;
      const ta2 = String(a.text_align || '');
      if (ta2 === 'center' || ta2 === 'right' || ta2 === 'left') innerCss = (innerCss + (innerCss !== '' ? '\n' : '') + 'selector{text-align:' + ta2 + ';}').trim();
      if (innerCss !== '') innerOver.custom_css = innerCss;
      if (a.border_preset) innerOver.border_preset = String(a.border_preset);
      if (a._box) innerOver._box = a._box; // stashed card skin → the Box-Preset census assigns border_preset on the inner Div
      if (a.css_class) innerOver.css_class = String(a.css_class);
      const innerDiv = nFlexbox(items, innerOver);
      over.display = 'block';
      if (outerCss !== '') over.custom_css = outerCss;
      return nFlexbox([innerDiv], over);
    }
    // SINGLE-NODE cell: content-layout maps onto the cell's own flex props.
    Object.assign(over, contentLayoutOver(a));
    if (a.border_preset) over.border_preset = String(a.border_preset);
    if (a._box) over._box = a._box; // stashed card skin → the Box-Preset census assigns border_preset on this cell
    if (a.css_class) over.css_class = String(a.css_class);
    const ta = String(a.text_align || '');
    let css = String(a.custom_css || '');
    if (ta === 'center' || ta === 'right' || ta === 'left') css = (css + (css !== '' ? '\n' : '') + 'selector{text-align:' + ta + ';}').trim();
    if (css !== '') over.custom_css = css;
    if (a.unique_id) over.unique_id = String(a.unique_id);
    return nFlexbox(items, over);
  };
  // Twin of PHP Mapper::cells_uniform_grid — do these flex cells form a UNIFORM, non-responsive 12-column
  // grid (every cell the SAME numeric base span, the spans summing to 12, no per-device width override, none
  // absolutely positioned)? Then flex-grow on the cells fills the row exactly (see the flush call site).
  // A run of ≥ 2 cells with MIXED desktop spans (lg, else md, else base — 1–12) that tiles LINES of exactly 12 (a
  // `grid-cols-12` bento: 8|4 then 5|7) → a native 12-track grid; a wrapping flex row ran one gap short per line, so
  // the tiles sat 16px narrower than the source's tracks. PHP twin: Mapper::cells_span_lines.
  const cellsSpanLines = (cells) => {
    if (!Array.isArray(cells) || cells.length < 2) return false;
    const spans = [];
    for (const c of cells) {
      if (!c || !c.atts || c.atts.element_position) return false;
      const w = c.atts.width; if (!w) return false;
      let d = '';
      for (const t of ['lg', 'md', 'base']) { const v = String((w[t] && w[t].preset) || ''); if (/^\d+$/.test(v)) { d = v; break; } }
      if (!d || +d < 1 || +d > 12) return false;
      spans.push(+d);
    }
    if (new Set(spans).size < 2) return false;
    let acc = 0;
    for (const sp of spans) { acc += sp; if (acc > 12) return false; if (acc === 12) acc = 0; }
    return acc === 0;
  };
  const cellsUniformGrid = (cells) => {
    if (!Array.isArray(cells) || cells.length < 2) return false;
    let base = null, sum = 0;
    for (const c of cells) {
      if (!c || !c.atts || c.atts.element_position) return false;
      const w = c.atts.width;
      if (!w || !w.base) return false;
      const b = String((w.base && w.base.preset) || '');
      const md = String((w.md && w.md.preset) || 'none');
      const lg = String((w.lg && w.lg.preset) || 'none');
      if (!/^\d+$/.test(b)) return false;                 // needs a real 1–12 span
      if (md !== '' && md !== 'none') return false;        // any responsive change → keep flex
      if (lg !== '' && lg !== 'none') return false;
      if (base === null) base = b; else if (b !== base) return false; // all cells equal
      sum += parseInt(b, 10);
    }
    return sum === 12;
  };
  // Recursively flex NESTED column runs (PHP twin of Mapper::flexify_items): a run of ≥2 consecutive
  // flex-safe `column` siblings → one flexbox Div of flexbox cells; non-column / unsafe / lone columns
  // pass through. columnToFlexboxCell calls back here, so nesting is handled at every depth.
  // Cells whose source grid tracks are UNEQUAL (`1.08fr .92fr` → 737px / 627px): the 12-column span model
  // rounds both to 6/6. Returns the tracks as an `fr` list (each = track/sum × N) for a native Grid, or ''
  // when any cell lacks a track or the tracks are equal within 2%. PHP twin: Mapper::cells_track_list().
  const trackList = (cells) => {
    const tr = cells.map((c) => parseFloat(c.atts && c.atts.track_px) || 0);
    if (tr.length < 2 || tr.some((t) => t <= 0)) return '';
    const mx = Math.max(...tr), mn = Math.min(...tr);
    if ((mx - mn) / mx <= 0.02) return '';
    const sum = tr.reduce((a, b) => a + b, 0);
    // a NARROW track (≤ 120px: a disc's `80px`, a pill's `auto`) is a fixed px measure; the wide tracks split the rest as fr (PHP: cells_track_list fixed)
    const fixed = tr.map((t) => t <= 120 && mx > 240);
    if (fixed.some(Boolean) && fixed.filter(Boolean).length < tr.length) {
      const fsum = tr.reduce((a, t, i) => a + (fixed[i] ? 0 : t), 0), fn = tr.length - fixed.filter(Boolean).length;
      return tr.map((t, i) => fixed[i] ? (Math.round(t * 10) / 10) + 'px' : String(Math.round((t / Math.max(1e-6, fsum)) * fn * 1000) / 1000) + 'fr').join(' ');
    }
    return tr.map((t) => String(Math.round((t / sum) * tr.length * 1000) / 1000) + 'fr').join(' ');
  };
  // A decor pseudo-layer → its scoped rule ('' when a value fails the whitelist). Twin of PHP Mapper::decor_pseudo_css.
  const decorPseudoCss = (d) => {
    const ok = (v, re) => re.test(String(v == null ? '' : v));
    const pos = /^-?[0-9.]+(?:%|px)$/;
    if (d && d.sweep) return sweepPseudoCss(d);
    // Stacking: the source's own z-index, else ABOVE the fill for a small bar / dot (`above`), else behind (a glow). PHP: decor_pseudo_css.
    const z = (d.z != null && /^-?\d+$/.test(String(d.z))) ? String(d.z) : (d.above ? '1' : '-1');
    const decl = ['content:""', 'position:absolute', 'pointer-events:none', 'z-index:' + z];
    for (const k of ['top', 'left', 'right', 'bottom', 'width', 'height']) if (d[k] != null && ok(d[k], pos)) decl.push(k + ':' + d[k]);
    const painted = ok(d.background, /^[a-z0-9()%.,\s#-]+$/i) && d.background;
    const bordered = (d.border && ok(d.border, /^[a-z0-9()%.,\s#-]+$/i)) || (d.shadow && ok(d.shadow, /^[a-z0-9()%.,\s#-]+$/i));
    if (!painted && !bordered) return '';
    if (painted) decl.push('background:' + d.background);
    if (d.border && ok(d.border, /^[a-z0-9()%.,\s#-]+$/i)) decl.push('border:' + d.border);
    if (d.shadow && ok(d.shadow, /^[a-z0-9()%.,\s#-]+$/i)) decl.push('box-shadow:' + d.shadow);
    if (d.filter && ok(d.filter, /^[a-z0-9()%.,\s-]+$/i)) decl.push('filter:' + d.filter);
    if (d.opacity && ok(d.opacity, /^[0-9.]+$/)) decl.push('opacity:' + d.opacity);
    if (d.radius && ok(d.radius, /^[0-9.%px\s\/]+$/)) decl.push('border-radius:' + d.radius);
    return 'selector{position:relative;isolation:isolate;}selector::' + (d.pe === 'after' ? 'after' : 'before') + '{' + decl.join(';') + ';}';
  };
  // A SWEEP pseudo-layer (capture-extract sweepLayerOf): a painted pseudo that MOVES — declared inset / transform /
  // animation / blend, plus the @keyframes it names. Emitted verbatim on the node's scoped CSS: the host clips + isolates,
  // the pseudo paints ABOVE the content like the source (no z-index:-1), and the keyframes ride along under a
  // per-element name (`sc-<name>-<hash>`) so two converted sites' "sheen" never collide. PHP twin: Mapper::sweep_pseudo_css.
  const sweepPseudoCss = (d) => {
    const ok = (v, re) => re.test(String(v == null ? '' : v));
    const len = /^-?[0-9.]+(?:%|px|rem|em|vw|vh)?$/;
    if (!d || !ok(d.background, /^[a-z0-9()%.,\s#-]+$/i) || !d.background) return '';
    const decl = ['content:""', 'position:absolute', 'pointer-events:none'];
    if (d.inset && ok(d.inset, /^(-?[0-9.]+(?:%|px|rem|em|vw|vh)?\s*){1,4}$/)) decl.push('inset:' + String(d.inset).trim());
    for (const k of ['top', 'left', 'right', 'bottom', 'width', 'height']) if (d[k] != null && ok(d[k], len)) decl.push(k + ':' + d[k]);
    decl.push('background:' + d.background);
    if (d.transform && ok(d.transform, /^[a-z0-9()%.,\s-]+$/i)) decl.push('transform:' + d.transform);
    let anim = d.animation && ok(d.animation, /^[a-z0-9_.,\s()-]+$/i) ? String(d.animation).trim() : '';
    let kf = d.keyframes && /^@keyframes\s+[a-z0-9_-]+\s*\{/i.test(String(d.keyframes).trim()) && !/<|url\(|expression\(|javascript:|@import/i.test(d.keyframes) && String(d.keyframes).length <= 4000 ? String(d.keyframes).trim() : '';
    if (anim && kf) {
      const name = anim.split(/\s+/)[0];
      const kfName = (kf.match(/^@keyframes\s+([a-z0-9_-]+)/i) || [])[1] || '';
      if (name && kfName && name === kfName) {
        const scoped = 'sc-' + name.replace(/[^a-z0-9_-]/gi, '') + '-' + createHash('md5').update(kf).digest('hex').slice(0, 6);
        anim = scoped + anim.slice(name.length); // name is whitelisted [a-z0-9_-] (the animation regex above), so a plain prefix swap is exact
        kf = kf.replace(/^@keyframes\s+[a-z0-9_-]+/i, '@keyframes ' + scoped);
      } else kf = '';
    } else kf = '';
    if (!kf) anim = ''; // no carried @keyframes (unreadable sheet / mismatched name) → no dangling animation
    if (anim) decl.push('animation:' + anim);
    if (d.blend && ok(d.blend, /^[a-z-]+$/)) decl.push('mix-blend-mode:' + d.blend);
    if (d.opacity && ok(d.opacity, /^[0-9.]+$/)) decl.push('opacity:' + d.opacity);
    if (d.filter && ok(d.filter, /^[a-z0-9()%.,\s-]+$/i)) decl.push('filter:' + d.filter);
    if (d.radius && ok(d.radius, /^[0-9.%px\s\/]+$/)) decl.push('border-radius:' + d.radius);
    const host = 'selector{position:relative;isolation:isolate;' + (d.clip ? 'overflow:hidden;' : '') + '}';
    return host + 'selector::' + (d.pe === 'after' ? 'after' : 'before') + '{' + decl.join(';') + ';}' + (kf ? kf : '');
  };
  const flexifyItems = (items) => {
    const out = [];
    let run = [];
    const flush = () => {
      if (!run.length) return;
      if (run.length >= 2 && rowFlexSafe(run)) {
        const cells = run.map(columnToFlexboxCell);
        const over = { display: 'flex', direction: { base: 'row', md: '', lg: '' }, wrap: { base: 'yes', md: '', lg: '' } };
        // UNEQUAL source tracks (`1.08fr .92fr`) → a native Grid carrying the exact track list (grid_columns
        // accepts a raw template); the 12-span model would round it to 6/6. PHP twin: cells_track_list().
        const tl = trackList(cells);
        if (tl) {
          over.display = 'grid';
          over.grid_columns = tl;
          for (const gc of cells) delete gc.atts.width;
        } else if (cellsSpanLines(cells)) {
          over.display = 'grid';
          over.grid_columns = '12'; // (the cells keep their fw-span-N → grid-column:span N, responsive tiers included)
        } else if (cellsUniformGrid(cells)) {
          // UNIFORM NON-RESPONSIVE GRID → grow the cells to fill the row. A wrapping flex row sizes each span
          // cell width:calc(pct - gap), subtracting the FULL gap from every cell though only N-1 gaps sit between
          // N cells, so the row ends one gap short (a trailing empty strip). flex-grow:1 on equal cells distributes
          // that remainder back. Twin of PHP Mapper::cells_uniform_grid + the flexify flex-grow push.
          for (const uc of cells) uc.atts.flex_grow = { base: 'yes', md: '', lg: '' };
        }
        // The ROW is a CARD (a band): the cells carry its skin + min-height → the row flexbox wears the card's box
        // (the census assigns border_preset on a flexbox) at the card's height. PHP twin: flexify_items.
        const rb = cells[0] && cells[0].atts && cells[0].atts._row_box;
        if (rb) over._box = rb;
        if (cells[0] && cells[0].atts && cells[0].atts._row_minh > 0) over.min_height = { base: { value: String(cells[0].atts._row_minh), unit: 'px' }, md: { value: '', unit: 'vh' }, lg: { value: '', unit: 'vh' } };
        for (const tc of cells) { delete tc.atts.track_px; delete tc.atts._row_box; delete tc.atts._row_minh; }
        out.push(nFlexbox(cells, over));
      } else {
        // A LONE column still becomes a flexbox Div, never a classic fw-row/fw-col (PHP twin: flexify_items).
        for (const rc of run) out.push(columnToFlexboxCell(rc));
      }
      run = [];
    };
    for (const it of items) {
      if (it && it.type === 'column') run.push(it);
      else { flush(); out.push(it); }
    }
    flush();
    return out;
  };
  // --- Container Width (parity with the PHP Mapper's sectionContainerW + container_width_px). A source
  //     content cap (`max-w-5xl mx-auto` / computed max-width) → the section's container_width preset,
  //     and pushed onto a direct flexbox child's content_width (a flexbox escapes the section's
  //     .fw-container, so it needs its own cap to stay centred instead of going edge-to-edge). ---
  const sectionContentMaxPx = (sec) => {
    const cm = sec && sec.computed && sec.computed.maxWidth;
    if (cm && /^[0-9.]+px$/.test(String(cm))) return parseFloat(cm);
    const cls = String((sec && sec.sectionClass) || '');
    const twMap = { '3xl': 768, '4xl': 896, '5xl': 1024, '6xl': 1152, '7xl': 1280 };
    const m = cls.match(/\bmax-w-(\[?[0-9a-z.]+\]?)\b/);
    if (m) {
      const k = m[1];
      if (twMap[k]) return twMap[k];
      const px = k.match(/^\[?([0-9.]+)px\]?$/);
      if (px) return parseFloat(px[1]);
    }
    return 0;
  };
  // px → container_width preset value; INHERIT (null) for the wide theme-default range (≥ ~1152).
  const containerWidthPreset = (px) => {
    px = parseFloat(px) || 0;
    if (px <= 0) return null;
    if (px <= 820) return { preset: 'narrow' };  // ~768 (3xl)
    if (px <= 960) return { preset: 'medium' };  // ~896 (4xl)
    if (px <= 1100) return { preset: 'wide' };   // ~1024 (5xl)
    return null;                                  // 6xl/7xl → inherit the site-wide container
  };
  // container_width value → its pixel cap (for pushing onto a flexbox content_width). Twin of PHP container_width_px.
  const containerWidthPx = (cw) => {
    if (!cw || typeof cw !== 'object') return 0;
    if (cw.preset === 'small') return 640;
    if (cw.preset === 'prose') return 672;
    if (cw.preset === 'narrow') return 768;
    if (cw.preset === 'medium') return 896;
    if (cw.preset === 'wide') return 1024;
    if (cw.preset === 'wide-l') return 1152;
    if (cw.preset === 'wide-xl') return 1280;
    if (cw.preset === 'wide-xxl') return 1440;
    // A non-standard "Content NNNN" preset (a source container that isn't a standard step) → its px (PHP twin).
    const m = /^content-(\d+)$/.exec(String(cw.preset || ''));
    if (m) return parseInt(m[1], 10);
    return 0;
  };
  // A px content-band cap → a flexbox content_width VALUE. The value MUST be a NAMED preset ({preset:'wide'},
  // {preset:'content-1400'}, …): a bare {value,unit} is normalized to {preset:''} on read and the cap is
  // silently DROPPED (the grid then escapes to the full container width). Twin of PHP content_width_value().
  const contentWidthValue = (px) => {
    px = Math.round(Number(px) || 0);
    if (px <= 0) return { preset: 'inherit' };
    const steps = [[640, 'small'], [672, 'prose'], [768, 'narrow'], [896, 'medium'], [1024, 'wide'], [1152, 'wide-l'], [1280, 'wide-xl'], [1440, 'wide-xxl']];
    for (const [spx, key] of steps) { if (Math.abs(spx - px) <= 2) return { preset: key }; }
    return { preset: 'content-' + px };
  };
  // CONTAINER-LEVEL text_align (parity with the PHP mapper). text-align is an INHERITED property,
  // so setting it on the section/column centers the whole band's heading + paragraph + buttons as
  // one — a different axis from content_h (the flexbox positioning of the column's children).
  //  - sectionCentered(): a centered source band (root `text-center`, a `flex … items-center`, or a
  //    computed text-align:center) → the section's native `text_align='center'`. Twin of
  //    Stitch::section_center / the class+computed portion of the analyze path.
  //  - clsTextAlign(): a wrapper/cell's OWN `text-center`/`text-right` class → 'center'/'right'
  //    ('' for text-left / none = the inherited default). Twin of Mapper::cls_text_align /
  //    Stitch::wrapper_align.
  const sectionCentered = (sec) => {
    const cls = ' ' + String((sec && sec.sectionClass) || '') + ' ';
    if (/\stext-center\s/.test(cls)) return true;
    if (/\sitems-center\s/.test(cls) && /\sflex(-col)?\s/.test(cls)) return true;
    const ta = sec && sec.computed && sec.computed.textAlign;
    if (ta === 'center') return true;
    return false;
  };
  const clsTextAlign = (cls) => {
    const c = ' ' + String(cls || '') + ' ';
    if (/\stext-center\s/.test(c)) return 'center';
    if (/\stext-right\s/.test(c)) return 'right';
    return ''; // text-left / none = inherited default.
  };
  // A CSS gap length → the nearest UnysonPlus Gap-Scale slug (Bootstrap $spacers: 1=4px, 2=8px,
  // 3=16px, 4=24px, 5=48px). '' when there's no meaningful gap. Used to replay a flex-row cell's
  // spacing via the column's native content_gap instead of a CSS wrapper.
  const gapSlug = (g) => {
    const px = parseFloat(String(g || ''));
    if (!px || px < 2) return '';
    // Extended gap scale mirrors the spacing scale (px => slug). Exact step (within 1px) → clean slug
    // (gap-16=64px → '7'); off-scale → a lossless `[NNpx]` arbitrary slug (buildGapScale registers it so the
    // gap CSS renders). Parity with PHP gap_slug — ends the old snap that flattened 40px/64px to 48px.
    const scale = [[0, '0'], [4, '1'], [8, '2'], [16, '3'], [24, '4'], [48, '5'], [56, '6'], [64, '7'], [72, '8'], [80, '9'], [96, '10'], [112, '11'], [128, '12']];
    for (const [v, s] of scale) { if (Math.abs(v - px) <= 1) return s; }
    return '[' + Math.round(px) + 'px]';
  };
  // The verbatim section HTML goes into a `code-block` (raw, un-processed output — the
  // universal fallback for anything we don't yet map to a dedicated shortcode). The section's
  // own CSS rides in the section's Advanced → Custom CSS (`custom_css`), so it travels with
  // the section, renders late (wins the cascade over the plugin's framework CSS) and stays
  // editable. Source selectors pass through the aggregator unchanged (only the literal token
  // `selector` is rewritten), so the rules target the verbatim markup's source classes.
  // Translate Tailwind POSITION utilities on a verbatim block's root element to inline CSS — those classes
  // (`absolute -top-4 -right-4 inset-0 …`) are dead on the WP site (no Tailwind), stranding an absolute
  // overlay at a garbage offset. Parity with PHP translate_tw_position_inline().
  const translateTwPositionInline = (html) => {
    html = String(html || '');
    const m = html.match(/<([a-z0-9]+)\b([^>]*)>/i);
    if (!m) return html;
    const cm = m[2].match(/\bclass="([^"]*)"/i);
    if (!cm) return html;
    const len = (tok) => { let x; if ((x = tok.match(/^\[([0-9.]+)px\]$/))) return parseFloat(x[1]); if ((x = tok.match(/^\[([0-9.]+)rem\]$/))) return parseFloat(x[1]) * 16; if (/^[0-9]+$/.test(tok)) return parseFloat(tok) * 4; return null; };
    const decls = {}; const keep = [];
    for (const c of cm[1].trim().split(/\s+/).filter(Boolean)) {
      if (['absolute', 'relative', 'fixed', 'sticky'].includes(c)) { decls.position = c; continue; }
      if (c === 'inset-0') { decls.top = '0'; decls.right = '0'; decls.bottom = '0'; decls.left = '0'; continue; }
      const mm = c.match(/^(-?)(top|right|bottom|left)-(.+)$/);
      if (mm) { const px = len(mm[3]); if (px !== null) { decls[mm[2]] = ((mm[1] === '-' ? -1 : 1) * px) + 'px'; continue; } }
      keep.push(c);
    }
    if (!decls.position) return html;
    let style = ''; for (const k in decls) style += k + ':' + decls[k] + ';';
    let a = m[2].replace(/\bclass="[^"]*"/i, 'class="' + keep.join(' ').trim() + '"');
    const sm = a.match(/\bstyle="([^"]*)"/i);
    a = sm ? a.replace(/\bstyle="[^"]*"/i, 'style="' + sm[1].trim().replace(/;$/, '') + ';' + style + '"') : a + ' style="' + style + '"';
    return html.slice(0, m.index) + '<' + m[1] + a + '>' + html.slice(m.index + m[0].length);
  };
  const codeBlock = (html) => {
    html = String(html == null ? '' : html);
    html = translateTwPositionInline(html); // dead Tailwind position classes → inline CSS (absolute overlays)
    // Preteach tables: wrap a verbatim <table> in the default Table Preset skin (.tbl-clean-lines,
    // whose CSS targets `> table > thead/tbody…`) so raw source tables render styled instead of bare.
    // Mirrors the PHP Mapper::n_code() wrap.
    if (/<table[\s>]/i.test(html) && !html.includes('tbl-')) { html = `<div class="tbl-clean-lines">${html}</div>`; }
    return { type: 'simple', shortcode: 'code_block', _items: [], atts: { code: html, unique_id: uid() } };
  };

  // Decomposed leaves → dedicated, editable shortcodes (intro-only): a heading → special_heading,
  // a paragraph → text_block, a CTA → button. Everything else stays a code-block (incl. each grid
  // cell). The source section class is carried onto the builder section so descendant CSS
  // (`.section h2`, `.section .speaker-item`) still styles the extracted/verbatim content.
  // Tailwind max-w scale → rem, for block_max_width (arbitrary max-w-[Npx|rem|…] handled inline).
  const TW_MAXW = { sm: 24, md: 28, lg: 32, xl: 36, '2xl': 42, '3xl': 48, '4xl': 56, '5xl': 64, '6xl': 72, '7xl': 80 };
  const emptySpacing = () => ({ margin: { all: '', top: '', right: '', bottom: '', left: '' }, padding: { all: '', top: '', right: '', bottom: '', left: '' }, advanced: [] });
  // UnysonPlus spacing scale (rem → slug). A `spacing` att margin value must be a scale-slug UTILITY
  // CLASS (e.g. mb-7), NOT a raw length — a raw "4rem" lands as a dead class. Snap the Tailwind rem to
  // the nearest slug: 0→0 .25→1 .5→2 1→3 1.5→4 3→5 3.5→6 4→7 4.5→8 5→9 6→10 7→11 8→12.
  const SPACING_SCALE = [[0, '0'], [0.25, '1'], [0.5, '2'], [1, '3'], [1.5, '4'], [3, '5'], [3.5, '6'], [4, '7'], [4.5, '8'], [5, '9'], [6, '10'], [7, '11'], [8, '12']];
  const remToSlug = (rem) => { let best = '0', bd = Infinity; for (const [r, s] of SPACING_SCALE) { const d = Math.abs(r - rem); if (d < bd) { bd = d; best = s; } } return best; };
  // Exact scale match (within 1px) → clean preset slug; else a Tailwind-style ARBITRARY value
  // (`pt-[40px]`) that the plugin's per-page dynamic CSS renders exactly. Keeps common values on
  // the Bootstrap-aligned scale, captures off-scale values LOSSLESSLY (no snap, no ±12px error).
  const SCALE_PX = SPACING_SCALE.map(([rem, slug]) => [rem * 16, slug]);
  const spacingToken = (prefix, px) => {
    px = Math.round(parseFloat(px) || 0);
    const hit = SCALE_PX.find(([p]) => Math.abs(p - px) <= 1);
    return hit ? `${prefix}-${hit[1]}` : `${prefix}-[${px}px]`;
  };

  // Clean carried inline HTML — parity with PHP map_accent_classes: (1) strip capture-only `data-sc-*`
  // attributes (the computed-style blob capture stamps on every element must never render), and (2) fold
  // presentational-only utilities (italic / font-weight name / decoration / transform) into an inline
  // style so a `<span class="italic font-normal">` keeps its look without the (absent) Tailwind runtime.
  const cleanInlineHtml = (html) => {
    let s = String(html || '');
    if (!s) return s;
    s = s.replace(/\s+data-sc-[a-z0-9-]+="[^"]*"/gi, '').replace(/\s+data-sc-[a-z0-9-]+='[^']*'/gi, '');
    if (!/class="/i.test(s)) return s;
    const WMAP = { thin: '100', extralight: '200', light: '300', normal: '400', medium: '500', semibold: '600', bold: '700', extrabold: '800', black: '900' };
    return s.replace(/<[a-zA-Z][a-zA-Z0-9]*\b[^>]*\bclass="[^"]*"[^>]*>/g, (tag) => {
      const cm = tag.match(/\bclass="([^"]*)"/);
      if (!cm) return tag;
      const keep = []; const decls = {};
      for (const c of cm[1].trim().split(/\s+/)) {
        if (!c) continue;
        const l = c.toLowerCase(); let w;
        if (l === 'italic') decls['font-style'] = 'italic';
        else if (l === 'not-italic') decls['font-style'] = 'normal';
        else if (l === 'underline') decls['text-decoration'] = 'underline';
        else if (l === 'line-through') decls['text-decoration'] = 'line-through';
        else if (l === 'no-underline') decls['text-decoration'] = 'none';
        else if (l === 'uppercase') decls['text-transform'] = 'uppercase';
        else if (l === 'lowercase') decls['text-transform'] = 'lowercase';
        else if (l === 'capitalize') decls['text-transform'] = 'capitalize';
        else if ((w = l.match(/^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/))) decls['font-weight'] = WMAP[w[1]];
        else keep.push(c);
      }
      if (!Object.keys(decls).length) return tag;
      const declStr = Object.entries(decls).map(([k, v]) => `${k}:${v}`).join(';');
      const newClass = keep.join(' ').trim();
      let t = tag.replace(/\s*\bclass="[^"]*"/, newClass ? ` class="${newClass}"` : '');
      if (/\bstyle="[^"]*"/.test(t)) return t.replace(/\bstyle="([^"]*)"/, (_m, ex) => `style="${ex.replace(/;\s*$/, '')}${ex.trim() ? ';' : ''}${declStr}"`);
      return t.slice(0, -1) + ` style="${declStr}">`;
    });
  };

  const headingNode = (b) => {
    const n = stamp(clone('special_heading'));
    n.atts.title = cleanInlineHtml(b.html);
    n.atts.subtitle = cleanInlineHtml(b.subtitle || '');
    n.atts.overline = b.overline || '';
    n.atts.overline_container = b.overlinePill ? 'pill' : '';
    n.atts.heading = 'h' + (b.level >= 1 && b.level <= 6 ? b.level : 2);
    // Title Display Size — the source heading's computed font-size → the nearest native Display preset
    // (display-1 largest … display-6). Decomposed headings become native special_heading shortcodes
    // WITHOUT the source's `text-5xl`/`text-6xl` class, so without this the hero H1 collapses to the
    // tag's default size (the freshpaws "hero heading too small" bug). display presets are the theme's
    // responsive Display Text Styles, so this keeps mobile scaling (unlike a hard px). Only promote
    // genuinely large display headings (≥30px); smaller section headings keep the tag's own size.
    const hpx = parseInt(b.fontSize, 10) || 0;
    let exactHeadingSize = '';
    if (hpx >= 30) {
      // Snap to the NEAREST display-preset SIZE (not a coarse ≥60→display-1 threshold, which turned a
      // 72px source hero into the theme's 96px display-1). The unysonplus-theme Display Text Styles are
      // display-1=96 · 2=88 · 3=72 · 4=56 · 5=48 px, so a 72px source h1 lands on display-3 exactly.
      const DISPLAY_PX = [[96, 'display-1'], [88, 'display-2'], [72, 'display-3'], [56, 'display-4'], [48, 'display-5']];
      let best = DISPLAY_PX[0];
      for (const d of DISPLAY_PX) { if (Math.abs(d[0] - hpx) < Math.abs(best[0] - hpx)) best = d; }
      // Snap ONLY when the source size is genuinely CLOSE to a display preset (a hero/display heading).
      // The smallest preset is 48px, so a 36px SECTION heading (text-3xl md:text-4xl) is 12px away and
      // would balloon to display-5 (the "Why Pets Love …" 36px→48px bug). Beyond the tolerance,
      // reproduce the EXACT size instead of promoting it to a display preset.
      // A FLUID source size (a declared clamp()/vw) is carried as the expression below — never pin its px snapshot.
      if (b.fsDecl) { /* fluid: no preset, no px */ }
      else if (Math.abs(best[0] - hpx) <= 7) { n.atts.display_size = best[1]; }
      else { exactHeadingSize = hpx + 'px'; }
    }
    // Title color — carry the source heading's computed color into the native title_color pick.
    // Decomposed headings otherwise inherit the theme's default heading color (brand green here), so a
    // heading that was WHITE on a colored/dark source section renders green-on-green and vanishes (the
    // freshpaws CTA heading). Pairs with the section-background fix so colored sections stay legible.
    n.atts.title_color = b.color ? { predefined: '', custom: rgbToCss(b.color) } : { predefined: '', custom: '' };
    // Per-heading COLOUR → title_color. A decomposed heading becomes a native special_heading that
    // inherits the theme's DEFAULT heading colour; when the source heading departs from it, carry its
    // own colour so it stays faithful — a WHITE heading on a dark CTA band (else it inherits the ink/
    // accent heading colour and vanishes — green-on-green), or an ink hero title whose only accent is
    // an inner <span> (the span's carried `.text-primary` still wins, so the two-tone survives).
    if (b.color && /^rgb/i.test(String(b.color))) { n.atts.title_color = { predefined: '', custom: rgbToCss(b.color) }; }
    // TRANSLATE THE SOURCE CLASSES VIA THE NATIVE PART-CLASS OPTIONS — not synthesized Custom CSS.
    // The Special Heading shortcode exposes Overline Class / Title Class / Subtitle Class, applied to
    // `.heading-overline` / `.heading-title` / `.heading-subtitle`. The title's own utility classes
    // (font-heading, font-extrabold, leading-[1.1], tracking-*, …) resolve via the SECTION's carried CSS
    // (which the capture bundles — incl. arbitrary values like `.leading-[1.1]`), so carrying them here
    // reproduces the effect with the source's own class, no Custom CSS. Dropped from the class:
    //   • text-{size|colour|align} — covered better by the native display_size / title_color / alignment
    //     (display_size also carries the responsive `lg:text-7xl` step, which the carried CSS omits);
    //   • SPACING utilities (m*/p*/gap/space) — they collide 1:1 BY NAME with the plugin's own
    //     `!important` spacing utilities on a DIFFERENT scale (`.mb-6` → 56px, not 24px).
    const _clean = (v) => String(v || '').trim();
    // A class is SANITIZER-SAFE only if it has no `:` `/` `[` `]` — WP's class sanitizer strips those,
    // so a responsive (`md:text-xl`), opacity (`text-foreground/70`) or arbitrary (`leading-[1.1]`) class
    // survives only as a MANGLED dead token that no longer matches the carried CSS. Those effects are
    // reproduced from the computed value in tier-3 custom_css below, not carried as a broken class.
    const mangleProne = (c) => /[:/[\]]/.test(c);
    const routeClass = (raw, dropText) => String(raw || '').split(/\s+/).filter(Boolean).filter((c) => {
      if (mangleProne(c)) return false;                                        // : / [ ] → mangled → tier-3 custom_css
      const base = c.replace(/^-/, '').replace(/^(?:[\w]+:)+/, '');            // strip '-' + variant prefixes
      if (dropText && /^text-/.test(base)) return false;                       // size/colour/align → native
      if (/^(?:[pm][xytrbl]?|gap(?:-[xy])?|space-[xy])-/.test(base)) return false; // spacing → collides (below)
      return true;
    }).join(' ');
    n.atts.title_class    = routeClass(b.cls, true);
    n.atts.overline_class = routeClass(b.overlineCls, true);  // colour/pill/uppercase are native overline_* opts
    // #2 — assign the subtitle's Text Style preset from its captured size (e.g. 18px → font-subtitle),
    // so the subtitle keeps its scale via the editable `subtitle_size` preset. Parity with PHP n_heading.
    const subFsM = String((b.subtitleStyle && b.subtitleStyle.fontSize) || '').match(/^([0-9.]+)px$/);
    n.atts.subtitle_size = subFsM ? textPresetFor(parseFloat(subFsM[1])) : '';
    // Size now rides the preset → strip text-* from subtitle_class too (parity: dropText=true).
    n.atts.subtitle_class = routeClass(b.subtitleCls, true);
    // LAST-RESORT Custom CSS — ONLY effects a carried class can't deliver:
    //   • the title's own vertical MARGINS (no native option AND the mb-*/mt-* class collides), and
    //   • WEIGHT + LINE-HEIGHT when a display preset is set — the preset emits at `:root .display-N`
    //     (0,2,0), which outranks a plain carried class like `.font-extrabold` / `.leading-[1.1]` (0,1,0),
    //     so those two need the `!important` a class can't carry. Without a display preset the carried
    //     classes win on their own and neither is emitted here.
    // Uses the captured COMPUTED values. font-family + letter-spacing ride the class (no preset conflict).
    const clsHasArbLeading = /leading-\[/.test(String(b.cls || ''));
    // NEVER-DROP: a heading PART's own constrained measure (`max-w-* mx-auto`) — LAYOUT the tier-3
    // appearance carry deliberately excludes — reproduced as scoped max-width so it isn't silently
    // dropped (the Tailwind class compiler emits no max-width). Parity with PHP heading_measures().
    const partMaxW = (cls) => {
      for (const c of String(cls || '').split(/\s+/).filter(Boolean)) {
        const m = c.match(/^max-w-(?:\[(.+)\]|(sm|md|lg|xl|[2-7]xl))$/);
        if (m) {
          if (m[2] != null && TW_MAXW[m[2]] != null) return TW_MAXW[m[2]] + 'rem';
          if (m[1]) { const u = m[1].match(/^(\d*\.?\d+)(px|rem|em|%|vw|ch)$/); if (u) return u[1] + u[2]; }
        }
      }
      return '';
    };
    const measureDecls = (cls, sink) => {
      const mw = partMaxW(cls); if (!mw) return;
      sink.push('max-width:' + mw);
      if (/(?:^|\s)mx-auto(?:\s|$)/.test(' ' + String(cls || '') + ' ')) { sink.push('margin-left:auto'); sink.push('margin-right:auto'); }
    };
    const td = [];
    // A heading whose size didn't match a display preset (e.g. a 36px section heading) → reproduce its
    // exact font-size here rather than promoting it to the nearest (too-large) display preset.
    if (exactHeadingSize) td.push('font-size:' + exactHeadingSize);
    // A display preset is the editable base, but the SOURCE size is pinned exactly (a 44px h3 would render at the preset's
    // 48). A fluid title carries its clamp() instead. PHP parity: heading_metrics_css / the section-scoped hN rule.
    else if (n.atts.display_size && !b.fsDecl && hpx > 0) td.push('font-size:' + hpx + 'px');
    // Re-assert the SOURCE font-weight (any 100–900) so it beats the shortcode's
    // `hN.heading-title{font-weight:var(--hN-font-weight, revert)}` = the UA BOLD default — a source
    // heading at 400 (regular) otherwise renders bold. Scoped `.uHASH .heading-title` (0,2,0) wins.
    // Parity with PHP heading_weight_css() re-asserting from the computed style.
    const hw = parseInt(b.fontWeight, 10) || 0;
    if (hw >= 100 && hw <= 900) td.push('font-weight:' + hw);
    // line-height needs custom_css when the display preset out-specificities the class OR the source used
    // an arbitrary `leading-[…]` (dropped as mangle-prone above, so its effect must come from here).
    // The title's computed line-height + letter-spacing ride on the node (a heading inside a panel / card gets no
    // section-scoped rule; a stat value's 'line-height:1' = 42px otherwise took the theme's). A FLUID title carries its
    // RELATIVE metrics instead (fsDecl below). PHP twin: heading_metrics_css.
    const lh = _clean(b.lineHeight); if (lh && lh !== 'normal' && !b.fsDecl && /^[0-9.]+px$/.test(lh)) td.push('line-height:' + lh);
    const lsp = _clean(b.letterSpacing); if (lsp && lsp !== 'normal' && !b.fsDecl && /^-?[0-9.]+px$/.test(lsp)) td.push('letter-spacing:' + lsp);
    const mb = _clean(b.marginBottom); if (mb && mb !== '0px') td.push('margin-bottom:' + mb);
    const mt = _clean(b.marginTop); if (mt && mt !== '0px') td.push('margin-top:' + mt);
    // a captured ZERO is a value: without an overline nothing else asserts the title's top margin and the theme's default
    // hN margin-top (48px on an h1) doubled the carried group margin (PHP parity: title_mt_px)
    else if (mt === '0px' && !String(b.overline || '').trim()) td.push('margin-top:0px');
    measureDecls(b.cls, td); // title's own max-w-* mx-auto (never-drop)
    const rules = [];
    if (td.length) { rules.push('selector .heading-title{' + td.map((d) => d.replace(/[{}<>;]/g, '') + ' !important').join(';') + ';}'); }
    // The title's TEXT LONG TAIL (capture-extract textLongTailOf: italic / shadow / decoration metrics / clamp / columns /
    // writing-mode / wrap / indent / hyphens / numeric variants / white-space / text-stroke / gradient text). PHP: profiles.
    { const lt = String(b.longTail || '').trim(); if (lt && /^[a-z0-9()%.,:;"'\s#\/-]+$/i.test(lt)) rules.push('selector .heading-title{' + lt.split(';').map((d) => d + ' !important').join(';') + ';}'); }
    // PHONE PASS: the title's measured phone size (differs from desktop) → a max-width:767px rule. PHP parity: csSm.
    { const fsm = String(b.fontSizeSm || '').trim(); if (/^[0-9.]+px$/.test(fsm) && !b.fsDecl) { const lsm = String(b.lineHeightSm || '').trim(); rules.push('@media (max-width:767px){selector .heading-title{font-size:' + fsm + ' !important;' + (/^[0-9.]+px$/.test(lsm) ? 'line-height:' + lsm + ' !important;' : '') + '}}'); } }
    // Subtitle tier-3: its size / colour classes are routinely mangle-prone (`md:text-xl`, `text-…/70`) and
    // there's no native subtitle size/colour option, so reproduce the computed font-size / colour /
    // line-height. Only emitted for non-default values; the sanitizer-safe subtitle classes still ride
    // `subtitle_class` for editability.
    const ss = b.subtitleStyle || {};
    const sd = [];
    const sfs = _clean(ss.fontSize); if (sfs && (sfs !== '16px' || !n.atts.subtitle_size)) sd.push('font-size:' + sfs); // 16px too when no preset matched (the subtitle scale would enlarge it) — PHP parity
    const slh = _clean(ss.lineHeight); if (slh && slh !== 'normal') sd.push('line-height:' + slh);
    if (/^rgb/i.test(_clean(ss.color))) sd.push('color:' + rgbToCss(ss.color));
    measureDecls(b.subtitleCls, sd); // subtitle's own max-w-* mx-auto (never-drop) — the max-w-2xl case
    if (sd.length) { rules.push('selector .heading-subtitle{' + sd.map((d) => d.replace(/[{}<>;]/g, '') + ' !important').join(';') + ';}'); }
    { const lt = String(b.subtitleLongTail || '').trim(); if (lt && /^[a-z0-9()%.,:;"'\s#\/-]+$/i.test(lt)) rules.push('selector .heading-subtitle{' + lt.split(';').map((d) => d + ' !important').join(';') + ';}'); }
    { const lk = String(b.subtitleLinkSkin || '').trim(); if (lk && /^[a-z0-9()%.,:;\s#-]+$/i.test(lk)) rules.push('selector .heading-subtitle a{' + lk + ';}'); } // the subtitle's inline link (PHP: link_skin_decls)
    // PHONE PASS: the folded subtitle's phone size → a max-width:767px rule. PHP parity: subtitle_fs_sm.
    { const sfm = String(ss.fontSizeSm || '').trim(); if (/^[0-9.]+px$/.test(sfm)) { const slm = String(ss.lineHeightSm || '').trim(); rules.push('@media (max-width:767px){selector .heading-subtitle{font-size:' + sfm + ' !important;' + (/^[0-9.]+px$/.test(slm) ? 'line-height:' + slm + ' !important;' : '') + '}}'); } }
    // NEVER-DROP overline typography: the overline has native casing/colour/align + weight, but NO native
    // font-size or letter-spacing option. A source eyebrow like `text-[11px] tracking-[0.3em] uppercase`
    // lost its 11px size + 0.3em tracking (mangle-prone classes dropped), rendering in the theme default —
    // the "overline looks different" bug. Carry the computed size + tracking as scoped .heading-overline CSS.
    // Parity with PHP overline_typography_css.
    if (b.overline && String(b.overline).trim() !== '') {
      const od = [];
      const ofs = _clean(b.overlineFontSize); if (ofs) od.push('font-size:' + ofs);
      const ols = _clean(b.overlineLetterSpacing); if (ols && ols !== 'normal') od.push('letter-spacing:' + ols);
      const ofw = _clean(b.overlineFontWeight); if (ofw && /^[1-9]00$/.test(ofw)) od.push('font-weight:' + ofw);
      const ocl = _clean(b.overlineColor2 || b.overlineColor); if (/^rgb/i.test(ocl)) od.push('color:' + rgbToCss(ocl));
      const olh = _clean(b.overlineLineHeight); if (olh && olh !== 'normal') od.push('line-height:' + olh);
      // The overline→title gap = the overline's own margin-bottom + the title's margin-top (both computed). ZERO is a
      // value: a label flush on its h2 must not open the theme's 16px default. Emitted whenever the title's margin was
      // captured (PHP parity: title_mt_px, absent-in-capture = 0 handled by the capture stamping computed margins).
      const tmt = _clean(b.marginTop); const omb = _clean(b.overlineMarginBottom);
      if (/^[0-9.]+px$/.test(tmt)) od.push('margin-bottom:' + Math.round(parseFloat(tmt) + (/^[0-9.]+px$/.test(omb) ? parseFloat(omb) : 0)) + 'px');
      if (od.length) { rules.push('selector .heading-overline{' + od.map((d) => d.replace(/[{}<>;]/g, '') + ' !important').join(';') + ';}'); }
    }
    // NEVER-DROP pill overline SKIN → the INNER `.heading-overline__label` (the element that IS the pill: it
    // shrink-wraps its content and holds the padding/radius/bg). Painting the OUTER `.heading-overline` (a
    // full-width flex ROW) double-stacked the pill and CLIPPED long text. Reproduce the full box + layout
    // (inline-flex · items-center · gap · bg · backdrop · border · radius · padding). Parity with PHP.
    if (b.overlinePill && b.overline && String(b.overline).trim() !== '') {
      const gd = ['display:inline-flex', 'align-items:center'];
      const ggp = _clean(b.overlineGap); if (ggp && ggp !== 'normal' && !/^0px$/.test(ggp)) gd.push('gap:' + ggp);
      const gbg = _clean(b.overlineBg); if (gbg && !/transparent|rgba\([^)]*,\s*0\s*\)/.test(gbg)) gd.push('background:' + gbg);
      const gbf = _clean(b.overlineBackdrop); if (gbf && gbf !== 'none') { gd.push('backdrop-filter:' + gbf); gd.push('-webkit-backdrop-filter:' + gbf); }
      const gbw = _clean(b.overlineBorderW), gbc = _clean(b.overlineBorderColor);
      if (gbw && gbw !== '0px' && gbc) gd.push('border:' + gbw + ' solid ' + gbc);
      const grd = _clean(b.overlineRadius); if (grd && grd !== '0px') gd.push('border-radius:' + grd);
      const gpd = _clean(b.overlinePad); if (gpd && !/^(?:0px\s*)+$/.test(gpd)) gd.push('padding:' + gpd);
      if (gd.length > 2) { rules.push('selector .heading-overline__label{' + gd.map((d) => d.replace(/[{}<>;]/g, '')).join(';') + ';}'); }
    }
    // NO subtitle: reset the theme's default hN bottom margin (never reset by the shortcode) so it doesn't
    // leak as the block's below-gap and dominate the source-derived outer Margin & Padding (e.g. a 48px h1
    // default over a 24px source). The outer `spacing` option then IS the faithful gap. Parity with PHP n_heading.
    // WITH a subtitle, the title→subtitle gap is the title's own `mb-*` (e.g. mb-8 = 32px). The coarse
    // element_spacing select below rounds it to a theme default (much larger than the source), so carry the
    // EXACT px here as scoped .heading-title CSS — never-drop, reproduced faithfully. Parity with PHP n_heading.
    if (!(b.subtitle && String(b.subtitle).trim() !== '')) {
      rules.push('selector .heading-title{margin-bottom:0 !important;}');
      // NO subtitle: the block's outer bottom margin is the TITLE's own computed margin-bottom — zero included (a stat
      // card's value otherwise grew the card by the theme's default block margin). PHP parity.
      { const tmb = _clean(b.marginBottom); if (/^[0-9.]+px$/.test(tmb) && n.atts.spacing && n.atts.spacing.margin && !n.atts.spacing.margin.bottom) n.atts.spacing.margin.bottom = parseFloat(tmb) > 0 ? spacingToken('mb', parseFloat(tmb)) : 'mb-0'; }
    } else {
      // Prefer the title's COMPUTED bottom margin (survives class stripping — `mb-8` is removed from the
      // class), falling back to an `mb-*` still on the class. Parity with PHP cs_margin_bottom_px.
      const _mbc = _clean(b.marginBottom);
      let _tmbPx = /^([0-9.]+)px$/.test(_mbc) ? Math.round(parseFloat(_mbc)) : 0;
      if (!_tmbPx) { const _tmb = String(b.cls || '').match(/\bmb-(\d+(?:\.\d+)?)\b/); _tmbPx = _tmb ? Math.round(parseFloat(_tmb[1]) * 4) : 0; }
      if (!_tmbPx) { const _smt = _clean(b.subtitleStyle && b.subtitleStyle.marginTop); if (/^[0-9.]+px$/.test(_smt) && parseFloat(_smt) > 0) _tmbPx = Math.round(parseFloat(_smt)); } // the gap on the SUBTITLE's margin-top — PHP parity
      if (_tmbPx > 0 && !n.atts.element_spacing) n.atts.element_spacing = _tmbPx <= 6 ? 'tight' : (_tmbPx <= 20 ? 'relaxed' : '');
      if (_tmbPx > 0) { rules.push('selector .heading-title{margin-bottom:' + _tmbPx + 'px !important;}'); }
    }
    // FLUID title (a declared clamp()/vw size) → the expression itself, so the title scales with the viewport.
    // Its relative line-height / letter-spacing (lhDecl / lsDecl) ride along so they keep scaling with the font.
    if (b.fsDecl && /^[a-z0-9()%.,\s+*\/-]+$/i.test(String(b.fsDecl))) {
      const fl = ['font-size:' + String(b.fsDecl)];
      if (b.lhDecl && /^[0-9.]+(?:em|%)?$/.test(String(b.lhDecl))) fl.push('line-height:' + String(b.lhDecl));
      if (b.lsDecl && /^-?[0-9.]+(?:em|%)$/.test(String(b.lsDecl))) fl.push('letter-spacing:' + String(b.lsDecl));
      rules.push('selector .heading-title{' + fl.map((d) => d + ' !important').join(';') + ';}');
    }
    n.atts.custom_css = rules.join('');
    // Translate the heading-group wrapper's Tailwind LAYOUT/SPACING classes into NATIVE special_heading
    // options — otherwise they sit DEAD on css_class (no Tailwind runtime in the builder) and the heading
    // renders with the wrong spacing: no inter-line rhythm (space-y), no max width (max-w), no bottom gap
    // (mb). This is the recurring "spacing is off" miss. Unmapped classes stay on css_class.
    let align = /^(center|right)$/.test(b.align || '') ? b.align : 'left';
    const kept = [];
    for (const c of String(b.wrapCls || '').split(/\s+/).filter(Boolean)) {
      let m;
      if (c === 'text-center') { align = 'center'; }
      else if (c === 'text-right') { align = 'right'; }
      else if (c === 'text-left') { align = 'left'; }
      else if (c === 'mx-auto') { /* horizontal centring comes from block_max_width + centre align */ }
      else if ((m = c.match(/^space-y-(\d+(?:\.\d+)?)$/))) { const px = parseFloat(m[1]) * 4; n.atts.element_spacing = px <= 8 ? 'tight' : (px >= 16 ? 'relaxed' : ''); }
      else if ((m = c.match(/^max-w-(?:\[(.+)\]|(sm|md|lg|xl|[2-7]xl))$/))) {
        if (m[2] != null && TW_MAXW[m[2]] != null) { n.atts.block_max_width = { value: String(TW_MAXW[m[2]]), unit: 'rem' }; }
        else if (m[1]) { const u = m[1].match(/^(\d*\.?\d+)(px|rem|em|%|vw|ch)$/); if (u) { n.atts.block_max_width = { value: u[1], unit: u[2] }; } }
      }
      else if ((m = c.match(/^(mb|mt)-(\d+(?:\.\d+)?)$/))) {
        if (!n.atts.spacing || typeof n.atts.spacing !== 'object') { n.atts.spacing = emptySpacing(); }
        // margin value = a scale-slug utility class (mb-7 = 4rem), NOT a raw length.
        n.atts.spacing.margin[m[1] === 'mb' ? 'bottom' : 'top'] = m[1] + '-' + remToSlug(parseFloat(m[2]) * 0.25);
      }
      else { kept.push(c); }
    }
    n.atts.alignment = align;
    n.atts.css_class = kept.join(' ');
    // WITH a subtitle, the title's OWN bottom margin (`<h2 class="… mb-4">`) is the TITLE→SUBTITLE gap, so
    // it drives `element_spacing` (coarse: tight ≤6px, relaxed 7–20px, else Normal) — NOT the outer margin.
    // Left at Normal it uses the theme's font-size-relative default (much larger than a 16px source). Parity
    // with the PHP n_heading routing. `_gapToElementSpacing` then stops applyNativeMargin double-counting it
    // onto the outer bottom below.
    let _gapToElementSpacing = false;
    const _titleMb = String(b.cls || '').match(/\bmb-(\d+(?:\.\d+)?)\b/);
    if (b.subtitle && String(b.subtitle).trim() !== '' && _titleMb && !n.atts.element_spacing) {
      const gpx = parseFloat(_titleMb[1]) * 4;
      n.atts.element_spacing = gpx <= 6 ? 'tight' : (gpx <= 20 ? 'relaxed' : '');
      _gapToElementSpacing = n.atts.element_spacing !== '';
    }
    // SUBTITLE bottom margin → the block's OUTER below-gap (parity with PHP n_heading). With a subtitle it's
    // the LAST part, so its own mb-* (hero `<p … mb-8>` = 32px, the gap to the CTA button) IS the block's
    // bottom margin — it lives on the <p>, not the wrapper, so it was dropped and the heading sat flush.
    // EXACT px via spacingToken. Only when nothing else already set the outer bottom margin.
    if (b.subtitle && String(b.subtitle).trim() !== '' && (!n.atts.spacing || !n.atts.spacing.margin || !n.atts.spacing.margin.bottom)) {
      let subMbPx = null;
      const _subCs = String(b.subtitleCs || '').match(/margin-bottom:\s*([\d.]+)px/);
      if (_subCs) subMbPx = parseFloat(_subCs[1]);
      if (subMbPx == null || subMbPx <= 0) { const _sc = String(b.subtitleCls || '').match(/\bmb-(\d+(?:\.\d+)?)\b/); if (_sc) subMbPx = parseFloat(_sc[1]) * 4; }
      // …plus the paragraph's OWN padding-bottom (a hero intro's 240px that keeps the video subject clear before the CTAs) — the same below-gap in another property (PHP parity)
      { const _pb = parseFloat(_clean(b.subtitleStyle && b.subtitleStyle.paddingBottom)) || 0; if (_pb > 0) subMbPx = (subMbPx || 0) + _pb; }
      if (subMbPx && subMbPx > 0) {
        if (!n.atts.spacing || typeof n.atts.spacing !== 'object') n.atts.spacing = emptySpacing();
        n.atts.spacing.margin.bottom = spacingToken('mb', subMbPx);
      } else if (/^0px$/.test(_clean(b.subtitleStyle && b.subtitleStyle.marginBottom))) {
        // An EXPLICIT zero: the source puts the gap on the NEXT block's margin-top, so the theme's default block
        // margin would double it (a 28px row gap read 46px). PHP parity.
        if (!n.atts.spacing || typeof n.atts.spacing !== 'object') n.atts.spacing = emptySpacing();
        n.atts.spacing.margin.bottom = 'mb-0';
      }
    }
    // Overline pill colour: the source pill's text colour → native overline_color (drives the pill tint),
    // instead of a dead `text-[#hex]` class or the theme's default auto-tint.
    n.atts.overline_color = b.overlineColor ? { predefined: '', custom: rgbToCss(b.overlineColor) } : { predefined: '', custom: '' };
    // overline_uppercase: reproduce the source's kicker casing instead of blindly forcing uppercase.
    // Yes when the source overline is rendered uppercase (via text-transform) OR its text is literally
    // all-caps; otherwise No, so a normal-case overline ("New Arrivals") is not force-uppercased.
    const olText = String(b.overlineText || b.overline || '').replace(/<[^>]*>/g, '').trim();
    const isUpper = b.overlineTransform === 'uppercase' || ( /[a-z]/i.test(olText) && olText === olText.toUpperCase() );
    n.atts.overline_uppercase = isUpper ? 'yes' : 'no';
    // Overline icon: a source overline SVG → the native overline_icon (inline-svg), kept out of the text.
    n.atts.overline_icon = b.overlineIcon
      ? { type: 'svg', 'svg-source': 'inline', markup: b.overlineIcon }
      : { type: 'none' };
    n.atts.overline_icon_position = b.overlineIconPos === 'after' ? 'after' : 'before';
    // HI-FI: Pass-1 source vertical margin → the special_heading's NATIVE spacing option (fills only the
    // sides the class mapping left empty); Pass-2 the faithful base of the heading's REMAINING appearance
    // (the typography/color/align/weight it reproduces natively are `already`). Parity with PHP heading builder.
    if (hifiCss) {
      const hcs = csFromFields(b);
      if (n.atts.spacing) applyNativeMargin(n.atts.spacing, hcs, hifiCss);
      applyHifiBase(n, hcs, ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'color', 'text-transform', 'text-align'], hifiCss);
    }
    // The title→subtitle gap already went to element_spacing above; don't let it ALSO sit on the outer
    // bottom margin (applyNativeMargin would re-read the heading's own mb). Keep the two from double-counting.
    if (_gapToElementSpacing && n.atts.spacing && n.atts.spacing.margin) n.atts.spacing.margin.bottom = '';
    // The heading GROUP wrapper's own vertical margin (capture-extract mtAdd / mbAdd on the boundary parts) → the Spacing
    // when nothing more specific set it. PHP: the flush_head mbAdd / mtAdd carry.
    if (n.atts && n.atts.spacing && n.atts.spacing.margin) {
      if (b.mbAdd > 0 && (!n.atts.spacing.margin.bottom || n.atts.spacing.margin.bottom === 'mb-0')) n.atts.spacing.margin.bottom = spacingToken('mb', b.mbAdd); // an inner part's explicit ZERO is not the group's gap
      if (b.mtAdd > 0 && (!n.atts.spacing.margin.top || n.atts.spacing.margin.top === 'mt-0')) n.atts.spacing.margin.top = spacingToken('mt', b.mtAdd);
    }
    return n;
  };
  // Classify a captured button by its RESOLVED look (parity with the PHP mapper's button_style_class):
  // an opaque fill → primary; a transparent/white fill with a border → outline; else a bare fill.
  const buttonKindClasses = (b) => {
    const cls = ' ' + String(b.cls || '').toLowerCase() + ' ';
    const bg = String((b.bs && b.bs.bg) || '');
    const opaque = /rgba?\([^)]*(?:,\s*(?:0?\.[1-9]|1)\s*)?\)/.test(bg) && !/rgba?\([^)]*,\s*0\s*\)/.test(bg) && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)';
    const white = /rgb\(255,\s*255,\s*255\)/.test(bg) || /\sbg-white\b/.test(cls);
    const hasBorder = (b.bs && b.bs.bd && b.bs.bds && b.bs.bds !== 'none') || /\sborder\b/.test(cls);
    const bgClass = /\sbg-(?!transparent)/.test(cls);
    // A PILL radius or FROSTED backdrop marks a BUTTON surface even when a very-translucent fill (bg-white/8)
    // was not captured as a computed background — so it is NEVER a bare underlined text link. Mirror of PHP
    // button_kind(): only a truly bare text CTA becomes 'link' (→ the native underlined .btn-link).
    const surface = /\srounded-full\s/.test(cls) || /\srounded-(?:2xl|3xl)\s/.test(cls)
      || /(?:^|;)\s*border-radius:\s*(?:9999|[3-9]\d)/.test(String((b.bs && b.bs.radius) || ''))
      || /\sbackdrop-blur/.test(cls) || /blur/i.test(String((b.bs && b.bs.backdrop) || ''));
    if (opaque && !white) return 'primary';
    if (white || hasBorder) return 'outline';
    if (opaque || bgClass) return 'fill';
    if (surface) return 'outline';   // pill/frosted ghost, no captured fill → a button, not a link
    return 'link';                   // truly bare text CTA
  };
  // Drop Tailwind spacing/gap utilities (p*/m*/gap-*/space-*, incl. responsive/hover variants + negative
  // + arbitrary `px-[12px]`) from a carried class list — they collide by name with the plugin's own
  // identically-named `!important` utilities but map to the plugin's own spacer scale. Non-spacing
  // utilities (bg-*, text-*, rounded-*, border, flex, min-h-*, place-*) are kept.
  const stripSpacingUtils = (cls) => String(cls || '').trim().split(/\s+/).filter((t) => {
    if (!t) return false;
    const base = t.replace(/^-/, '').replace(/^(?:[\w]+:)+/, ''); // strip leading '-' and variant prefixes (sm:/hover:/2xl:)
    return !/^(?:[pm][xytrbl]?|gap(?:-[xy])?|space-[xy])-/.test(base);
  }).join(' ').trim();

  const buttonBlockNode = (b) => {
    const kind = buttonKindClasses(b);
    // Carry the source button's OWN utility classes (bg-*, text-*, border, rounded-*, px-*, py-*): the
    // section's carried CSS then paints each button with the SOURCE's exact fill — a green solid pill vs
    // a white outline pill — instead of every decomposed button collapsing to the theme's one default
    // style. style:'' = the bare .btn base (loaded before the section CSS) so the carried classes win.
    // BUT strip the Tailwind SPACING utilities (p*/m*/gap-*/space-*): they collide 1:1 BY NAME with the
    // plugin's own `!important` spacing utilities, which resolve to the plugin's DIFFERENT spacer scale
    // (e.g. `.px-8` → var(--spacer-8) = 72px, not Tailwind's 32px) and, being equal-specificity but later
    // in the cascade, beat even the custom_css `!important` below. The button's REAL padding is reproduced
    // from its computed value in custom_css, so dropping the class loses nothing and kills the collision.
    const _clsBase = stripSpacingUtils(b.cls);
    const cls = [_clsBase, 'sc-btn-' + kind].filter(Boolean).join(' ').trim();
    // Icon: an INLINE SVG (a lucide arrow etc.) → the button's svg icon, verbatim; else a font-icon class.
    const icon = (b.iconSvg && String(b.iconSvg).trim())
      ? { type: 'svg', source: 'inline', 'svg-source': 'inline', markup: String(b.iconSvg).trim() }
      : (b.icon && String(b.icon).trim())
        ? { type: 'icon-class', 'icon-class': String(b.icon).trim(), 'icon-class-without-root': false, 'pack-name': false, 'pack-css-uri': false }
        : { type: 'none' };
    // The source's px-8 py-4 collides with the plugin's own `.px-8`/`.py-4` `!important` utilities (24px
    // vs 72px), which also stretch the button full-width. Re-assert the source's COMPUTED padding +
    // inline-flex auto width on the button element via its Advanced Custom CSS (`selector` = the button),
    // `!important` to beat the colliding utilities. Keeps the pill compact + content-sized, like the source.
    const decl = [];
    if (b.pad) {
      const padStr = String(b.pad).replace(/[{}<>;]/g, '').trim();
      // Source CTAs frequently size their HEIGHT via a FIXED height (Tailwind `h-11` = 44px) + flex centring,
      // NOT vertical padding — so the computed vertical padding comes back ~0. Reproducing that verbatim
      // squashes the button to text-height. Deriving padding from the height OVERSHOOTS (line-height + border
      // guesswork). The exact reproduction: assert the measured min-height + centred flex + the captured
      // horizontal padding, so the button is precisely the source's height with content centred.
      const parts = padStr.split(/\s+/);
      const vtop = parseFloat(parts[0]) || 0;
      const hpx = parseFloat(b.height) || 0, fspx = parseFloat(b.fontSize || b.fs) || 16;
      if (vtop < 4 && hpx > fspx * 1.6) {
        const hpad = parts.length >= 2 ? parts.slice(1).join(' ') : '0px';
        decl.push('min-height:' + Math.round(hpx) + 'px !important');
        decl.push('padding:0 ' + hpad + ' !important');
        decl.push('display:inline-flex !important');
        decl.push('align-items:center !important');
        decl.push('justify-content:center !important');
      } else {
        decl.push('padding:' + padStr + ' !important');
      }
    }
    // Assert the source's FILL / TEXT / BORDER too — the plugin's `.btn` base + button preset otherwise
    // win over the carried Tailwind classes (they collide + `hover:` classes get sanitizer-mangled), so a
    // white "Take a Tour" rendered white-text-on-white with an orange preset border. `!important` + the
    // captured computed values reproduce the exact source look. border:0 kills the plugin border on a
    // borderless solid button; a real 1px source border is reproduced verbatim.
    const okc = (v) => v && v !== 'rgba(0, 0, 0, 0)' && v !== 'transparent' && /^(rgb|#|hsl)/i.test(String(v).trim());
    if (b.bs) {
      if (okc(b.bs.bg)) { decl.push('background:' + b.bs.bg + ' !important'); }
      if (okc(b.bs.fg)) { decl.push('color:' + b.bs.fg + ' !important'); }
      if (b.bs.bw && b.bs.bw !== '0px' && b.bs.bds && b.bs.bds !== 'none' && okc(b.bs.bd)) {
        decl.push('border:' + b.bs.bw + ' ' + b.bs.bds + ' ' + b.bs.bd + ' !important');
      } else {
        decl.push('border:0 !important');
      }
    }
    // Reproduce the source's TYPOGRAPHY + RADIUS too. font-size (text-sm/text-base), line-height, font-weight
    // and border-radius (rounded-md) are carried as Tailwind CLASSES that DO NOT EXIST on WordPress, so their
    // effect is DROPPED — the button falls back to the `.btn` base (16px font · 6px radius) and renders bigger
    // than the source. Emitting the captured COMPUTED values makes the button self-contained: no dead class,
    // nothing dropped, exact size. (Root cause of the recurring "button size doesn't match".)
    const _fs = String(b.fontSize || b.fs || '').trim();
    if (/^[0-9.]+px$/.test(_fs)) decl.push('font-size:' + _fs + ' !important');
    const _lh = String(b.lineHeight || b.lh || '').trim();
    if (/^[0-9.]+px$/.test(_lh)) decl.push('line-height:' + _lh + ' !important');
    const _fw = String(b.fontWeight || b.fw || '').trim();
    if (/^[1-9]00$/.test(_fw)) decl.push('font-weight:' + _fw + ' !important');
    const _rad = String(b.radius || '').trim();
    if (_rad && !/^0px$/.test(_rad)) decl.push('border-radius:' + _rad + ' !important');
    decl.push('width:auto !important', 'display:inline-flex !important', 'align-items:center', 'gap:.5rem');
    let custom_css = 'selector{' + decl.map((d) => d.replace(/[{}<>;]/g, '')).join(';') + ';}';
    // NEVER-DROP button hover: the source's RESOLVED hover colours (hoverStyle() probes the `hover:*`
    // utilities, so `hover:bg-primary/90` becomes a concrete LIGHTER rgba). Without emitting them the
    // button falls back to the shortcode's darken-on-hover default — the "hover is the opposite/darker"
    // bug. Scoped :hover with !important wins over `:where(.btn-primary):hover`. Parity with PHP n_button.
    // Attach the matching button_colors / button_sizes preset slug (the header CTA does the same).
    const preset = _buttonPresetFor(b);
    // When a colour PRESET matched, its `.btn-{slug}:hover` already carries the source-exact hover fill, so
    // DON'T also emit this node's per-colour `selector:hover !important` — a redundant override that outranks
    // the preset (and, in the PHP path, is where an undefined `var(--secondary)` slipped through). Keep the
    // per-node hover only when no colour preset owns it. Parity with PHP hover_verbatim_css($has_color_preset).
    const _hasColorPreset = !!preset.style && preset.style !== 'btn-link';
    const _hov = b.hover || (b.bs && b.bs.hover) || null;
    if (_hov && !_hasColorPreset) {
      const hd = [];
      if (okc(_hov.backgroundColor)) hd.push('background:' + _hov.backgroundColor + ' !important');
      if (okc(_hov.color)) hd.push('color:' + _hov.color + ' !important');
      if (okc(_hov.borderColor)) hd.push('border-color:' + _hov.borderColor + ' !important');
      if (hd.length) custom_css += 'selector:hover{' + hd.map((d) => d.replace(/[{}<>;]/g, '')).join(';') + ';}';
    }
    // A STANDALONE button carries its own horizontal alignment (a centred CTA button under a `text-center`
    // block reads `text-align:center`). Grouped buttons (a hero flex-row) are positioned by their row
    // column instead (content_direction/content_h), so leave those at default to avoid wrapping each in a
    // centring div that would break the side-by-side layout.
    const btnAlign = (!b.groupRow && /^(center|right)$/.test(String(b.align || ''))) ? b.align : '';
    // A text-link CTA (kind 'link') that matched no colour preset → the NATIVE `btn-link` style (its exact
    // colour is already in the per-node custom_css above), so no `sc-btn-link` marker is carried. Parity with PHP.
    const _btnStyle = preset.style || (kind === 'link' ? 'btn-link' : '');
    // FULL WIDTH — a source `w-full` (or block width:100%) button → the native Full Width mode so it fills its
    // column (the hero card CTA). Parity with PHP n_button's $bfull → width.mode='w-100'.
    const _bcls = ' ' + String(b.cls || '').toLowerCase() + ' ' + String(b.groupCls || '').toLowerCase() + ' ';
    const _bfull = /\s(w-full|w-100|w-screen|block)\s/.test(_bcls);
    // WRAPPER VERTICAL MARGIN — a lone CTA's wrapper `mt-*`/`mb-*` gap → the native spacing option. Parity with PHP.
    const _bsp = emptySpacing();
    let _mm;
    const _wcls = ' ' + String(b.groupCls || '').toLowerCase() + ' ';
    if ((_mm = _wcls.match(/\smt-(\d+(?:\.\d+)?)\b/))) _bsp.margin.top = spacingToken('mt', parseFloat(_mm[1]) * 4);
    if ((_mm = _wcls.match(/\smb-(\d+(?:\.\d+)?)\b/))) _bsp.margin.bottom = spacingToken('mb', parseFloat(_mm[1]) * 4);
    const node = { type: 'simple', shortcode: 'button', _items: [], atts: {
      label: b.label, link: localize(b.href), target: 'no',
      style: _btnStyle, size: preset.size, icon, icon_position: (b.iconPos === 'before' ? 'before' : 'after'),
      alignment: btnAlign, state: '', hover_animation: '', css_class: (_btnStyle ? _clsBase : cls), custom_css, unique_id: uid(),
      width: { mode: _bfull ? 'w-100' : '', custom: { custom_width: { value: '', unit: 'px' } } },
      spacing: _bsp,
    } };
    if (_bfull) node.atts.custom_css = (node.atts.custom_css || '') + 'selector{align-self:stretch;width:100%;}';
    // HI-FI Pass-2 faithful base — the color/size preset + the sc-btn class + the per-node safety-net CSS
    // already reproduce the fill / text / border / radius / typography (`already`); the base only fills
    // leftover appearance (a gradient background-image, opacity, transform, …). Parity with PHP button builder.
    if (hifiCss) {
      const bs = b.bs || {};
      const bcs = csFromFields(Object.assign({}, b, {
        bg: bs.bg, color: bs.fg,
        border: (bs.bw && bs.bw !== '0px' && bs.bds && bs.bds !== 'none') ? (bs.bw + ' ' + bs.bds + ' ' + bs.bd) : undefined,
      }));
      const already = ['background-color', 'color', 'border', 'border-radius', 'box-shadow', 'font-family', 'font-size', 'font-weight', 'letter-spacing', 'text-transform'];
      // A PRESET-owned button: the preset also carries its gradient (background-image), transition and shadow; the
      // size preset its line-height; the .btn base its text-align — none of it belongs per-node. Parity with PHP.
      if (_btnStyle && _btnStyle !== 'btn-link') already.push('background-image', 'transition', 'text-align', 'line-height');
      applyHifiBase(node, bcs, already, hifiCss);
    }
    return node;
  };

  // A provider embed iframe src → an oEmbed-friendly PAGE url (WP oEmbed needs the page URL, not
  // the /embed/ iframe src). Unknown hosts pass through. Mirrors PHP Mapper::embed_to_page_url().
  const embedToPageUrl = (src) => {
    src = String(src || '').trim();
    if (!src) return '';
    let m;
    if ((m = src.match(/youtube(?:-nocookie)?\.com\/embed\/([\w-]+)/))) return 'https://www.youtube.com/watch?v=' + m[1];
    if ((m = src.match(/player\.vimeo\.com\/video\/(\d+)/)))            return 'https://vimeo.com/' + m[1];
    if ((m = src.match(/dailymotion\.com\/embed\/video\/([\w]+)/)))     return 'https://www.dailymotion.com/video/' + m[1];
    return src;
  };
  // A source <video> / provider <iframe> block → the NATIVE media_video shortcode (self-hosted file
  // OR oEmbed URL) — never a raw <video> in a text/code block. Mirrors PHP Mapper::n_video(): full
  // source_type multi-picker shape (both branches) so the builder corrector accepts it; autoplay
  // forces muted (browser policy). media_video is not in atom-templates, so build the node inline.
  const videoNode = (b) => {
    let mode = b.mode === 'embed' ? 'embed' : 'self_hosted';
    const src = String(b.src || '').trim(), webm = String(b.webm || '').trim(), poster = String(b.poster || '').trim();
    let embed = b.embedUrl ? embedToPageUrl(b.embedUrl) : '';
    if (mode === 'self_hosted' && !src && !webm) { mode = 'embed'; if (!embed && src) embed = src; }
    const up = (u) => (u ? { attachment_id: '', url: u } : []);
    const st = {
      source: mode,
      embed: { url: embed, youtube_nocookie: 'no', lazy_facade: 'no', poster: up(mode === 'embed' ? poster : '') },
      self_hosted: {
        video_file: up(src), video_webm: up(webm), video_url: '', poster: up(mode === 'self_hosted' ? poster : ''),
        autoplay: b.autoplay || 'no', muted: b.muted || 'no', loop: b.loop || 'no',
        controls: b.controls || 'yes', playsinline: b.playsinline || 'yes', preload: 'metadata',
        // A cover-fill source (`object-cover`, e.g. a portrait reel) should FILL its ratio box, not letterbox
        // inside it — carry object-fit so it matches the source instead of showing black bars. PHP twin: n_video.
        object_fit: b.cover ? 'cover' : 'contain',
      },
    };
    if (st.self_hosted.autoplay === 'yes') st.self_hosted.muted = 'yes';
    // Ratio from the source's own aspect (portrait `9x16` reel, `1x1`, …); default landscape 16:9. A portrait
    // clip gets a narrower box, and the source's responsive visibility (`sm:hidden` mobile-only reel → hidden
    // on desktop) is carried. Parity with PHP Mapper::n_video().
    const ratio = ['16x9', '4x3', '1x1', '21x9', '9x16', '3x4'].includes(String(b.aspect || '')) ? String(b.aspect) : '16x9';
    const vwidth = (ratio === '9x16' || ratio === '3x4') ? 320 : 600;
    const rhide = b.rhideCls && String(b.rhideCls).trim() ? responsiveHideFromClasses(String(b.rhideCls)) : {};
    const vn = { type: 'simple', shortcode: 'media_video', _items: [], atts: { source_type: st, width: { value: vwidth, unit: 'px' }, ratio, responsive_hide: rhide, unique_id: uid() } };
    if (b.shapeCss && String(b.shapeCss).trim()) vn.atts.custom_css = String(b.shapeCss).trim(); // the clip's shell: radius / mask / filter / aspect + cap / animation (PHP: media_shape_css)
    return vn;
  };

  // A standalone image → the native media_image element (NOT a gallery — that's for multiple
  // images — and NOT a code_block). Mirrors PHP Mapper::n_media_image(); the importer sideloads src.
  /**
   * A GRID OF PHOTOS (capture-extract galleryBlockOf) -> the native `gallery` shortcode: the source images, its
   * column count / gap / tile ratio, and the CORNERS taken from the tiles' measured radius (0 -> square, <= 8px ->
   * the 6px `rounded`, larger -> `rounded-lg`). PHP twin: n_gallery().
   */
  const galleryNode = (b) => {
    const images = (b.images || []).filter((i) => i && i.url).map((i) => ({ attachment_id: '', url: i.url, alt: i.alt || '' }));
    if (images.length < 3) return null;
    const px = (v) => { const n = parseFloat(String(v == null ? '' : v)); return Number.isFinite(n) ? n : null; };
    const tr = b.tileRadius === '' || b.tileRadius == null ? null : px(b.tileRadius);
    const rounded = tr == null ? 'rounded-0' : (tr <= 0.5 ? 'rounded-0' : (tr <= 8 ? 'rounded' : 'rounded-lg'));
    // the gap -> the shortcode's gap scale (its own 0-6 steps), the nearest step to the measured px
    const gp = px(b.gap) || 0;
    const gap = String([0, 8, 16, 24, 32, 48, 64].reduce((best, v, i, arr) => (Math.abs(v - gp) < Math.abs(arr[best] - gp) ? i : best), 0));
    const RATIOS = { '1-1': 1, '4-3': 4 / 3, '3-2': 1.5, '16-9': 16 / 9, '3-4': 0.75, '2-3': 2 / 3 };
    let ratio = '4-3';
    { const m = String(b.ratio || '').match(/^([0-9.]+)-([0-9.]+)$/); if (m && +m[2]) { const r = +m[1] / +m[2]; let bd = Infinity; for (const [k, v] of Object.entries(RATIOS)) { const d = Math.abs(v - r); if (d < bd) { bd = d; ratio = k; } } } }
    const cols = String(Math.max(2, Math.min(6, parseInt(b.colCount, 10) || 3)));
    return { type: 'simple', shortcode: 'gallery', _items: [], atts: {
      source: { kind: 'media', media: { images } },
      design_settings: { design: 'grid', grid: { columns: { count: cols }, gap, ratio } },
      container_type: '', click: { action: 'lightbox' },
      captions: b.captions === 'overlay' ? 'overlay' : 'none', caption_source: 'caption',
      hover_zoom: 'yes', rounded,
      unique_id: uid(), css_id: '', css_class: '', custom_css: '', responsive_hide: [], custom_attrs: [],
    } };
  };

  /**
   * A hero SCROLL CUE (capture-extract scrollCueOf) -> the native `scroll_indicator`, pinned with the Position
   * option the source's placement gives it, the label's measured type scoped on `.sc-scroll-cue__label`, and the
   * utility's own half-width centring. PHP twin: n_scroll_cue().
   */
  const scrollCueNode = (b) => {
    const icon = b.lucide && /^lucide\/[a-z0-9-]+$/.test(b.lucide)
      ? { type: 'svg', 'svg-source': 'library', 'svg-id': b.lucide, markup: '' }
      : (String(b.svg || '').trim() ? { type: 'svg', 'svg-source': 'inline', markup: b.svg, 'svg-id': '' }
        : (b.fa ? { type: 'icon-font', 'icon-class': b.fa } : { type: 'none' }));
    const atts = {
      text: b.text || '', icon, target: b.target || '',
      layout: ['stacked', 'stacked-reverse', 'inline', 'icon-only'].includes(b.layout) ? b.layout : 'stacked',
      animation: 'bounce',
      unique_id: uid(), css_id: '', css_class: '', custom_css: '', responsive_hide: [], custom_attrs: [],
    };
    const ls = b.labelStyle || {};
    if (ls.color) atts.text_color = { predefined: '', custom: ls.color };
    if (b.color) atts.icon_color = { predefined: '', custom: b.color };
    if (b.size > 0) atts.icon_size = { value: String(Math.round(b.size)), unit: 'px' };
    const css = ['selector{margin:0;}'];
    { const d = []; for (const k of ['fontSize', 'letterSpacing', 'textTransform', 'fontWeight', 'lineHeight']) {
        const v = ls[k]; if (!v || v === 'normal' || v === 'none') continue;
        d.push(k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()) + ':' + v);
      }
      if (d.length) css.push(`selector .sc-scroll-cue__label{${d.join(';')};}`); }
    if (b.gap) css.push(`selector .sc-scroll-cue{gap:${b.gap};}`);
    // the native Position option from the source's placement (the section is its containing block)
    const p = b.pos || {};
    if (/^(absolute|fixed)$/.test(p.position || '')) {
      const off = (v) => { const n = parseFloat(String(v == null ? '' : v)); return Number.isFinite(n) ? { value: String(Math.round(n)), unit: 'px' } : { value: '', unit: 'auto' }; };
      atts.element_position = { position: p.position, [p.position]: {
        pos_offsets: { top: /^-?[\d.]+px$/.test(p.top || '') && !/^-?[\d.]+px$/.test(p.bottom || '') ? off(p.top) : { value: '', unit: 'auto' },
          right: { value: '', unit: 'auto' },
          bottom: /^-?[\d.]+px$/.test(p.bottom || '') ? off(p.bottom) : { value: '', unit: 'auto' },
          left: /(^|\s)-?left-1\/2(\s|$)/.test(b.pinCls || '') ? { value: '50', unit: '%' } : off(p.left) },
        element_zindex: p.zIndex && p.zIndex !== 'auto' && p.zIndex !== '0' ? String(p.zIndex) : '',
      } };
      if (/(^|\s)-translate-x-1\/2(\s|$)/.test(b.pinCls || '')) css.push('selector{transform:translateX(-50%);}');
    }
    atts.custom_css = css.join('\n');
    return { type: 'simple', shortcode: 'scroll_indicator', _items: [], atts };
  };

  const mediaImageNode = (b) => {
    // Reproduce the source image's own SKIN (an ORGANIC blob border-radius, object-fit, a soft
    // shadow) via the shortcode's Advanced Custom CSS — `selector` is replaced with the element's
    // generated id, so `selector img` targets the rendered <img>. Without this a hero photo that the
    // source rounds into a blob ships as a bare rectangle.
    const decl = [];
    if (b.blob) { decl.push('position:relative'); decl.push('z-index:1'); }
    if (b.radius) decl.push(`border-radius:${b.radius}`);
    // ASPECT-RATIO + FILL — a source aspect-video/aspect-[w/h] frame with object-cover crops the photo to a
    // fixed box; force the <img> to fill + cover so the native media_image reproduces the crop (parity with
    // PHP img_composite_skin_css). object-fit falls back to cover when a fixed-ratio box is present.
    let fit = b.objectFit || '';
    const wrap = ['position:relative'];
    if (b.aspect) { wrap.push(`aspect-ratio:${b.aspect}`, 'overflow:hidden'); decl.push('width:100%', 'height:100%'); if (!fit || fit === 'fill') fit = 'cover'; }
    if (fit && fit !== 'fill') decl.push(`object-fit:${fit}`);
    // …the image's OWN pinned box (capture-extract imgSkin.pinnedH) when no wrapper frame gave it one.
    // PHP twin: media_box_css_el()'s own-box fallback.
    if (b.pinnedH && !b.aspect) { decl.push('width:100%', `height:${b.pinnedH}px`); if (!fit || fit === 'fill') decl.push('object-fit:cover'); }
    if (b.borderWidth && b.borderColor) decl.push(`border:${b.borderWidth} ${b.borderStyle || 'solid'} ${b.borderColor}`);
    if (b.outline) decl.push(`outline:${b.outline}`);
    if (b.shadow) decl.push(`box-shadow:${b.shadow}`);
    let custom_css = decl.length ? `selector img{${decl.join(';')};}` : '';
    // a CSS-painted photo cell (capture-extract bgPhotoOf) covers its measured box (PHP: bg_photo_block)
    if (b.bgPhoto && typeof b.bgPhoto === 'object') { const h = (b.bgPhoto.h | 0) > 0 ? (b.bgPhoto.h | 0) : 240; const pos = /^[a-z0-9.%\s-]+$/i.test(String(b.bgPhoto.pos || '')) ? b.bgPhoto.pos : 'center'; custom_css = (custom_css + ' selector{height:100%;min-height:' + h + 'px;}selector .image,selector figure{height:100%;margin:0;}selector img{width:100%;height:100%;object-fit:cover;object-position:' + pos + ';display:block;}').trim(); }
    // The image's own filter / object-position / aspect-ratio (capture-extract imgExtraOf). PHP: img_extra_css → skinCss.
    { const ex = String(b.extra || '').trim(); if (ex && /^[a-z0-9()%.,:;\s#\/-]+$/i.test(ex)) custom_css = (custom_css + ' selector img{' + ex + ';}').trim(); }
    // FILL (a photo tile: the image stretches to its framed cell, object-fit cover): the media_image grows in
    // its flex-column cell and the <img> covers it. The core image helper only honours object-fit with an
    // aspect ratio (width+height both set → contain), so the fill is a scoped rule. PHP twin: image builder.
    // A cover-FILL only makes sense beside its text cell (a side-by-side row); stacked on a phone the source image sits at
    // its natural height, so the fill rides a min-width:992px rule. PHP parity: the 'image' builder.
    if (b.fill && !b.aspect) custom_css = (custom_css + ' @media (min-width:992px){selector{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;}selector img{flex:1 1 auto;width:100%;min-height:0;object-fit:cover;display:block;}}').trim();
    // An overlay layer → a scoped `selector::before` (no extra element / code_block), mirroring the PHP
    // img_composite_skin_css. A full-bleed `inset-0` SCRIM paints ON TOP (z-index above the img) and clears
    // on hover when `hover:bg-transparent`; an offset/rounded BLOB stays BEHIND (z-index:0). `selector` needs
    // position:relative — provided by the wrapper rule below.
    if (b.blob || b.aspect) {
      let before = '';
      if (b.blob) {
        const scrim = !!b.blob.scrim;
        const bd = ['content:""', 'position:absolute', 'inset:0', 'pointer-events:none', `z-index:${scrim ? 2 : 0}`];
        if (b.blob.bg && !/rgba?\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/.test(b.blob.bg)) bd.push(`background:${b.blob.bg}`);
        if (b.blob.radius && !scrim) bd.push(`border-radius:${b.blob.radius}`);
        if (b.blob.scale) bd.push(`transform:scale(${b.blob.scale})`);
        if (b.blob.hoverClear) bd.push(`transition:background ${b.blob.dur || '0.5s'} ease`);
        before = `selector::before{${bd.join(';')};}` + (b.blob.hoverClear ? 'selector:hover::before{background:transparent;}' : '');
      }
      custom_css = `selector{${wrap.join(';')};}` + custom_css + before;
    }
    // PINNED LABELS over the photo (capture-extract pinnedLabelOf) → scoped pseudo-element rules, so the
    // line stays where the source holds it and keeps its own face. Without this it rendered as an ordinary
    // paragraph below the picture. PHP twin: img_pinned_labels_css.
    const labels = Array.isArray(b.labels) ? b.labels : [];
    if (labels.length) {
      const slots = b.blob ? ['::after'] : ['::after', '::before'];
      let pin = '';
      labels.forEach((L, i) => {
        if (!slots[i] || !L || !L.text) return;
        const d = [`content:${JSON.stringify(L.text)}`, 'position:absolute', 'z-index:3', 'pointer-events:none', 'white-space:nowrap'];
        if (L.vAnchor) d.push(`${L.vAnchor[0]}:${L.vAnchor[1]}px`);
        if (L.hAnchor) d.push(`${L.hAnchor[0]}:${L.hAnchor[1]}px`);
        for (const [p, v] of [['color', L.color], ['font-family', L.fontFamily], ['font-size', L.fontSize],
          ['font-weight', L.fontWeight], ['line-height', L.lineHeight], ['letter-spacing', L.letterSpacing],
          ['text-transform', L.textTransform], ['opacity', L.opacity], ['background', L.bg], ['padding', L.padding]]) {
          if (v) d.push(`${p}:${v}`);
        }
        pin += `selector${slots[i]}{${d.join(';')};}`;
      });
      if (pin) custom_css = (`selector{position:relative;}` + custom_css + pin).trim();
    }
    return { type: 'simple', shortcode: 'media_image', _items: [], atts: {
      image: { attachment_id: '', url: b.src || '', alt: b.alt || '' },
      width: { value: '', unit: 'px' }, height: { value: '', unit: 'px' },
      fetchpriority: 'auto', link: '', target: '_self', custom_css, unique_id: uid(),
    } };
  };

  // A source PRODUCT-CARD grid (each card = image + name + price [+ add-to-cart]) → the wc_products
  // grid. WooCommerce owns the products, and the converter can't know the real product IDs from a
  // static source, so it emits a placeholder grid (source: recent) to configure to your catalogue —
  // NOT N static icon_boxes. Flagged in the report as an opportunity.
  // Tailwind's default box-shadow scale (for hover:shadow-* → CSS). Rest shadow uses the captured
  // computed value directly; only the hover state needs this (it isn't in the resting computed style).
  const TW_SHADOW = {
    sm: '0 1px 2px 0 rgba(0,0,0,.05)',
    md: '0 4px 6px -1px rgba(0,0,0,.1), 0 2px 4px -2px rgba(0,0,0,.1)',
    lg: '0 10px 15px -3px rgba(0,0,0,.1), 0 4px 6px -4px rgba(0,0,0,.1)',
    xl: '0 20px 25px -5px rgba(0,0,0,.1), 0 8px 10px -6px rgba(0,0,0,.1)',
    '2xl': '0 25px 50px -12px rgba(0,0,0,.25)',
  };
  // Translate a captured product-card wrapper skin + hover + ribbon into scoped section CSS for the
  // wc_products grid (`.upwc-product` = card, `.upwc-product__badge.ribbon` = the badge). Editable
  // Custom CSS with zero shortcode-option bloat — the card skin is CSS-only by design (see the Card
  // Layout option). Returns '' when there's nothing to translate.
  const wcCardCss = (wrap, ribbon) => {
    let css = '';
    if (wrap) {
      const rest = [];
      if (wrap.bg && !/rgba?\(0, 0, 0, 0\)|transparent/.test(wrap.bg)) rest.push(`background:${wrap.bg}`);
      if (wrap.radius && parseFloat(wrap.radius) > 0) rest.push(`border-radius:${wrap.radius}`);
      if (wrap.borderW && parseFloat(wrap.borderW) > 0) rest.push(`border:${wrap.borderW} ${wrap.borderStyle || 'solid'} ${wrap.borderColor}`);
      if (wrap.shadow) rest.push(`box-shadow:${wrap.shadow}`);
      const hasHover = wrap.hoverShadow || wrap.hoverLift;
      if (hasHover) rest.push('transition:transform .3s ease, box-shadow .3s ease');
      if (rest.length) css += `.upwc-products .upwc-product{${rest.join(';')}}\n`;
      if (hasHover) {
        const hv = [];
        if (wrap.hoverShadow && TW_SHADOW[wrap.hoverShadow]) hv.push(`box-shadow:${TW_SHADOW[wrap.hoverShadow]}`);
        if (wrap.hoverLift) hv.push(`transform:translateY(-${Math.round(parseFloat(wrap.hoverLift) * 4)}px)`);
        if (hv.length) css += `.upwc-products .upwc-product:hover{${hv.join(';')}}\n`;
      }
    }
    if (ribbon) {
      const r = [];
      if (ribbon.bg) r.push(`background:${ribbon.bg}`);
      if (ribbon.color) r.push(`color:${ribbon.color}`);
      if (ribbon.radius && parseFloat(ribbon.radius) > 0) r.push(`border-radius:${ribbon.radius}`);
      if (ribbon.padding) r.push(`padding:${ribbon.padding}`);
      if (ribbon.fontSize) r.push(`font-size:${ribbon.fontSize}`);
      if (ribbon.fontWeight) r.push(`font-weight:${ribbon.fontWeight}`);
      if (ribbon.letterSpacing && ribbon.letterSpacing !== 'normal') r.push(`letter-spacing:${ribbon.letterSpacing}`);
      if (ribbon.borderW && parseFloat(ribbon.borderW) > 0) r.push(`border:${ribbon.borderW} solid ${ribbon.borderColor}`);
      r.push('text-transform:uppercase');
      if (r.length) css += `.upwc-products .upwc-product__badge.ribbon{${r.join(';')}}\n`;
    }
    return css;
  };
  const wcProductsNode = (cols, count, hasRibbon) => ({ type: 'simple', shortcode: 'wc_products', _items: [], atts: {
    source: 'recent', category: '', posts_per_page: String(count || cols), orderby: 'menu_order', order: 'ASC',
    layout: 'grid', columns: String(cols), gap: 'lg', image_ratio: 'square',
    show_price: 'yes', show_add_to_cart: 'yes', add_to_cart_text: 'Add to Cart',
    show_rating: 'no', show_excerpt: 'yes', show_ribbon: hasRibbon ? 'yes' : 'no', show_wishlist: 'no', show_sale_badge: 'no',
    // The card is always assembled from these rows (the row system is the single card model; the
    // former card_layout Classic/Slot toggle was removed). The default four rows mirror the wc_products
    // seed; empty slots/rows collapse (no rating → the rating row is skipped), so it degrades gracefully.
    card_rows: [
      { slots: ['badges', 'wishlist'],        direction: 'inline', justify: 'between', align: 'center' },
      { slots: ['media', 'title', 'excerpt'], direction: 'stack',  justify: 'start',   align: 'center' },
      { slots: ['rating', 'rating_count'],    direction: 'inline', justify: 'center',  align: 'center' },
      { slots: ['price', 'cart'],             direction: 'inline', justify: 'between', align: 'center' },
    ],
    pagination: 'none', unique_id: uid(),
  } });
  // True when a grid cell looks like a product card: an image + a price token (+ usually a CTA); OR a
  // DECOMPOSED card whose raw price span was dropped but whose WooCommerce `.product` / `type-product`
  // class survives on the cell/card (the live [wc_products] feed supplies the real prices). Parity with
  // PHP cell_is_product.
  const cellIsProduct = (c) => {
    const h = String(c.html || '');
    if (/<img/i.test(h) && /(?:\$|€|£)\s?\d+[.,]\d{2}/.test(h)) return true;
    const cls = ' ' + String((c.fullCls || '') + ' ' + (c.cls || '') + ' ' + ((c.card && c.card.cls) || '')).toLowerCase() + ' ';
    const isProd = / product |type-product|product_type_/.test(cls);
    const hasImg = /<img/i.test(h) || !!(c.card && c.card.image && c.card.image.src);
    return isProd && hasImg;
  };

  // A RATING / social-proof cluster → the native `star-rating` shortcode ("4.9/5" + count text +
  // AggregateRating schema), with the overlapping face stack as an `avatar` GROUP — laid out in a row,
  // like the source — instead of a verbatim code_block. (Partial atts; the builder merges option defaults.)
  const ratingNode = (b) => ({ type: 'simple', shortcode: 'star_rating', _items: [], atts: {
    rating: parseFloat(b.value) || 5, max: String(b.max || '5'), show_value: 'yes',
    count_text: String(b.count || ''), rating_schema: 'yes', align: 'left', unique_id: uid(),
  } });
  const avatarGroupNode = (b) => ({ type: 'simple', shortcode: 'avatar', _items: [], atts: {
    mode_settings: { mode: 'group', group: {
      people: (b.avatars || []).slice(0, 8).map((url, i) => ({ image: { attachment_id: '', url: localize(url) }, name: 'Happy customer ' + (i + 1), initials: '', link: '', status: '' })),
      max_visible: String(Math.max(4, (b.avatars || []).length)), extra_count: String(b.extraCount || ''), overlap: 35, stack_order: 'first-on-top',
    } },
    design: 'bordered', shape: 'circle', size: 40, unique_id: uid(),
  } });
  const ratingRowNode = (b) => {
    const items = [];
    if ((b.avatars || []).length) items.push(avatarGroupNode(b));
    // The STARS + "4.9/5 from 500+ …" text → a verbatim code_block (the source's own star glyphs + exact
    // wording), which is more faithful than re-drawing stars via the star-rating shortcode. The avatars
    // above are the editable `avatar` group. (`ratingNode`/star_rating stays available for callers that
    // prefer the native shortcode.)
    if (b.html && String(b.html).trim()) items.push(codeBlock(b.html));
    else items.push(ratingNode(b));
    const c = column('1_1', items);
    if (c.atts) { c.atts.content_direction = 'row'; c.atts.content_gap = { base: '3', md: '', lg: '' }; c.atts.content_h = 'start'; c.atts.content_v = 'center'; }
    return c;
  };
  // A DECORATIVE full-bleed backdrop (an `absolute inset-0` bg / gradient / dot-pattern / blob layer).
  // Wrapped so it (a) sits BEHIND the content — `z-index:-10`, mirroring the source's `-z-10` / content
  // `relative z-10` layering; without it the POSITIONED backdrop paints OVER the non-positioned
  // heading/text/button and hides them (the green CTA band went blank). (b) Clips its oversized blobs
  // (`overflow:hidden`) so they can't cause a horizontal scrollbar. (c) Ignores pointer events. Its
  // section is given `position:relative; isolation:isolate` (below) so `inset:0` anchors to it and the
  // negative z-index stays within the section instead of sliding behind the page.
  // Parse a CSS linear-gradient into the background-pro `gradient.data` shape. Tailwind emits
  // `linear-gradient(to bottom, <color> <pos>, …)` or an `NNdeg` angle, which is the subset handled
  // here; anything else returns null and the caller keeps it as a scoped background-image rule.
  const GRAD_DIR = { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270,
                     'to top right': 45, 'to bottom right': 135, 'to bottom left': 225, 'to top left': 315 };
  const gradientToStops = (img) => {
    const m = String(img || '').match(/^linear-gradient\(([\s\S]+)\)$/i);
    if (!m) return null;
    const parts = []; let depth = 0, buf = '';
    for (const ch of m[1]) {                       // split on TOP-LEVEL commas only (rgba(…) is safe)
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(buf.trim()); buf = ''; continue; }
      buf += ch;
    }
    if (buf.trim()) parts.push(buf.trim());
    if (parts.length < 2) return null;
    let angle = 180;
    if (/^(to\s|[-0-9.]+deg)/i.test(parts[0])) {
      const head = parts.shift().trim().toLowerCase();
      if (head.endsWith('deg')) angle = Math.round(parseFloat(head)) || 0;
      else if (GRAD_DIR[head] != null) angle = GRAD_DIR[head];
      else return null;
    }
    const stops = [];
    parts.forEach((p, i) => {
      const cm = p.match(/^((?:rgba?\([^)]*\)|#[0-9a-f]{3,8}|[a-z]+))\s*([0-9.]+%)?$/i);
      if (!cm) return;
      stops.push({ color: cm[1], position: cm[2] ? parseFloat(cm[2]) : Math.round((i / Math.max(1, parts.length - 1)) * 100) });
    });
    return stops.length >= 2 ? { type: 'linear', angle, stops } : null;
  };
  const decorTransparent = (c) => !c || /^transparent$/i.test(c) || /rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/i.test(c);

  // A DECORATIVE layer (a scrim, a gradient wash, a blur glow, a pattern overlay) is an empty
  // positioned box whose entire purpose is its background. Emitting it as a code_block made it the
  // single largest source of raw markup in a converted page — 300 of 359 unmapped `html` leaves
  // (83.6%) across a 120-site a second AI-page generator corpus — and left it uneditable. It is a Div with a background,
  // so emit exactly that, using the paint captured alongside the block (capture-extract stamps
  // `paint` because rawHtmlOf() carries no data-sc-cs for the engine to read).
  //
  // Falls back to the original verbatim code_block when there is no paint to reproduce, so the
  // "NOTHING DROPPED" invariant holds and the two call sites never see a null.
  const decorNode = (html, paint) => {
    const legacy = () => codeBlock('<div style="position:absolute;inset:0;z-index:-10;pointer-events:none;overflow:hidden">' + String(html || '') + '</div>');
    const p = paint;
    if (!p) return legacy();
    const grad    = p.bgImage ? gradientToStops(p.bgImage) : null;
    const hasFill = !decorTransparent(p.bg);
    if (!hasFill && !grad && !p.bgImage && !p.blur) return legacy();

    const node = stamp(clone('flexbox'));
    const atts = node.atts;
    const decorSize = [];      // width/height, filled by the placement block when the layer is edge-anchored
    atts.html_tag = 'div';
    atts.display  = 'block';
    if (hasFill && atts.background && atts.background.color && atts.background.color.value) {
      atts.background.color.value.custom = p.bg;
    }
    if (grad && atts.background && atts.background.gradient) { atts.background.gradient.data = grad; }

    // `element_position` is a MULTI-PICKER — { position, <position>:{ pos_offsets, pos_zindex } } —
    // not a bare string (see shortcode-get-option-helpers.php in the shortcodes extension).
    //
    // ⚠️ getComputedStyle RESOLVES an `auto` offset to a used pixel value, so all four sides always
    // read as numbers. Pinning all four over-constrains the box: it stretches to the measured rect,
    // its declared size (`w-32 h-32`) is discarded, and the offsets — measured against the 1440px
    // capture viewport — are wrong at every other width. Source `absolute top-32 -right-10 w-32 h-32`
    // came out as {top:128, right:-40, bottom:644, left:1352}. So anchor to the side the source
    // actually used (the nearer edge on each axis) and carry the box's own size instead.
    if (p.position === 'absolute' || p.position === 'fixed') {
      const AUTO = { value: '', unit: 'auto' };
      const px   = (n) => ({ value: String(Math.round(n)), unit: 'px' });
      const num  = (v) => { const n = parseFloat(v); return Number.isNaN(n) ? null : n; };
      const t = num(p.top), r = num(p.right), b = num(p.bottom), l = num(p.left);
      const off = { top: AUTO, right: AUTO, bottom: AUTO, left: AUTO };
      // A full-bleed `inset-0` layer genuinely declares all four; keep it stretched (no size).
      const insetAll = [t, r, b, l].every((v) => v === 0);
      if (insetAll) {
        off.top = px(0); off.right = px(0); off.bottom = px(0); off.left = px(0);
      } else {
        if (t != null && (b == null || Math.abs(t) <= Math.abs(b))) off.top = px(t); else if (b != null) off.bottom = px(b);
        if (r != null && (l == null || Math.abs(r) <= Math.abs(l))) off.right = px(r); else if (l != null) off.left = px(l);
        // Anchored on one edge per axis, the layer needs its own measured size to keep its shape.
        if (p.w) decorSize.push('width:' + p.w + 'px');
        if (p.h) decorSize.push('height:' + p.h + 'px');
      }
      atts.element_position = {
        position: p.position,
        [p.position]: { pos_offsets: off, pos_zindex: p.zIndex || '' },
      };
    }
    // Options added in shortcodes ext 1.14.69 (Styling → Box Style) precisely so a decorative layer
    // no longer needs raw CSS for its compositing.
    if (p.blend) { atts.blend_mode = p.blend; }
    if (p.blur)  { atts.backdrop_blur = { value: String(parseFloat(p.blur) || ''), unit: 'px' }; }

    // The residue with no option yet: radius (a round glow blob), opacity, an unparsed gradient, and
    // the explicit size a positioned blob needs. One short scoped rule — not a whole code block.
    const decl = decorSize.slice();
    if (p.radius)  decl.push('border-radius:' + p.radius);
    if (p.opacity) decl.push('opacity:' + p.opacity);
    if (p.bgImage && !grad) decl.push('background-image:' + p.bgImage);
    if (decl.length) atts.custom_css = 'selector{' + decl.join(';') + ';}';
    return node;
  };
  // Enable the source reveal animation on a node's Animations tab — ONLY for the standard
  // { enable, yes:{effect} } shape (heading/text/button/image/counter/testimonials/icon_box). A node
  // without that shape (the interactive widgets built inline) is left at its default, mirroring the PHP
  // apply_block_anim (whose interactive-widget multi-picker effect vocabulary is the animation-engine
  // registry, not animate.css). No `b.anim` → untouched (no false motion).
  const applyAnim = (node, b) => {
    if (node && b && b.anim && node.atts && node.atts.animation && typeof node.atts.animation === 'object' && 'enable' in node.atts.animation) {
      node.atts.animation = { ...node.atts.animation, enable: 'yes', yes: { ...(node.atts.animation.yes || {}), effect: b.anim } };
    }
    applyReveal(node, b && b.reveal);
    applyLoopAnim(node, b && b.loopAnim);
    return node;
  };
  // The element's own running class animation ({ css, kf }) → the node's Custom CSS (the shorthand on the node, its
  // @keyframes alongside). PHP: apply_loop_anim.
  const applyLoopAnim = (node, la) => {
    if (!node || !la || !la.css || !node.atts) return node;
    const css = 'selector{' + String(la.css).replace(/[;\s]+$/, '') + ';}' + (la.kf ? '\n' + String(la.kf).trim() : '');
    if (String(node.atts.custom_css || '').includes(css)) return node;
    node.atts.custom_css = ((node.atts.custom_css || '') + '\n' + css).trim();
    return node;
  };
  // A measured CSS-class reveal (capture data-sc-reveal → b.reveal / c.reveal) → the Scroll Motion REVEAL on the node's
  // gsap_motion: the source's direction + exact distance + per-element delay (the stagger), the character by the rest
  // scale (a plain slide = Subtle, a scaled-in = Standard / Dramatic), the ease mapped to GSAP. PHP: gsap_reveal_value.
  const applyReveal = (node, rv) => {
    if (!node || !rv || !node.atts || node.type === 'section') return node; // every shortcode carries the Scroll Motion stack (the JS atom templates omit the default)
    if (node.atts.gsap_motion && node.atts.gsap_motion.effect && node.atts.gsap_motion.effect !== 'none' && node.atts.gsap_motion.effect !== '') return node;
    const dir = /^(up|down|left|right|none)$/.test(rv.dir) ? rv.dir : 'up';
    const style = rv.scale < 0.95 ? 'dramatic' : (rv.scale < 1 ? 'standard' : 'subtle');
    const ease = gsapEaseOf(rv.ease);
    const reveal = { direction: dir, style, distance: Math.max(0, Math.round(rv.distance || 0)), delay: Math.round((rv.delay || 0) * 100) / 100, start: 'top 85%', once: 'yes', run_on_mobile: 'yes' };
    if (ease) reveal.advanced = { mode: 'custom', custom: { ease, ease_custom: '', scrub_smooth: 0, markers: 'no' } };
    node.atts.gsap_motion = { effect: 'reveal', reveal };
    return node;
  };
  // A CSS timing function → the nearest GSAP ease (the Scroll Motion Advanced ease vocabulary); '' keeps the Style preset's.
  const gsapEaseOf = (v) => {
    v = String(v || '').trim();
    if (!v || v === 'ease') return 'power1.out';
    if (v === 'linear') return 'none';
    if (v === 'ease-out') return 'power2.out';
    if (v === 'ease-in') return 'power2.in';
    if (v === 'ease-in-out') return 'power2.inOut';
    const m = /cubic-bezier\(\s*([0-9.]+)\s*,\s*(-?[0-9.]+)\s*,\s*([0-9.]+)\s*,\s*(-?[0-9.]+)\s*\)/.exec(v);
    if (!m) return '';
    const [x1, y1, x2, y2] = [+m[1], +m[2], +m[3], +m[4]];
    if (y2 > 1.05) return 'back.out(1.7)';
    if (x1 <= 0.25 && y1 >= 0.9 && x2 <= 0.4) return 'expo.out';
    if (x1 <= 0.3 && y1 >= 0.6) return 'power3.out';
    if (x1 >= 0.4 && x2 <= 0.3 && y1 <= 0.1) return 'power2.inOut';
    if (x1 >= 0.4 && y1 <= 0.1) return 'power2.in';
    return 'power2.out';
  };
  // A CHIP ROW (capture-extract chipRowOf): a wrapping flex row carrying the source gap + alignment + vertical
  // margin, whose cells are the chips themselves — each a Text Block through textBlock(), so the boxed-text rule
  // stashes its Box Preset skin (_box → box_style) and the text presets its typography. The chips size to
  // their content (a flex item's default), never to equal-width cells. PHP twin: the 'chips' builder.
  const chipsNode = (b) => {
    const nodes = (b.items || []).map((it) => textBlock(it.html, it)).filter(Boolean);
    if (!nodes.length) return null;
    const over = { display: 'flex', direction: { base: 'row', md: '', lg: '' }, wrap: { base: 'yes', md: '', lg: '' }, align_items: { base: 'center', md: '', lg: '' } };
    const gs = gapSlug(b.gap || '');
    if (gs) over.gap = { base: gs, md: '', lg: '' };
    if (b.align) over.justify_content = { base: b.align, md: '', lg: '' };
    const row = nFlexbox(nodes, over);
    if (b.keepRowSm && row && row.atts) row.atts.responsive_collapse = 'no'; // the source keeps the chips on one row at 390px (PHP: keepRowSm)
    if (row && row.atts && row.atts.spacing && row.atts.spacing.margin) {
      if (b.mt > 0) row.atts.spacing.margin.top = spacingToken('mt', b.mt);
      if (b.mb > 0) row.atts.spacing.margin.bottom = spacingToken('mb', b.mb);
    }
    return row;
  };
  // A ROW block → its builder items (the flexed row, or bare columns). Lifted out of the section loop so a row
  // nested in a STACK (a band card inside a single-track grid) is built by the SAME cell logic. PHP twin: the
  // nested-row path of build_cell_items + the section-level column loop.
  // A HORIZONTAL SCROLL STRIP: the row never wraps, every cell keeps the source's item width (flex-basis max(78%, 980px)), the
  // strip scrolls on x with snap points and a hidden scrollbar. Native first (wrap:no, content-sized cells), the rest scoped.
  const applyScrollStrip = (row, scroll) => {
    const item = String(scroll.item || '').trim(); if (!item || !/^[a-z0-9()%.,\s+*\/-]+$/i.test(item)) return row;
    row.atts.wrap = { base: 'no', md: '', lg: '' };
    const css = 'selector{overflow-x:auto;overflow-y:hidden;scrollbar-width:none;-ms-overflow-style:none;' + (scroll.snap ? 'scroll-snap-type:x mandatory;' : '') + (scroll.padB > 0 ? 'padding-bottom:' + scroll.padB + 'px;' : '') + '}selector::-webkit-scrollbar{display:none;}'
      + 'selector>*{flex:0 0 ' + item + ';width:' + item + ';max-width:none;' + (scroll.snap ? 'scroll-snap-align:start;' : '') + '}';
    for (const ci of (row._items || [])) { if (ci.atts) { ci.atts.width = { base: { preset: 'none' }, md: { preset: 'none' }, lg: { preset: 'none' } }; delete ci.atts.flex_grow; } }
    row.atts.custom_css = [row.atts.custom_css || '', css].filter(Boolean).join('\n');
    return row;
  };
  const rowBlockToItems = (b, sIndex) => {
    const out = [];
    const rowCols = [];
    for (const c of b.cols) {
      // Map each grid cell to a dedicated, editable shortcode using the role the extractor
      // already detected (parity with the PHP mapper). A cell with plain text (but no media /
      // structure) → editable text_block rather than an opaque code_block; a truly EMPTY /
      // decorative cell is DROPPED (no column emitted). Only a media/structural blob stays verbatim.
      const cInner = String(c.html || '');
      const cPlain = cInner.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      const cMedia = /<(img|svg|video|iframe|picture|canvas|input|button|select|textarea)\b/i.test(cInner);
      if (!c.counter && !c.card && !(c.buttons && c.buttons.length) && !c.text && !c.grid && !cPlain && !cMedia && !c.paint && !c.image && !(c.blocks && c.blocks.length)) { continue; } // drop empty / decorative cell (a PAINTED panel / a CSS-painted photo stays)
      let detected, cellItems, why;
      if (c.counter) {
        detected = 'counter'; why = 'counter → counter shortcode';
        cellItems = [counterNode(c.counter)];
        const lbl = String(c.counter.label || '').trim();
        if (lbl) { const ln = textBlock('<p>' + esc(lbl) + '</p>', c.counter.labelStyle || undefined); if (c.counter.labelFirst) cellItems.unshift(ln); else cellItems.push(ln); } // the caption keeps its side of the number (PHP: counter_label_node / labelFirst)
      } else if (c.card) {
        detected = 'card'; why = 'card → icon_box'; cellItems = [iconBoxNode(c.card)];
      } else if (c.buttons && c.buttons.length) {
        detected = 'buttons'; why = 'button group → button(s)';
        cellItems = c.buttons.map((bt) => buttonBlockNode(bt));
      } else if (c.text) {
        const tx = c.text;
        // A text cell WITH an overline / subtitle → a native special_heading (preserving the overline PILL
        // + its ICON), not a flat text_block that would drop the eyebrow. Plain single-heading cells still
        // fall to a text block. Mirrors the decomposed-heading path so the overline icon isn't lost.
        if (tx && typeof tx === 'object' && (String(tx.overline || '').trim() || String(tx.subtitle || '').trim())) {
          const lvl = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 }[String(tx.titleTag || 'h2')] || 2;
          const hb = {
            t: 'heading', html: tx.title || '', level: lvl, cls: tx.titleClass || '',
            overline: tx.overline || '', overlineCls: tx.overlineClass || '',
            overlinePill: /rounded-full|inline-flex|inline-block|pill/i.test(tx.overlineClass || ''),
            overlineIcon: tx.overlineIcon || '', overlineIconPos: tx.overlineIconPos || 'before',
            subtitle: tx.subtitle || '', subtitleCls: tx.subtitleClass || '', wrapCls: tx.wrapClass || '',
            longTail: tx.titleLongTail || '', subtitleLongTail: tx.subtitleLongTail || '', // the text long tail (capture-extract textLongTailOf)
            subtitleStyle: tx.subtitleStyle || null, subtitleLinkSkin: tx.subtitleLinkSkin || '', // the subtitle's own colour / size + its inline link
          };
          detected = 'text'; why = 'text cell (overline/subtitle) → special_heading';
          cellItems = [headingNode(hb)];
          // EMPTY PAINTED BOXES beside the text (capture-extract decorBoxesOf) → a raw box per layer, its paint inline (a code
          // block prints verbatim, so a data: pattern URL survives). PHP: bodyDecor (a class hook + scoped CSS on the icon_box).
          for (const bd of (Array.isArray(tx.decorBoxes) ? tx.decorBoxes : [])) { if (bd && bd.css && !/<\/style/i.test(String(bd.css))) cellItems.push(codeBlock('<div class="sc-deco-' + (bd.n | 0) + '" style="display:block;width:100%;' + String(bd.css).replace(/"/g, "'") + '"></div>')); }
          for (const p of (tx.paras || [])) { const pn = textBlock(p); if (pn) cellItems.push(pn); }
        } else {
          detected = 'text'; why = 'text cell → text_block'; cellItems = [textBlock(c.html)];
        }
      } else if (c.blocks && c.blocks.length) {
        detected = 'blocks'; why = 'content column → decomposed shortcodes';
        // A nested ROW among the blocks builds through rowBlockToItems (a strip card that is itself a grid); the rest as one group.
        cellItems = []; { let run = []; const flush = () => { if (run.length) { for (const n of flexifyItems(blocksToNodes(run))) cellItems.push(n); run = []; } };
          for (const it of c.blocks) { if (it && it.t === 'row') { flush(); for (const n of flexifyItems(rowBlockToItems(it, -1))) cellItems.push(n); } else run.push(it); } flush(); }
      } else if (c.paint) {
        // A PAINTED EMPTY PANEL (the gradient 'visual' half of a band card) → an empty cell carrying the paint.
        detected = 'panel'; why = 'painted empty panel → empty cell with the source background'; cellItems = [];
      } else if (c.image) {
        detected = 'image'; why = 'image cell → media_image'; cellItems = [mediaImageNode(c.image)];
      } else if (c.imgComposite && c.imgComposite.image) {
        // Image + content overlay → DECOMPOSE into native, editable elements (P0 fidelity fix):
        // a media_image (organic radius / white border / shadow + the blob backdrop, all via scoped
        // Custom CSS) + one icon_box per floating badge (icon + title + subtitle, positioned via
        // scoped CSS). Parity with the PHP Stitch image_composite_decompose path.
        detected = 'image-composite';
        why = 'image + content overlay → native media_image + icon_box (decomposed, editable)';
        const comp = c.imgComposite;
        cellItems = [mediaImageNode({ ...comp.image, blob: comp.blob || null })];
        for (const fc of (comp.cards || [])) cellItems.push(floatingCardNode(fc));
      } else if (c.imgComposite) {
        // Un-decomposable composite (imgCompositeOf → null): keep VERBATIM, WRAPPED in a positioned
        // container that carries the source cell's own classes (`relative lg:h-[600px] flex …`) + an
        // inline `position:relative` so the absolute overlays keep their anchor inside the code_block.
        detected = 'image-composite';
        why = 'image + content overlay → verbatim in a positioned wrapper (overlays anchor to the image)';
        cellItems = [codeBlock('<div class="' + esc(c.fullCls || c.cls || '') + '" style="position:relative;width:100%">' + cInner + '</div>')];
      } else if (c.grid) {
        detected = 'grid'; why = 'nested grid → code_block (not yet split into nested columns)'; cellItems = [codeBlock(c.html)];
      } else if (cPlain && !cMedia) {
        detected = 'text'; why = 'unrecognized text cell → text_block'; cellItems = [textBlock(cInner)];
      } else {
        detected = 'html'; why = 'unrecognized cell → code_block'; cellItems = [codeBlock(c.html)];
      }
      const sc = (cellItems[0] && cellItems[0].shortcode) || (cellItems.length ? 'simple' : 'panel'); // a painted panel has no items
      rec({ kind: 'element', sIndex, role: 'row-cell', detected, shortcode: sc, why, width: c.width,
            sourceClass: c.cls || '', text: snip(c.html), textFull: snipFull(c.html), html: rawCap(c.html),
            fallback: sc === 'code_block', opportunity: false });
      // a bento cell carries its MEASURED span (cw) in place of a slug (capture-extract bentoRowsOf; PHP: wResp desktop)
      if (!c.width && c.cw > 0) { const W12B = { 12: '1_1', 9: '3_4', 8: '2_3', 6: '1_2', 4: '1_3', 3: '1_4', 2: '1_6' }; c.width = W12B[c.cw] || c.width; }
      const col = column(c.width, cellItems);
      // A DECOMPOSED card cell (icon_box + feature_list) → the box goes on the COLUMN's Border Preset so
      // it wraps ALL the shortcodes (not just the icon_box header). Stash the skin for the Box-Preset
      // census, which assigns border_preset to a column (box_style to an icon_box). Parity with PHP.
      if (c.cardBox && col.atts) col.atts._box = c.cardBox;
      // The cell's own placement (capture-extract rowCols): order → native Order; align-self → native Align Self;
      // min-width / sticky → scoped CSS. PHP twin: carry_cell_geometry.
      if (col.atts) {
        if (Number.isInteger(c.order) && c.order !== 0) col.atts.order = { base: String(c.order), md: '', lg: '' };
        if (c.alignSelf && ['start', 'center', 'end', 'stretch', 'baseline'].includes(c.alignSelf)) col.atts.align_self = { base: c.alignSelf, md: '', lg: '' };
        if (c.cellCss && /^[a-z0-9()%.,:;\s#\/-]+$/i.test(String(c.cellCss))) col.atts.custom_css = (col.atts.custom_css ? col.atts.custom_css + '\n' : '') + 'selector{' + c.cellCss + ';}';
        // a FIXED SMALL BOX cell (capture-extract fixedBox): the inner wrapper takes the disc's size and centres the glyph (PHP: carry_cell_geometry fixedBox)
        if (c.fixedBox && c.fixedBox.w > 0 && c.fixedBox.h > 0) { col.atts.inner_class = (String(col.atts.inner_class || '') + ' sc-fixbox').trim(); col.atts.custom_css = (col.atts.custom_css ? col.atts.custom_css + '\n' : '') + 'selector .sc-fixbox{width:' + c.fixedBox.w + 'px;height:' + c.fixedBox.h + 'px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;padding:0;box-sizing:border-box;}selector .sc-fixbox p{margin:0;}'; }
        if (c.nowrapText) col.atts.custom_css = (col.atts.custom_css ? col.atts.custom_css + '\n' : '') + 'selector{white-space:nowrap;}'; // a one-line pill leaf (PHP: nowrapText)
        if (col.atts.spacing && col.atts.spacing.margin) { if (c.mt > 0 && !col.atts.spacing.margin.top) col.atts.spacing.margin.top = spacingToken('mt', c.mt); if (c.mb > 0 && !col.atts.spacing.margin.bottom) col.atts.spacing.margin.bottom = spacingToken('mb', c.mb); } // the cell's own vertical margin (PHP: carry_cell_geometry mt / mb)
        if (c.hideSm) col.atts.responsive_hide = { 'hide-xs': true, 'hide-sm': true }; // PHONE PASS: a cell hidden on phones (PHP: hide_sm)
        if (c.reveal) applyReveal(col, c.reveal); // the cell's own CSS-class reveal (a staggered card) → the column's Scroll Motion
        if (c.loopAnim) applyLoopAnim(col, c.loopAnim); // the cell's own running animation
        if (c.hide && typeof c.hide === 'object') { const rh = {}; for (const k of Object.keys(c.hide)) if (c.hide[k]) rh[k] = true; col.atts.responsive_hide = rh; } // …and per tier (md:hidden / lg:hidden)
        // TABLET / PHONE PASS: the grid's MEASURED track count at 820px / 390px → the cell's base / md / lg device widths, so
        // tablets get the source's two-up instead of the desktop split (PHP: the tracksMd / tracksSm col_resp).
        if ((b.tracksMd >= 1 || b.tracksSm >= 1) && /^\d+_\d+$/.test(String(c.width || ''))) {
          const span = slugToSpan(c.width), fr = (n) => Math.max(1, Math.min(12, Math.round(12 / n)));
          col.atts.w_phone = String(b.tracksSm >= 1 ? fr(b.tracksSm) : span); col.atts.w_tablet = String(b.tracksMd >= 1 ? fr(b.tracksMd) : span); col.atts.w_desktop = String(span);
          if (c.fracMd > 0) col.atts.w_tablet = String(Math.max(1, Math.min(12, Math.round(c.fracMd * 12)))); // the cell's OWN measured fraction (a col-span cell) beats the equal split
          if (c.fracSm > 0) col.atts.w_phone = String(Math.max(1, Math.min(12, Math.round(c.fracSm * 12))));
        }
      }
      // PAINT: one linear layer → the cell's native Background gradient; a multi-layer stack → scoped background-image.
      if (c.paint && col.atts) {
        const layers = String(c.paint.bgi || '').trim();
        const gv = layers && !/,\s*(?:linear|radial|conic)-gradient/i.test(layers) && /^linear-gradient\(/i.test(layers) ? parseLinearGradient(layers) : null;
        if (gv) col.atts.bg_gradient = { data: gv };
        else if (layers && /^[a-z0-9()%.,\s#-]+$/i.test(layers)) { const cur = col.atts.custom_css ? String(col.atts.custom_css) : ''; col.atts.custom_css = (cur + (cur !== '' ? '\n' : '') + 'selector{background-image:' + layers + ';}').trim(); }
        else if (c.paint.bg) col.atts.bg_color = { predefined: '', custom: c.paint.bg };
      }
      // The ROW is a CARD (a band): its skin + min-height ride on every cell so the flexed row wears the Box Preset.
      if (b.rowBox && col.atts) { col.atts._row_box = b.rowBox; if (b.cols.some((x) => x && x.paint)) col.atts._row_box.clip = true; }
      if (b.minh > 0 && col.atts) col.atts._row_minh = b.minh;
      // A media-FILL cell (a framed photo tile): the column is a flex column so its image can grow to the
      // card height (the media_image's flex:1 does the filling). PHP twin: carry_cell_geometry `stretch`.
      if (c.image && c.image.fill && col.atts && !/^(middle|center|bottom|end)$/.test(String(col.atts.content_v || ''))) col.atts.content_v = 'top'; // the atom default is the string 'default'
      // Fidelity fixes on the column's scoped custom_css:
      //  (1) an image-composite cell with FLOATING CARD(s) needs the column to be the POSITIONED
      //      ancestor, or each card's `position:absolute; top/left` resolves against the section/page
      //      and lands at the page top-left (overlapping the logo). Marking the column position:relative
      //      anchors the card to the image area.
      //  (2) the source cell's own max-width (`max-w-2xl` on a hero text column) constrains the
      //      column content so its paragraph wraps like the source (a full 50% track wraps too few lines).
      // Parity with the PHP mapper.
      {
        const decl = [];
        const hasFloating = detected === 'image-composite' && c.imgComposite && c.imgComposite.image
          && Array.isArray(c.imgComposite.cards) && c.imgComposite.cards.length;
        if (hasFloating) decl.push('position:relative');
        if (c.maxw && /^[0-9.]+(?:px|rem|em|%|ch|vw)$/.test(String(c.maxw))) decl.push('max-width:' + c.maxw);
        // A centered stat cell → centre the column so BOTH the counter number and its separate label
        // caption centre (the counter's own alignment only moves the number). Parity with PHP.
        if (c.counter && (c.counter.align === 'center' || c.counter.align === 'right')) decl.push('text-align:' + c.counter.align);
        if (decl.length && col.atts) {
          const cur = col.atts.custom_css ? String(col.atts.custom_css) : '';
          col.atts.custom_css = (cur + (cur !== '' ? '\n' : '') + 'selector{' + decl.join(';') + ';}').trim();
        }
      }
      // Replay the cell's OWN flex layout via the column's NATIVE options (content_direction / gap)
      // instead of a CSS wrapper — a flex-ROW cell lays its children side-by-side with the source gap.
      if (c.stackGap > 0 && col.atts) { const sgs = gapSlug(c.stackGap + 'px'); if (sgs) col.atts.content_gap = { base: sgs, md: '', lg: '' }; } // the cell is a stack: its gap → native Gap (PHP: stack_gap)
      const fx = c.flex;
      if (fx && /^row/.test(fx.dir || '') && col.atts) {
        col.atts.content_direction = 'row';
        const g = gapSlug(fx.gap);
        if (g) col.atts.content_gap = { base: g, md: '', lg: '' };
        if (/^row-reverse/.test(fx.dir)) col.atts.content_order = 'reverse';
      }
      // Cell GEOMETRY (PHP Mapper::carry_cell_geometry): a flex-COLUMN cell that centres its content
      // vertically → content_v = middle; a fixed min-height card → min_height_px; the exact grid track →
      // track_px (flexifyItems renders unequal tracks as a native Grid with the ratio).
      // A DECORATIVE pseudo-layer (a blurred corner glow) → a scoped `selector::before` on the column, under the
      // content but over the card's fill (z-index:-1 inside an isolated stacking context). PHP: decor_pseudo_css.
      if (c.decorPseudo && col.atts) {
        // A glow that reaches OUTSIDE the box (a negative offset, or offset + size past 100%) is clipped by the source card.
        const dp = c.decorPseudo; const reaches = ['top','left','right','bottom'].some((k) => dp[k] != null && parseFloat(dp[k]) < 0) || (parseFloat(dp.left != null ? dp.left : dp.right) || 0) + (parseFloat(dp.width) || 0) > 100 || (parseFloat(dp.top != null ? dp.top : dp.bottom) || 0) + (parseFloat(dp.height) || 0) > 100;
        if (reaches && col.atts._box) col.atts._box.clip = true;
        const rule = decorPseudoCss(c.decorPseudo);
        if (rule) { const cur = col.atts.custom_css ? String(col.atts.custom_css) : ''; col.atts.custom_css = (cur + (cur !== '' ? '\n' : '') + rule).trim(); }
      }
      if (col.atts) {
        if (fx && /^column/.test(fx.dir || '') && /center/.test(fx.justify || '')) col.atts.content_v = 'middle';
        else if (fx && /^column/.test(fx.dir || '') && /space-between/.test(fx.justify || '')) col.atts.content_v = 'between'; // a copy cell that spreads its content (PHP vjustify)
        else if (fx && /^column/.test(fx.dir || '') && /space-around/.test(fx.justify || '')) col.atts.content_v = 'around';
        else if (fx && /^column/.test(fx.dir || '') && /(flex-)?end/.test(fx.justify || '')) col.atts.content_v = 'bottom';
        if (c.minH > 0) { col.atts.min_height_px = c.minH; if (c.minHSm !== undefined) col.atts.min_height_sm_px = c.minHSm; if (c.minHMd !== undefined) col.atts.min_height_md_px = c.minHMd; }
        if (c.track > 0) col.atts.track_px = c.track;
      }
      // A grid CELL that centers/right-aligns its own text (source `text-center` / `text-right`
      // on the cell wrapper) → the column's native `text_align`, so the cell's mixed content
      // (heading + prose + buttons) inherits that alignment as one. Parity with the PHP mapper.
      {
        const cellTa = clsTextAlign(c.fullCls || c.cls || '');
        if (cellTa && col.atts) col.atts.text_align = cellTa;
      }
      // A CTA button group with 2+ buttons sits side-by-side — via the native content_direction
      // (not the old `.btn-row` CSS wrapper), even when the source cell's flex wasn't captured.
      if (detected === 'buttons' && cellItems.length > 1 && col.atts) {
        col.atts.content_direction = 'row';
        if (!(col.atts.content_gap && col.atts.content_gap.base)) {
          col.atts.content_gap = { base: gapSlug((c.flex && c.flex.gap) || '') || '3', md: '', lg: '' };
        }
        col.atts.content_h = 'center';
        // Size buttons to content so a flex-row + flex-wrap column doesn't wrap two full-width .btns to
        // stacked (parity with PHP group_buttons). Kept when the column has no other custom_css.
        if (!col.atts.custom_css) col.atts.custom_css = 'selector .btn{flex:0 0 auto !important;width:auto !important;}';
      }
      rowCols.push(col);
    }
    // HYBRID row emission (PHP twin of Mapper 7904-7918): a clean multi-cell row → ONE flex-Div
    // (flexbox, direction row) whose cells are child flex-Divs carrying their Width; otherwise
    // (single cell, or a cell needing the column inner-wrapper / positioned ancestor) emit the
    // columns unchanged. No fw-row for the flexed rows.
    if (rowFlexSafe(rowCols)) {
      const rowAtts = { display: 'flex', direction: { base: 'row', md: '', lg: '' }, wrap: { base: 'yes', md: '', lg: '' } };
      const rgap = gapSlug(b.gap || '');
      if (rgap) rowAtts.gap = { base: rgap, md: '', lg: '' };
      const rcells = rowCols.map(columnToFlexboxCell);
      // UNEQUAL source tracks → a native Grid with the exact track list (PHP twin: cells_track_list()).
      const tl = trackList(rcells);
      if (tl) { rowAtts.display = 'grid'; rowAtts.grid_columns = tl; for (const gc of rcells) delete gc.atts.width; }
      else if (cellsSpanLines(rcells)) { rowAtts.display = 'grid'; rowAtts.grid_columns = '12'; } // mixed spans tiling lines of 12 → a 12-track grid (PHP twin: cells_span_lines)
      const rb2 = rcells[0] && rcells[0].atts && rcells[0].atts._row_box;
      if (rb2) rowAtts._box = rb2;
      // The row's own layout: align-items → native Align Items; space-between / center / end → native Justify with
      // CONTENT-sized cells (no 12-span width). PHP twin: carry_row_skin → _row_lay in flexify_items.
      if (/^(start|center|end)$/.test(String(b.valign || ''))) rowAtts.align_items = { base: b.valign, md: '', lg: '' };
      { const jmap = { 'space-between': 'between', 'space-around': 'around', 'space-evenly': 'around', 'center': 'center', 'flex-end': 'end', 'end': 'end' };
        if (b.justify && jmap[b.justify]) { rowAtts.justify_content = { base: jmap[b.justify], md: '', lg: '' }; if (rowAtts.display !== 'grid') { rowAtts.custom_css = [rowAtts.custom_css || '', 'selector>*{flex:0 1 auto;min-width:0;}'].filter(Boolean).join('\n'); for (const jc of rcells) { jc.atts.width = { base: { preset: 'none' }, md: { preset: 'none' }, lg: { preset: 'none' } }; delete jc.atts.flex_grow;
          // a max-width-capped cell is size-frozen at its cap (the source's flex clamps it there); the rest shrink. PHP: freeze_capped_cell
          const jin = (jc._items && jc._items.length === 1 && jc._items[0].type === 'flexbox') ? jc._items[0] : null; // the cap may live on the sole inner wrapper (two-node cell)
          if (/max-width:/.test(String(jc.atts.custom_css || '')) || /sc-cw-/.test(String(jc.atts.inner_class || '')) || (jin && /max-width:/.test(String(jin.atts.custom_css || '')))) jc.atts.custom_css = [jc.atts.custom_css || '', 'selector{flex-shrink:0;}'].filter(Boolean).join('\n'); } } } }
      if (b.nowrap && rowAtts.display !== 'grid') rowAtts.wrap = { base: 'no', md: '', lg: '' }; // the source row does not wrap (PHP: nowrap)
      if (rcells[0] && rcells[0].atts && rcells[0].atts._row_minh > 0) rowAtts.min_height = { base: { value: String(rcells[0].atts._row_minh), unit: 'px' }, md: { value: '', unit: 'vh' }, lg: { value: '', unit: 'vh' } };
      for (const tc of rcells) { delete tc.atts.track_px; delete tc.atts._row_box; delete tc.atts._row_minh; }
      const rowfb = nFlexbox(rcells, rowAtts);
      applyTabletStack(rowfb, b); // TABLET PASS: a one-track grid at 820px stacks on tablets too (PHP: apply_tablet_stack)
      if (b.scroll && b.scroll.item) applyScrollStrip(rowfb, b.scroll); // a horizontal scroll strip (PHP: apply_scroll_strip)
      // …and its margins + own padding (a footer row's 64px above / 26px top inset).
      if (rowfb.atts && rowfb.atts.spacing && rowfb.atts.spacing.margin) { if (b.mt > 0) rowfb.atts.spacing.margin.top = spacingToken('mt', b.mt); if (b.mb > 0) rowfb.atts.spacing.margin.bottom = spacingToken('mb', b.mb); }
      if (b.pad && b.pad.base && rowfb.atts) { const pd = b.pad.base; rowfb.atts.custom_css = [rowfb.atts.custom_css || '', 'selector{padding-top:' + (pd.top || 0) + 'px;padding-right:' + (pd.right || 0) + 'px;padding-bottom:' + (pd.bottom || 0) + 'px;padding-left:' + (pd.left || 0) + 'px;}', padLgCss(b.pad)].filter(Boolean).join('\n'); }
      applyInsetX(rowfb, b); // the flattened shell wrapper's side inset (PHP: apply_inset_x on the band)
      out.push(rowfb);
    } else {
      for (const rc of rowCols) out.push(rc);
    }
    return out;
  };
  // A STACK WITH A GAP (capture-extract stackOf): a native flexbox COLUMN carrying the source gap + margin, whose
  // items are the children built ON THEIR OWN (a band row → its flexed row, a card → its icon_box), each flexified
  // separately so two consecutive band rows never merge. PHP twin: the 'stack' builder.
  // A SKINNED PANEL (capture panelOf): ONE flexbox column wearing the panel's Box Preset, its padding, the sheet's width /
  // max-width / aspect-ratio (scoped), centred by its parent when the source centres it, its content centred when the
  // source does, the decor pseudo-layers, and its blocks built + flexified inside. PHP twin: the 'panel' builder.
  const panelNode = (b) => {
    // The panel's blocks are ONE group (the eyebrow / title / intro coalesce across neighbours, as in a cell); a nested
    // row builds through rowBlockToItems on its own so its cells never merge with the prose.
    const nodes = []; let run = [];
    const flushRun = () => { if (run.length) { for (const n of flexifyItems(blocksToNodes(run))) nodes.push(n); run = []; } };
    for (const it of (b.blocks || [])) {
      if (it && it.t === 'row') { flushRun(); for (const n of flexifyItems(rowBlockToItems(it, -1))) nodes.push(n); }
      else run.push(it);
    }
    flushRun();
    if (!nodes.length) return null;
    const over = { display: 'flex', direction: { base: 'column', md: '', lg: '' }, wrap: { base: 'no', md: '', lg: '' } };
    if (b.centerH) over.align_items = { base: 'center', md: '', lg: '' };
    if (b.centerV) over.justify_content = { base: 'center', md: '', lg: '' };
    if (b.align === 'center') over.text_align = 'center';
    const col = nFlexbox(nodes, over);
    if (b.box) col.atts._box = b.box; // the census assigns the Box Preset (border_preset) from the skin
    const css = [];
    const pd = b.pad && b.pad.base; if (pd && (pd.top || pd.right || pd.bottom || pd.left)) { css.push('selector{padding-top:' + (pd.top || 0) + 'px;padding-right:' + (pd.right || 0) + 'px;padding-bottom:' + (pd.bottom || 0) + 'px;padding-left:' + (pd.left || 0) + 'px;}'); const lgc = padLgCss(b.pad); if (lgc) css.push(lgc); }
    const okv = (v) => v && /^[a-z0-9()%.,\s+*\/-]+$/i.test(String(v));
    let sz = '';
    if (okv(b.width)) sz += 'width:' + b.width + ';max-width:100%;';
    if (okv(b.maxw)) sz += 'max-width:' + b.maxw + ';';
    if (okv(b.aspect)) sz += 'aspect-ratio:' + b.aspect + ';';
    if (b.selfCenter) sz += 'margin-left:auto;margin-right:auto;';
    if (sz) css.push('selector{' + sz + '}');
    for (const d of (b.decor || [])) { const dc = d ? decorPseudoCss(d) : ''; if (dc) css.push(dc); }
    col.atts.custom_css = [col.atts.custom_css || '', ...css].filter(Boolean).join('\n');
    if (col.atts.spacing && col.atts.spacing.margin) {
      if (b.mt > 0) col.atts.spacing.margin.top = spacingToken('mt', b.mt);
      if (b.mb > 0) col.atts.spacing.margin.bottom = spacingToken('mb', b.mb);
    }
    return col;
  };
  const stackNode = (b) => {
    const nodes = [];
    // a HEADING GROUP the stack split apart (a flattened overline + h2 wrapper became two items): consecutive parts in
    // overline → heading → subtitle order (each once) build together so they fold into ONE special_heading (PHP parity)
    const rank = { overline: 0, heading: 1, title: 1, subtitle: 2 };
    const src = (b.items || []).filter(Boolean); let i = 0;
    while (i < src.length) {
      const it = src[i];
      if (it && it.t === 'row') { for (const n of flexifyItems(rowBlockToItems(it, -1))) nodes.push(n); i++; continue; }
      const run = [it]; let last = rank[it && it.t] ?? null; let j = i + 1;
      while (last != null && j < src.length) { const r = rank[src[j] && src[j].t] ?? null; if (r == null || r <= last) break; run.push(src[j]); last = r; j++; }
      for (const n of flexifyItems(blocksToNodes(run))) nodes.push(n);
      i = j;
    }
    if (!nodes.length) return null;
    const over = { display: 'flex', direction: { base: 'column', md: '', lg: '' }, wrap: { base: 'no', md: '', lg: '' } };
    const gs = gapSlug(b.gap || '');
    if (gs) over.gap = { base: gs, md: '', lg: '' };
    const col = nFlexbox(nodes, over);
    if (col && col.atts && col.atts.spacing && col.atts.spacing.margin) {
      if (b.mt > 0) col.atts.spacing.margin.top = spacingToken('mt', b.mt);
      if (b.mb > 0) col.atts.spacing.margin.bottom = spacingToken('mb', b.mb);
    }
    if (col && col.atts) {
      // a PADDED stack (a card body's `p-6` under a flush photo) keeps its inset; a `flex-grow justify-between` body fills the card
      // and pushes its meta row to the bottom; a photo FRAME (a badge card's image + pinned chip) is the chip's containing block at
      // the frame's height, the photo covering it. PHP: the stack builder pad / grow / rel.
      if (b.padPx && typeof b.padPx === 'object') { const pp = []; for (const sd of ['top', 'right', 'bottom', 'left']) { const v = b.padPx[sd] | 0; if (v > 0) pp.push('padding-' + sd + ':' + v + 'px'); } if (pp.length) col.atts.custom_css = (col.atts.custom_css ? col.atts.custom_css + '\n' : '') + 'selector{' + pp.join(';') + ';}'; }
      if (b.grow) col.atts.custom_css = (col.atts.custom_css ? col.atts.custom_css + '\n' : '') + 'selector{flex:1 1 auto;justify-content:space-between;}';
      if (b.rel) { const fh = b.frameH | 0; col.atts.custom_css = (col.atts.custom_css ? col.atts.custom_css + '\n' : '') + 'selector{position:relative;overflow:hidden;' + (fh > 0 ? 'height:' + fh + 'px;' : '') + '}' + (fh > 0 ? 'selector .image{height:100%;margin:0;}selector .image img{width:100%;height:100%;object-fit:cover;display:block;}' : ''); }
    }
    return col;
  };
  // A flattened band wrapper's horizontal inset (capture-extract mxAdd {l,r} px) → the node's native Spacing margin
  // (ms-*/me-* tokens; off-scale → ms-[24px], rendered by the dynamic-CSS arbitrary-spacing rule). A node without a
  // Spacing option gets the same as scoped CSS. PHP twin: Mapper::apply_inset_x.
  const applyInsetX = (node, b) => {
    if (!node || !b || !b.mxAdd || typeof b.mxAdd !== 'object') return node;
    const l = +b.mxAdd.l || 0, r = +b.mxAdd.r || 0;
    if (l <= 0 && r <= 0) return node;
    // A SELF-CENTRED block (a capped panel with auto side margins) ignores the inset — a side margin would override the
    // centring and shove it left; its measure already rides its own width / max-width. PHP: same guard.
    if (b.selfCenter || b.self_center || /margin-(?:left|right|inline)\s*:\s*auto/.test(String(node.atts && node.atts.custom_css || ''))) return node;
    // The MEASURED tiers (capture-extract insetXOf lSm/rSm/lMd/rMd): when the inset differs at 390 / 820 those tiers ride
    // max-width:767px / 768–991px rules (the base token paints the desktop value at every width). PHP: apply_inset_x.
    let tierCss = '';
    for (const [kl, kr, mq] of [['lSm', 'rSm', '@media (max-width:767px)'], ['lMd', 'rMd', '@media (min-width:768px) and (max-width:991px)']]) {
      if (b.mxAdd[kl] == null) continue; const tl = +b.mxAdd[kl] || 0, tr = +b.mxAdd[kr] || 0;
      if (Math.abs(tl - l) > 0.5 || Math.abs(tr - r) > 0.5) tierCss += mq + '{selector[class]{margin-left:' + Math.round(tl) + 'px !important;margin-right:' + Math.round(tr) + 'px !important;}}';
    }
    if (node.atts && node.atts.spacing && node.atts.spacing.margin) {
      if (l > 0 && !node.atts.spacing.margin.left) node.atts.spacing.margin.left = spacingToken('ms', l);
      if (r > 0 && !node.atts.spacing.margin.right) node.atts.spacing.margin.right = spacingToken('me', r);
      if (tierCss) node.atts.custom_css = ((node.atts.custom_css || '') + '\n' + tierCss).trim();
      return node;
    }
    if (node.atts) {
      const css = 'selector{' + (l > 0 ? 'margin-left:' + Math.round(l) + 'px;' : '') + (r > 0 ? 'margin-right:' + Math.round(r) + 'px;' : '') + '}' + tierCss;
      const cur = String(node.atts.custom_css || '').trim();
      node.atts.custom_css = (cur ? cur + '\n' : '') + css;
    }
    return node;
  };
  // PHONE PASS: a pad record whose lg tier differs from its (phone) base → a min-width:992px rule for desktop. PHP: apply_cell_pad tiers.
  const padLgCss = (pad) => {
    const lg = pad && pad.lg, b = pad && pad.base, md = pad && pad.md; if (!b) return '';
    const same = (x, y) => ['top', 'right', 'bottom', 'left'].every((k) => (x[k] || 0) === (y[k] || 0));
    const decl = (t) => 'selector{padding-top:' + (t.top || 0) + 'px;padding-right:' + (t.right || 0) + 'px;padding-bottom:' + (t.bottom || 0) + 'px;padding-left:' + (t.left || 0) + 'px;}';
    let css = '';
    if (md && !same(md, b)) css += '@media (min-width:768px){' + decl(md) + '}'; // the TABLET tier
    if (lg && !same(lg, md || b)) css += (css ? '\n' : '') + '@media (min-width:992px){' + decl(lg) + '}';
    return css;
  };
  // PHONE PASS (capture-extract hideSm): hidden below 768px in the source → the native Responsive Hide (mobile + tablet). PHP: apply_block_anim.
  const applyHideSm = (node, b) => { if (node && b && b.hideSm && node.atts && Object.prototype.hasOwnProperty.call(node.atts, 'responsive_hide')) node.atts.responsive_hide = { 'hide-xs': true, 'hide-sm': true }; return node; };
  // TABLET PASS (capture-extract tracksMd): ONE grid track at 820px → a 768–991px rule stacks the row. PHP: apply_tablet_stack.
  const applyTabletStack = (row, b) => {
    if (!row || !row.atts || !b) return row;
    const isGrid = row.atts.display === 'grid', tMd = b.tracksMd | 0, tSm = b.tracksSm | 0, rules = [];
    if (tMd === 1) rules.push('@media (min-width:768px) and (max-width:991px){selector{' + (isGrid ? 'grid-template-columns:1fr !important;' : 'flex-direction:column !important;flex-wrap:wrap !important;') + '}selector>*{width:100% !important;max-width:100% !important;}}');
    // N measured tracks at 820px (a md:grid-cols-2 two-up under a three-up desktop) → a 768–991px track rule (PHP: apply_tablet_stack).
    else if (tMd >= 2 && isGrid) rules.push('@media (min-width:768px) and (max-width:991px){selector{grid-template-columns:repeat(' + tMd + ',minmax(0,1fr)) !important;}}');
    // …and the PHONE track count when the source keeps >= 2 columns at 390px (the theme's grid collapses to one below 768).
    if (tSm >= 2 && isGrid) rules.push('@media (max-width:767px){selector{grid-template-columns:repeat(' + tSm + ',minmax(0,1fr)) !important;}}');
    if (!rules.length) return row;
    row.atts.custom_css = ((row.atts.custom_css || '') + '\n' + rules.join('\n')).trim();
    return row;
  };
  const blockToNode = (b) => applyHideSm(applyInsetX(applyAnim(_blockToNode(b), b), b), b);
  // An email-signup form → the native `newsletter` shortcode. Title/description stay blank (the section's
  // own heading renders them above); map the form's email/name placeholder, submit label, alignment,
  // roundness and the button's real colours. The view hard-codes white button text, so a non-white source
  // text colour is re-asserted via scoped Custom CSS. Parity with PHP n_newsletter.
  // Another icon set's id ('ph:envelope-simple', 'tabler:phone') → the nearest LUCIDE glyph by meaning. PHP: icon_semantic_lucide.
  const iconSemanticLucide = (id) => {
    const name = String(id || '').toLowerCase().replace(/^[a-z0-9-]+:/, '');
    const map = [[/envelope|mail|letter/, 'mail'], [/phone|call/, 'phone'], [/user|person|account|profile/, 'user'], [/search|magnif/, 'search'], [/lock|password/, 'lock'], [/send|paper-plane|plane/, 'send'], [/arrow-right|chevron-right|caret-right/, 'arrow-right'], [/arrow-left|chevron-left/, 'arrow-left'], [/check|tick/, 'check'], [/star/, 'star'], [/heart/, 'heart'], [/calendar|date/, 'calendar'], [/clock|time/, 'clock'], [/map-pin|location|pin/, 'map-pin'], [/globe|world/, 'globe'], [/home|house/, 'house'], [/gift/, 'gift'], [/bell|notif/, 'bell'], [/tag|label/, 'tag'], [/link/, 'link'], [/download/, 'download'], [/upload/, 'upload']];
    for (const [re, lu] of map) if (re.test(name)) return lu;
    return '';
  };
  const newsletterNode = (b) => {
    const _clean = (v) => String(v || '').trim();
    const atts = {
      title: '', description: '', show_name: b.show_name ? 'yes' : 'no',
      email_placeholder: (b.placeholder || '').trim() || 'Your email address',
      button_label: (b.button_label || '').trim() || 'Subscribe',
      design: 'inline', unique_id: uid(), custom_css: '',
    };
    if (b.show_name && (b.name_placeholder || '').trim()) atts.name_placeholder = b.name_placeholder.trim();
    if (/^(left|center|right)$/.test(String(b.align || ''))) atts.align = b.align;
    // The field's :focus skin (capture.mjs data-sc-focus) → the input's :focus (PHP: n_newsletter field_focus).
    { const ff = String(b.fieldFocus || '').trim(); if (ff && /^[a-z0-9()%.,:;\s#\/-]+$/i.test(ff)) atts.custom_css = (atts.custom_css ? atts.custom_css + '\n' : '') + 'selector .fw-nl__input:focus{' + ff + ' !important;}'; }
    if (/^(rounded-0|rounded|pill)$/.test(String(b.rounded || ''))) atts.rounded = b.rounded;
    const bg = b.button_bg ? rgbToCss(b.button_bg) : '';
    const fg = b.button_fg ? rgbToCss(b.button_fg) : '';
    const fbg = b.field_bg ? rgbToCss(b.field_bg) : '';
    if (bg) atts.accent_color = { predefined: '', custom: bg };
    if (fbg) atts.field_bg = { predefined: '', custom: fbg };
    if (fg && !/^#?(fff|ffffff)$/i.test(fg.replace('#', ''))) atts.custom_css = ('selector .fw-nl__btn{color:' + fg + ' !important;}');
    if (/^(inline|stacked|boxed|capsule)$/.test(String(b.design || ''))) atts.design = b.design;
    const capsule = atts.design === 'capsule';
    const css = [];
    // BUTTON PRESET — the submit resolves through the same matcher every CTA uses (button-match.mjs), so it wears the
    // site's own Button Preset via the native button_preset option instead of a one-off accent. PHP: n_newsletter.
    if (b.button) {
      const bp = _buttonPresetFor(b.button);
      if (bp.style && bp.style !== 'btn-link') { atts.button_preset = bp.style + (bp.size ? ' ' + bp.size : ''); delete atts.accent_color; atts.custom_css = ''; }
      // …and the submit's OWN type (the preset carries the site's button font; this one is 14px sentence-case).
      const bt = b.button; const bd = [];
      if (/^[0-9.]+px$/.test(_clean(bt.fontSize))) bd.push('font-size:' + _clean(bt.fontSize));
      bd.push('text-transform:' + (/^(uppercase|lowercase|capitalize)$/.test(_clean(bt.textTransform)) ? _clean(bt.textTransform) : 'none'));
      bd.push('letter-spacing:' + (/^-?[0-9.]+px$/.test(_clean(bt.letterSpacing)) ? _clean(bt.letterSpacing) : 'normal'));
      if (/^[0-9.]+px$/.test(_clean(bt.lineHeight))) bd.push('line-height:' + _clean(bt.lineHeight));
      if (/^[1-9]00$/.test(_clean(bt.fontWeight))) bd.push('font-weight:' + _clean(bt.fontWeight));
      if (/^[0-9.]+px$/.test(_clean(bt.height))) bd.push('height:' + _clean(bt.height), 'padding-top:0', 'padding-bottom:0', 'display:inline-flex', 'align-items:center', 'justify-content:center');
      css.push('selector .fw-nl__btn{' + bd.map((d) => d + ' !important').join(';') + ';}');
    }
    // FIELD SKIN — the wrapper that IS the field (a paper pill around icon + input) rides on the input.
    const fsk = b.fieldSkin;
    if (fsk) {
      const dec = [];
      const okc = (v) => v && /^[a-z0-9()%.,\s#-]+$/i.test(String(v));
      if (okc(fsk.bgi)) dec.push('background:' + fsk.bgi); else if (fsk.bg && !/rgba?\([^)]*,\s*0\s*\)|transparent/i.test(fsk.bg)) dec.push('background:' + fsk.bg);
      if (okc(fsk.border)) dec.push('border:' + fsk.border);
      if (okc(fsk.shadow)) dec.push('box-shadow:' + fsk.shadow);
      if (fsk.backdrop && /^[a-z0-9()%.,\s-]+$/i.test(fsk.backdrop)) dec.push('backdrop-filter:' + fsk.backdrop, '-webkit-backdrop-filter:' + fsk.backdrop);
      if (/^[0-9.]+px(\s+[0-9.]+px){0,3}$/.test(_clean(fsk.padding))) dec.push('padding:' + _clean(fsk.padding));
      if (/^[0-9.]+px$/.test(_clean(fsk.height))) dec.push('height:' + _clean(fsk.height), 'box-sizing:border-box');
      if (/^[0-9.]+px$/.test(_clean(fsk.fontSize))) dec.push('font-size:' + _clean(fsk.fontSize));
      if (/^rgba?\(/i.test(_clean(fsk.color))) dec.push('color:' + _clean(fsk.color));
      if (capsule) {
        // CAPSULE: the wrapper's skin IS the field ROW's pill; only the type stays on the input (PHP: n_newsletter capsule).
        const row = dec.filter((d) => !/^(font-size|color):/.test(d)), inp = dec.filter((d) => /^(font-size|color):/.test(d));
        if (row.length) css.push('selector .fw-nl__fields{' + row.join(';') + ';}');
        if (/^[0-9.]+px(\s+[0-9.]+px){0,3}$/.test(_clean(b.inputPadding))) inp.push('padding:' + _clean(b.inputPadding));
        if (inp.length) css.push('selector .fw-nl__input{' + inp.join(';') + ';}');
      } else if (dec.length) css.push('selector .fw-nl__input{' + dec.join(';') + ';}');
    }
    if (/^[0-9.]+px$/.test(_clean(b.wrapMaxWidth))) css.push('selector{max-width:' + _clean(b.wrapMaxWidth) + ';' + (b.align === 'center' ? 'margin-left:auto;margin-right:auto;' : '') + '}');
    // The field wrapper's OWN :hover (a glass pill that brightens under the pointer) → the element the rest skin rides (PHP parity).
    { const fh = _clean(b.fieldHover);
      if (fh && /^[a-z0-9()%.,:;\s#\/-]+$/i.test(fh)) {
        const hd = {}; for (const part of fh.split(';')) { const i = part.indexOf(':'); if (i > 0) hd[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
        const hdec = [];
        if (hd['background-color']) hdec.push('background:' + hd['background-color']);
        if (hd['border-color']) hdec.push('border-color:' + hd['border-color']); else if (hd['border-top-color']) hdec.push('border-color:' + hd['border-top-color']);
        if (hd['box-shadow'] && hd['box-shadow'] !== 'none') hdec.push('box-shadow:' + hd['box-shadow']);
        const tgt = capsule ? '.fw-nl__fields' : '.fw-nl__input';
        if (hdec.length) { css.push('selector ' + tgt + ':hover{' + hdec.join(';') + ';}'); css.push('selector ' + tgt + '{transition:background .3s,border-color .3s,box-shadow .3s;}'); }
      } }
    if (b.placeholderColor && /^(#[0-9a-f]{3,8}|rgba?\([^)]*\))$/i.test(String(b.placeholderColor))) css.push('selector .fw-nl__input::placeholder{color:' + b.placeholderColor + ';opacity:1;}');
    if (b.gap > 0) css.push('selector .fw-nl__fields{gap:' + b.gap + 'px;}');
    // FIELD ICON — the glyph inside the field → the native field_icon (an inline svg, a Lucide id, a font class, or a semantic
    // fallback for another icon set: envelope | mail → lucide mail) + its colour. PHP: icon_semantic_lucide.
    if (b.icon) {
      let val = null;
      if (b.icon.svg) val = { type: 'svg', 'svg-source': 'inline', markup: String(b.icon.svg), 'svg-id': '' };
      else if (b.icon.id) { const iid = String(b.icon.id).toLowerCase(); const lm = iid.match(/^lucide:([a-z0-9-]+)$/); const lu = lm ? lm[1] : iconSemanticLucide(iid); if (lu) val = { type: 'svg', 'svg-source': 'library', 'svg-id': 'lucide/' + lu, markup: '' }; }
      else if (b.icon.cls) val = { type: 'icon-font', 'icon-class': String(b.icon.cls), 'icon-class-without-root': false, 'pack-name': false, 'pack-css-uri': false };
      if (val) { atts.field_icon = val; if (/^rgba?\(/i.test(String(b.iconColor || ''))) atts.field_icon_color = { predefined: '', custom: rgbToCss(b.iconColor) }; }
    }
    if (css.length) atts.custom_css = [atts.custom_css || '', ...css].filter(Boolean).join('\n');
    return { type: 'simple', shortcode: 'newsletter', _items: [], atts };
  };
  // A flattened grouping wrapper's own vertical margin + padding (capture-extract mtAdd / mbAdd on the boundary blocks it
  // produced) → the node's Spacing when nothing more specific set it, else a scoped margin. PHP: the block rule carry.
  const carryWrapMargins = (n, b) => {
    if (!n || !b || (!(b.mtAdd > 0) && !(b.mbAdd > 0))) return n;
    if (!n.atts) return n;
    if (!n.atts.spacing || !n.atts.spacing.margin) n.atts.spacing = emptySpacing(); // a widget node gets its Spacing here (finalize keeps it)
    const sp = n.atts.spacing.margin;
    // an inner part's explicit ZERO (mb-0: "this element has no margin") is not the group's gap — the wrapper's mbAdd is
    if (b.mtAdd > 0 && (!sp.top || sp.top === 'mt-0')) sp.top = spacingToken('mt', b.mtAdd);
    if (b.mbAdd > 0 && (!sp.bottom || sp.bottom === 'mb-0')) sp.bottom = spacingToken('mb', b.mbAdd);
    return n;
  };
  const _blockToNode = (b) => carryWrapMargins(_blockToNode0(b), b);
  const _blockToNode0 = (b) => (b.t === 'panel' ? panelNode(b) : b.decor ? decorNode(b.html, b.paint) : b.t === 'newsletter' ? newsletterNode(b) : b.t === 'heading' ? headingNode(b) : b.t === 'button' ? buttonBlockNode(b) : b.t === 'overline' ? textBlock(b.html, { ...b, textAlign: b.align || b.textAlign, textTransform: b.textTransform }) : b.t === 'text' ? textBlock(b.html, b) : b.t === 'chips' ? chipsNode(b) : b.t === 'lone_icon' ? (loneIconNode(b) || codeBlock(b.svg || '')) : b.t === 'paint' ? (paintNode(b) || codeBlock('')) : b.t === 'stack' ? stackNode(b) : b.t === 'floating_card' ? floatingCardNode(b.card || {}) : b.t === 'gallery' ? (galleryNode(b) || codeBlock('')) : b.t === 'scroll_cue' ? scrollCueNode(b) : b.t === 'image' ? mediaImageNode(b) : b.t === 'video' ? videoNode(b) : b.t === 'testimonials' ? testimonialsNode(b.items) : b.t === 'rating' ? ratingRowNode(b) : b.t === 'table' ? tableNode(b) : b.t === 'accordion' ? accordionNode(b) : b.t === 'card' ? iconBoxNode(b.card) : b.t === 'feature_list' ? featureListNode(b) : b.t === 'tabs' ? tabsNode(b) : b.t === 'steps' ? stepsNode(b) : b.t === 'timeline' ? timelineNode(b) : b.t === 'progress' ? progressNode(b) : b.t === 'pricing' ? pricingNode(b) : b.t === 'lottie' ? lottieNode(b) : b.t === 'svg_draw' ? svgDrawNode(b) : b.t === 'logo_grid' ? logoGridNode(b) : b.t === 'cta' ? ctaNode(b) : codeBlock(b.html));

  // Map a flat blocks array to nodes, grouping a flex-ROW button group (`sm:flex-row`) into ONE nested
  // row column (side-by-side, source gap) instead of stacked siblings. This is the same grouping the
  // top-level section loop does, factored out so a CONTENT COLUMN's blocks (a grid cell's `c.blocks`,
  // where the hero's "Book a Stay / Take a Tour" pair lives) get it too — a plain `.map(blockToNode)`
  // there was emitting the CTAs stacked.
  const blocksToNodes = (blocks) => {
    const out = []; let row = [];
    for (const b of coalesceHeadingGroups(blocks)) {
      const node = blockToNode(b);
      if (b.t === 'button' && b.groupRow) {
        if (b.groupFirst) row = [];
        row.push(node);
        if (b.groupLast) {
          const rc = column('1_1', row);
          if (rc.atts) { rc.atts.content_direction = 'row'; rc.atts.content_gap = { base: '3', md: '', lg: '' }; rc.atts.content_h = 'start'; }
          out.push(rc); row = [];
        }
      } else {
        out.push(node);
      }
    }
    if (row.length) out.push(...row); // safety: an unterminated group (no groupLast) still emits its buttons
    return out;
  };

  // Fold a heading GROUP — an overline/eyebrow immediately BEFORE a heading + the paragraph right
  // AFTER it — into the single heading block, so it maps to ONE special_heading (overline + title +
  // subtitle) instead of three separate shortcodes. Parity with PHP Mapper::n_text_cell. A `row` or
  // any non-text block between them breaks the group (pushed through untouched). The subtitle is only
  // absorbed when we're clearly in a heading group (an overline was folded, or the heading carries a
  // heading-group wrapCls) — so unrelated body paragraphs are never eaten.
  // Is a text block a heading SUBTITLE (short intro line) vs body copy? Single short paragraph, no
  // block-level structure, under a two-sentence cap. Parity with PHP Mapper::is_heading_subtitle.
  const isHeadingSubtitle = (b) => {
    if (b && b.cls === 'sc-link-strip') return false;                        // a link strip is its own block
    // A paragraph that is ALSO a box (a glass callout: fill / border / shadow) is not a subtitle — a heading's subtitle
    // can't carry a box, so it stays its own text block wearing a Box Preset. Parity with PHP is_heading_subtitle.
    if (b && (b.bg || b.bgImage || b.border || b.boxShadow)) return false;
    const html = String((b && (b.html || b.text)) || '');
    if (/<(ul|ol|h[1-6]|table|blockquote|figure|hr|div)\b/i.test(html)) return false;
    if ((html.match(/<a\b/gi) || []).length >= 2) return false;             // a row of links, not intro prose
    if ((html.match(/<p\b/gi) || []).length > 1) return false;               // >1 paragraph = body copy
    const plain = html.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
    if (!plain) return false;
    return plain.length <= 220;                                              // a sentence or two
  };
  const coalesceHeadingGroups = (blocks) => {
    const out = [];
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.t !== 'heading') { out.push(b); continue; }
      const h = { ...b };
      const prev = out[out.length - 1];
      // A band header written as TWO headings — a small mono/tracked kicker over the real headline — is ONE heading:
      // the SIZE decides which is which (the tag order h2→h3 says nothing). PHP twin: transform_kicker_headings().
      const _px = (v) => { const m = String(v == null ? '' : v).match(/^([0-9.]+)px$/); return m ? parseFloat(m[1]) : 0; };
      const _kicker = (p, cur) => {
        if (!p || p.t !== 'heading') return false;
        const a = _px(p.fontSize), z = _px(cur.fontSize);
        if (!a || !z || a >= z) return false;
        const txt = String(p.text || '').trim();
        if (!txt || txt.length > 60) return false;
        const upper = /uppercase/i.test(String(p.textTransform || '')) || /\buppercase\b/.test(String(p.cls || ''));
        const track = parseFloat(String(p.letterSpacing || '0')) >= 1;
        const diff = !!(p.fontFamily && cur.fontFamily && String(p.fontFamily) !== String(cur.fontFamily));
        return a <= 0.6 * z || upper || track || diff;
      };
      if (_kicker(prev, b)) {
        h.overline = prev.text || '';
        h.overlineText = prev.text || '';
        h.overlineCls = prev.cls || '';
        h.overlineTransform = prev.textTransform || '';
        if (prev.color) h.overlineColor = prev.color;
        h.overlineFontSize = prev.fontSize || '';
        h.overlineFontWeight = prev.fontWeight || '';
        h.overlineLetterSpacing = (prev.letterSpacing && prev.letterSpacing !== 'normal') ? prev.letterSpacing : '';
        h.overlineLineHeight = prev.lineHeight || '';
        h.overlineMarginBottom = prev.marginBottom || '';
        out.pop();
      } else if (prev && (prev.t === 'overline' || (prev.t === 'text' && prev.text && prev.text.length <= 48 && prev.text === prev.text.toUpperCase()))) {
        h.overline = prev.html || prev.text || '';
        h.overlinePill = !!prev.pill || /rounded-full|pill/i.test(prev.cls || '');
        if (prev.color) h.overlineColor = prev.color; // the pill's text colour → native overline_color
        h.overlineTransform = prev.textTransform || '';   // css text-transform → overline_uppercase
        h.overlineText = prev.text || '';                 // plain text, for the all-caps heuristic
        if (prev.iconSvg) { h.overlineIcon = prev.iconSvg; h.overlineIconPos = prev.iconPos || 'before'; }
        h.overlineCls = prev.cls || '';                   // overline's own classes → native overline_class
        // NEVER-DROP: a PILL overline's frosted-glass skin (translucent fill + border + backdrop-blur + radius)
        // has no native option — carry the pill's computed skin → scoped `.heading-overline` CSS below.
        if (h.overlinePill) { h.overlineBg = prev.bg || ''; h.overlineBorderW = prev.borderW || ''; h.overlineBorderColor = prev.borderColor || ''; h.overlineRadius = prev.radius || ''; h.overlineBackdrop = prev.backdropFilter || ''; h.overlinePad = prev.padding || ''; h.overlineGap = prev.gap || ''; }
        h.overlineFontWeight = prev.fontWeight || ''; h.overlineColor2 = prev.color || ''; h.overlineFontSize = prev.fontSize || '';         // NEVER-DROP: no native overline size option → scoped CSS
        h.overlineLetterSpacing = (prev.letterSpacing && prev.letterSpacing !== 'normal') ? prev.letterSpacing : '';
        h.overlineLineHeight = prev.lineHeight || ''; // the kicker's line box (PHP parity)
        h.overlineMarginBottom = prev.marginBottom || ''; // its own gap below (adds to the title's margin-top)
        out.pop();
      }
      const next = blocks[i + 1];
      // A SHORT intro paragraph right after the title → the heading's subtitle (brevity-guarded so real body
      // copy stays a Text Block). Replaces the old overline/wrapCls-only gate, so a plain title+intro folds
      // too — the reason the subtitle used to be "almost never used". Parity with the PHP section loop.
      if (next && next.t === 'text' && isHeadingSubtitle(next)) {
        // Subtitle = the paragraph's INNER content (strip a single outer <p>), parity with textBlockOf.
        h.subtitle = String(next.html || '').replace(/^\s*<p[^>]*>([\s\S]*)<\/p>\s*$/i, '$1');
        h.subtitleCls = next.cls || '';                   // subtitle's own classes → native subtitle_class
        if (next.mbAdd > 0) h.mbAdd = Math.max(+h.mbAdd || 0, next.mbAdd); // the group wrapper's bottom margin landed on the LAST part (PHP: head mbAdd)
        h.subtitleStyle = { fontSize: next.fontSize || '', color: next.color || '', lineHeight: next.lineHeight || '', marginTop: next.marginTop || '', marginBottom: next.marginBottom || '', paddingBottom: next.paddingBottom || '', fontSizeSm: next.fontSizeSm || '', lineHeightSm: next.lineHeightSm || '' }; // + the phone-pass size (PHP: subtitle_fs_sm)
        i++;
      }
      out.push(h);
    }
    return out;
  };

  // --- Grid-cell → editable shortcode builders (parity with the PHP mapper's n_icon_box /
  //     n_counter). The JS path previously code_blocked every cell even though the extractor
  //     already detected cards / counters; this restores the dedicated, editable shortcodes.
  //     Nodes are cloned from the live default-att atoms (icon_box / counter) then overlaid, so
  //     they carry the EXACT shape the builder stores (no missing nested atts).
  // fa_icon: normalize a source icon class to a renderable Font Awesome class (FA is bundled).
  const FA_MAP = {
    'ti-light-bulb': 'lightbulb-o', 'ti-idea': 'lightbulb-o', 'ti-panel': 'th-list', 'ti-layout': 'th-large',
    'ti-headphone-alt': 'headphones', 'ti-headphone': 'headphones', 'ti-bar-chart': 'bar-chart', 'ti-stats-up': 'line-chart',
    'ti-mobile': 'mobile', 'ti-tablet': 'tablet', 'ti-desktop': 'desktop', 'ti-settings': 'cog', 'ti-cog': 'cog',
    'ti-pencil': 'pencil', 'ti-pencil-alt': 'pencil', 'ti-heart': 'heart', 'ti-star': 'star', 'ti-shield': 'shield',
    'ti-rocket': 'rocket', 'ti-cloud': 'cloud', 'ti-camera': 'camera', 'ti-email': 'envelope', 'ti-user': 'user',
    'ti-search': 'search', 'ti-lock': 'lock', 'ti-world': 'globe', 'ti-check': 'check', 'ti-time': 'clock-o',
    'ti-comment': 'comment', 'ti-comments': 'comments', 'ti-gift': 'gift', 'ti-target': 'bullseye', 'ti-wallet': 'credit-card',
    'ti-bag': 'shopping-bag', 'ti-shopping-cart': 'shopping-cart', 'ti-cup': 'trophy', 'ti-medall': 'trophy', 'ti-medall-alt': 'trophy',
    'ti-paint-roller': 'paint-brush', 'ti-paint-bucket': 'paint-brush', 'ti-ruler-pencil': 'pencil-square-o', 'ti-package': 'cube',
    'ti-support': 'life-ring', 'ti-thumb-up': 'thumbs-up', 'ti-bell': 'bell', 'ti-calendar': 'calendar', 'ti-map': 'map-marker',
  };
  const faIcon = (cls) => {
    cls = String(cls || '').trim(); if (!cls) return '';
    const toks = cls.toLowerCase().split(/\s+/);
    for (const t of toks) { if (/^(fa|fas|far|fab|fal|fad)$/.test(t) || t.indexOf('fa-') === 0) return cls; }
    for (const t of toks) { if (FA_MAP[t]) return 'fa fa-' + FA_MAP[t]; }
    return 'fa fa-star';
  };
  const iconValue = (cls) => ({ type: 'icon-font', 'icon-class': faIcon(cls), 'icon-class-without-root': false, 'pack-name': false, 'pack-css-uri': false });
  // A named family is (almost always) a Google face: the option type keeps a Google font's weight as its `variation` (and
  // blanks `weight`), so carry both — the counter view reads the variation when the weight is blank. PHP: counter_font.
  const counterFont = (weight, size, family = '') => ({
    google_font: !!family, subset: family ? 'latin' : false, variation: family ? (String(weight || '700') === '400' ? 'regular' : String(weight || '700')) : false, family: String(family || ''), style: 'normal',
    weight: (weight !== '' && weight != null) ? String(weight) : '700',
    size: (size !== '' && size != null) ? String(size) : '44',
    'line-height': '', 'letter-spacing': '0', color: false,
  });
  const nearWhite = (hex) => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || '')); return m ? (parseInt(m[1], 16) >= 240 && parseInt(m[2], 16) >= 240 && parseInt(m[3], 16) >= 240) : false; };
  const counterColor = (hex) => { hex = String(hex || '').trim(); if (!hex) return { predefined: '', custom: '' }; return nearWhite(hex) ? { predefined: 'text-white', custom: '' } : { predefined: '', custom: hex }; };

  const IB_STYLES = ['top-title', 'inline-left', 'inline-right', 'stack-left', 'stack-right', 'between-title-content'];
  const IB_TAGS = ['h3', 'h4', 'h5', 'h6', 'span', 'p'];
  const iconBoxNode = (card) => {
    const n = stamp(clone('icon_box'));
    const a = n.atts;
    a.title = String(card.title || '');
    // The card's EYEBROW → the native Overline; its captured type as scoped CSS (PHP parity: n_icon_box overline)
    if (card.overline && String(card.overline.text || '').trim()) {
      a.overline = String(card.overline.text).trim();
      const o = card.overline, ol = [];
      for (const [k, v] of [['font-size', o.fontSize], ['letter-spacing', o.letterSpacing], ['line-height', o.lineHeight], ['margin-bottom', o.marginBottom]]) if (/^-?[0-9.]+px$/.test(String(v || ''))) ol.push(k + ':' + v);
      if (/^(uppercase|none|capitalize)$/.test(String(o.textTransform || ''))) ol.push('text-transform:' + o.textTransform);
      if (/^[1-9]00$/.test(String(o.fontWeight || ''))) ol.push('font-weight:' + o.fontWeight);
      if (/^[a-z0-9(),.\s#%\/]+$/i.test(String(o.color || ''))) ol.push('color:' + o.color + ';opacity:1');
      if (/^[a-z0-9"',\s-]+$/i.test(String(o.fontFamily || ''))) ol.push('font-family:' + String(o.fontFamily).replace(/"/g, "'"));
      if (ol.length) a.custom_css = ((a.custom_css || '') + '\nselector .icon-box__overline{' + ol.join(';') + ';}').trim();
    }
    const tag = String(card.titleTag || 'h3').toLowerCase();
    a.title_tag = IB_TAGS.indexOf(tag) !== -1 ? tag : 'h3';
    let content = String(card.text || '');
    if (card.link && String(card.link.label || '').trim()) {
      content += '<p><a href="' + esc(localize(card.link.href || '#')) + '">' + esc(String(card.link.label).trim()) + '</a></p>';
    }
    a.content = content;
    if (card.lucide && a.icon && typeof a.icon === 'object') {
      // Native Lucide (e.g. <iconify-icon icon="lucide:zap">) → icon_box library icon (icon-v2 SVG source).
      a.icon = { ...a.icon, type: 'svg', 'svg-source': 'library', 'svg-id': 'lucide/' + card.lucide };
    }
    else if (card.customIcon) { a.custom_icon = String(card.customIcon); }
    else if (card.icon) { a.icon = iconValue(card.icon); }
    a.style = IB_STYLES.indexOf(card.iconLayout) !== -1 ? card.iconLayout : 'top-title';
    const ic = String(card.iconColor || '').trim();
    if (/^#[0-9a-f]{3,8}$/i.test(ic)) { a.icon_color = { predefined: '', custom: ic }; }
    // Icon badge/chip: the source icon's filled container → icon_badge (shape) + icon_badge_color (fill).
    if (card.iconBadge) { a.icon_badge = card.iconBadge; }
    const ibc = String(card.iconBadgeColor || '').trim();
    if (/^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))$/i.test(ibc)) { a.icon_badge_color = { predefined: '', custom: ibc }; }
    // Stash the full badge SKIN (shape / fill / glyph colour / size / radius / border) so the
    // post-pass in capture.mjs can cluster the DISTINCT badge designs into `icon_badge_presets`
    // (buildIconBadgePresets — the JS counterpart of PHP build_icon_badge_presets). Dropped after.
    if (card.iconBadge) {
      a._badge = {
        shape: card.iconBadge,
        fill: card.iconBadgeColor || '',
        iconColor: card.iconColor || '',
        size: card.iconBadgeSize || 0,
        radius: card.iconBadgeRadius || '',
        borderWidth: card.iconBadgeBorderWidth || '',
        borderColor: card.iconBadgeBorderColor || '',
      };
    }
    // ALIGNMENT — source feature cards are frequently LEFT-aligned while the icon_box top-title layout
    // CENTRES by default; carry the captured alignment so icon, title and content match the source column.
    if (/^(left|center|right)$/.test(card.align || '')) {
      a.icon_align = card.align; a.title_align = card.align; a.content_align = card.align;
    }
    // BOX SKIN → NATIVE options (not carried classes): the fill → bg_color; the border / corner radius /
    // shadow / hover-lift → a Theme-Settings **Box Preset** (`box_style`), assigned in a post-pass once
    // every card on the page is clustered — the raw skin is stashed on `_box` for that pass. So STRIP the
    // skin utilities (bg-*, rounded-*, border*, shadow-*) AND the spacing utilities (`p-8` collides with
    // the plugin's `.p-8` = 72px) from the carried class, leaving only non-skin layout classes. Padding is
    // reproduced from the computed value in custom_css (the plugin spacing scale can't express 32px).
    const bx = card.box || {};
    if (/^rgb/i.test(String(bx.bg || ''))) { a.bg_color = { predefined: '', custom: rgbToCss(bx.bg) }; }
    a._box = bx;
    a.css_class = String(card.cls || '').split(/\s+/).filter(Boolean).filter((c) => {
      const base = c.replace(/^-/, '').replace(/^(?:[\w]+:)+/, '');
      return !/^(bg-|rounded|border|shadow|drop-shadow|ring)/.test(base)
        && !/^(?:[pm][xytrbl]?|gap(?:-[xy])?|space-[xy])-/.test(base);
    }).join(' ');
    const pad = String(card.pad || '').trim();
    if (pad && pad !== '0px') { a.custom_css = 'selector{padding:' + pad.replace(/[{}<>;]/g, '') + ' !important;}'; }
    // HI-FI: Pass-1 source vertical margin → the icon_box NATIVE spacing option; Pass-2 the faithful base of
    // the card's REMAINING appearance — the box (fill/border/radius/shadow via bg_color + Box Preset), the icon
    // colour + title typography are `already`, so the base only fills the rest (a decorative background-image,
    // letter-spacing, transform, …) and never double-draws the card border. Parity with PHP icon_box builder.
    if (hifiCss) {
      const ics = csFromFields(Object.assign({}, card, card.box || {}));
      if (a.spacing) applyNativeMargin(a.spacing, ics, hifiCss);
      applyHifiBase(n, ics, ['background-color', 'border', 'border-radius', 'box-shadow', 'color', 'font-family', 'font-size', 'font-weight', 'line-height'], hifiCss);
    }
    // The TEXT LONG TAIL on the card's title / description + the card image's own treatment (capture-extract
    // textLongTailOf / imgExtraOf) → scoped CSS. PHP twin: n_icon_box titleCs / bodyCs / image.extra.
    // A coloured card's inherited ink → native Title / Content Colour when it differs from the page ink (PHP: page_ink).
    if (card.titleInk && a.title_color && typeof a.title_color === 'object' && !a.title_color.custom) { const hx = rgbToCss(card.titleInk); if (hx && /^(?:#|rgb)/i.test(hx)) a.title_color = { predefined: '', custom: hx }; }
    if (card.bodyInk && a.content_color && typeof a.content_color === 'object' && !a.content_color.custom) { const hx = rgbToCss(card.bodyInk); if (hx && /^(?:#|rgb)/i.test(hx)) a.content_color = { predefined: '', custom: hx }; }
    if (card.bodyColor && a.content_color && typeof a.content_color === 'object' && !a.content_color.custom) { const hx = rgbToCss(card.bodyColor); if (hx && /^(?:#|rgb)/i.test(hx)) a.content_color = { predefined: '', custom: hx }; } // PHP: content_color from bodyCs
    { const lk = String(card.bodyLinkSkin || '').trim(); if (lk && /^[a-z0-9()%.,:;\s#-]+$/i.test(lk)) a.custom_css = (a.custom_css ? a.custom_css + '\n' : '') + 'selector .icon-box__content a{' + lk + ';}'; } // PHP: bodyLinkCs
    for (const [k, sel] of [['titleExtra', '.icon-box__title'], ['bodyExtra', '.icon-box__content']]) { const ex = String(card[k] || '').trim(); if (ex && /^[a-z0-9()%.,:;"'\s#\/-]+$/i.test(ex)) a.custom_css = (a.custom_css ? a.custom_css + '\n' : '') + 'selector ' + sel + '{' + ex + ';}'; }
    // The description's OWN measure → .icon-box__content{max-width} (PHP parity: n_icon_box bodyCs max-width).
    if (/^[0-9.]+px$/.test(String(card.bodyMaxWidth || '')) && parseFloat(card.bodyMaxWidth) < 900) a.custom_css = ((a.custom_css || '') + '\nselector .icon-box__content{max-width:' + card.bodyMaxWidth + ';}').trim();
    // WIDE PASS: the card's >= 1536px inset when it differs (capture-extract padXl) → a min-width:1536px rule on the box. PHP: cardCsXl.
    { const px = String(card.padXl || '').trim(); if (/^[0-9.]+px(?:\s+[0-9.]+px){0,3}$/.test(px)) a.custom_css = (a.custom_css ? a.custom_css + '\n' : '') + '@media (min-width:1536px){selector{padding:' + px + ' !important;}}'; }
    // CHILD RHYTHM (capture-extract bodyRhythm) → .icon-box__content p + p (PHP: n_icon_box bodyRhythm).
    { const brh = String(card.bodyRhythm || '').trim(); if (brh && /^[a-z0-9()%.,:;\s#-]+$/i.test(brh)) a.custom_css = (a.custom_css ? a.custom_css + '\n' : '') + 'selector .icon-box__content p + p{' + brh + ' !important;}'; }
    // A SIDE-BY-SIDE card (capture-extract cardRow) → the icon_box inner becomes a row from the source's tier (PHP: cardRow).
    if (card.cardRow && typeof card.cardRow === 'object') { const cr = card.cardRow; const mq = cr.from === 'lg' ? '@media (min-width:992px)' : '@media (min-width:768px)'; const gap = cr.gap | 0; a.custom_css = (a.custom_css ? a.custom_css + '\n' : '') + mq + '{selector .icon-box__inner{display:flex;flex-direction:row;align-items:flex-start;' + (gap > 0 ? 'gap:' + gap + 'px;' : '') + '}selector .icon-box__head,selector .icon-box__inner>.icon-box__title{flex:0 0 auto;' + (cr.titleLast ? 'order:2;' : '') + '}selector .icon-box__body,selector .icon-box__inner>.icon-box__content{flex:1 1 auto;}}'; }
    // EMPTY PAINTED BOXES carried in the description (capture-extract decorBoxes) → scoped CSS on the class hook (PHP: bodyDecor).
    for (const bd of (Array.isArray(card.decorBoxes) ? card.decorBoxes : [])) { if (bd && bd.css && !String(bd.css).includes('</')) a.custom_css = (a.custom_css ? a.custom_css + '\n' : '') + 'selector .icon-box__content .sc-deco-' + (bd.n | 0) + '{display:block;width:100%;' + bd.css + ';}'; }
    // HOVER on the title / description (own or group) + the card's hover ink inherited by them → selector:hover rules (PHP: n_icon_box titleHover).
    { const hov = (card.box && card.box.hover) || card.hover || null; const hcol = hov && hov.color ? String(hov.color) : '';
      for (const [hk, sel, inh] of [['titleHover', '.icon-box__title', 'titleInherits'], ['bodyHover', '.icon-box__content', 'bodyInherits']]) {
        let decl = String(card[hk] || '').trim();
        if (hcol && !/color:/i.test(decl) && card[inh] !== false) decl = decl + (decl ? ';' : '') + 'color:' + hcol;
        if (decl && /^[a-z0-9()%.,:;\s#\/-]+$/i.test(decl)) a.custom_css = (a.custom_css ? a.custom_css + '\n' : '') + 'selector:hover ' + sel + '{' + decl + ' !important;}';
      } }
    // PHONE / TABLET PASS: the title's / description's measured phone / tablet font-size → scoped media rules (PHP: n_icon_box titleCsSm/Md).
    for (const [key, sel] of [['title', '.icon-box__title'], ['body', '.icon-box__content']]) {
      for (const [tier, mq] of [['Sm', '@media (max-width:767px)'], ['Md', '@media (min-width:768px) and (max-width:991px)'], ['Xl', '@media (min-width:1536px)']]) {
        const fsv = String(card[key + 'Fs' + tier] || ''), lhv = String(card[key + 'Lh' + tier] || '');
        if (!/^[0-9.]+px$/.test(fsv)) continue;
        a.custom_css = (a.custom_css ? a.custom_css + '\n' : '') + mq + '{selector ' + sel + '{font-size:' + fsv + (/^[0-9.]+px$/.test(lhv) ? ';line-height:' + lhv : '') + ' !important;}}';
      }
    }
    if (card.image && card.image.extra && /^[a-z0-9()%.,:;\s#\/-]+$/i.test(String(card.image.extra))) a.custom_css = (a.custom_css ? a.custom_css + '\n' : '') + 'selector .icon-box__image img, selector img{' + card.image.extra + ';}';
    // The card's decorative / SWEEP pseudo-layers (capture-extract cardOf decor) → scoped CSS. PHP twin: n_icon_box decor.
    for (const dl of (card.decor || [])) { const dc = dl ? decorPseudoCss(dl) : ''; if (dc) a.custom_css = (a.custom_css ? a.custom_css + '\n' : '') + dc; }
    return n;
  };
  // A FLOATING badge/card overlaid on a hero image → an editable icon_box, POSITIONED + skinned over
  // the image via scoped Custom CSS (absolute top/left, bg, radius, shadow, padding). Parity with the
  // PHP floating_card_block + floating_card_pos_css. `fc` comes from capture-extract's floatingCardOf.
  const floatingCardPosCss = (pos) => {
    if (!pos) return '';
    const decl = ['position:absolute', 'z-index:20', 'max-width:16rem'];
    const cls = ' ' + String(pos.cls || '') + ' ';
    for (const side of ['top', 'left', 'right', 'bottom']) {
      const m = cls.match(new RegExp('(^|\\s)(-?)' + side + '-(\\d{1,3})(\\s|$)'));
      if (m) { const v = (m[2] === '-' ? -1 : 1) * (parseInt(m[3], 10) * 0.25); decl.push(side + ':' + String(+v.toFixed(3)) + 'rem'); }
    }
    if (pos.bg && !/rgba?\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/.test(pos.bg)) decl.push(`background:${pos.bg}`);
    if (pos.radius && !/^(0px)( 0px)*$/.test(String(pos.radius).trim())) decl.push(`border-radius:${pos.radius}`);
    if (pos.shadow && pos.shadow !== 'none') decl.push(`box-shadow:${pos.shadow}`);
    if (pos.padding && !/^(0px)( 0px)*$/.test(String(pos.padding).trim())) decl.push(`padding:${pos.padding}`);
    return `selector{${decl.join(';')};}`;
  };
  const floatingCardNode = (fc) => {
    const card = {
      title: fc.title || '', titleTag: fc.titleTag || 'h4',
      text: fc.subtitle ? '<p>' + esc(fc.subtitle) + '</p>' : '',
      customIcon: fc.customIcon || '', iconCls: fc.iconCls || '', iconColor: fc.iconColor || '',
      iconBadge: fc.iconBadge || '', iconBadgeColor: fc.iconBadgeColor || '',
      iconLayout: fc.iconLayout || 'inline-left', align: fc.center ? 'center' : 'left',
      overline: fc.overline || null, titleExtra: fc.titleExtra || '', // a stacked chip's month over its day; the title's own size / leading / margin (PHP: n_icon_box)
    };
    const n = iconBoxNode(card);
    let pos = floatingCardPosCss(fc.pos);
    if (/^[0-9.]+px$/.test(String(fc.minWidth || ''))) pos = pos.replace(/;}$/, ';min-width:' + fc.minWidth + ';}');
    if (fc.innerGap !== undefined && /^(?:0|[0-9.]+px)$/.test(String(fc.innerGap))) pos += 'selector .icon-box__inner{gap:' + fc.innerGap + ';}'; // the chip's own gap between its lines (PHP: floating_card_pos_css)
    if (n.atts && pos) { n.atts.custom_css = (n.atts.custom_css ? n.atts.custom_css + '\n' : '') + pos; }
    return n;
  };
  // A testimonials collection → the editable `testimonials` shortcode (parity with PHP
  // n_testimonials). Each detected item carries quote/name/position/image/site/rating.
  const testimonialsNode = (rows) => {
    const n = stamp(clone('testimonials'));
    const a = n.atts;
    let anyExtra = false;
    a.testimonials = (rows || []).map((r) => {
      const hasRating = r.rating != null && r.rating !== '';
      // EXTRA TEXTS — per-testimonial stat/result rows ({label,value}) → the shortcode's repeatable Extra
      // field, so a "Total savings → $14,200" footer survives instead of being lost. Parity with PHP.
      const extra = Array.isArray(r.extra)
        ? r.extra.map((e) => ({ label: String((e && e.label) || '').trim(), value: String((e && e.value) || '').trim() }))
                 .filter((e) => e.label !== '' || e.value !== '')
        : [];
      if (extra.length) anyExtra = true;
      return {
        content: String(r.quote || ''),
        author_avatar: { attachment_id: '', url: String(r.image || '') },
        author_name: String(r.name || ''),
        author_job: String(r.position || ''),
        site_name: String(r.siteName || ''),
        site_url: String(r.siteUrl || ''),
        rating: hasRating ? Number(r.rating) : 5,
        extra,
      };
    });
    a.title = '';
    a.container_type = 'container';
    a.text_align = 'text-center';
    a.avatar_shape = 'rounded-circle';
    a.avatar_size = 'avatar-lg';
    a.show_rating = 'yes';
    // When any testimonial carries a footer stat, pin the Card Rows so the Extra Texts slot renders at the
    // card footer (a divider + the stat rows). Omitted otherwise, so plain testimonials keep the option default.
    if (anyExtra) {
      a.card_rows = [
        { slots: ['rating'], direction: 'inline', justify: 'center', align: 'center' },
        { slots: ['quote'], direction: 'stack', justify: 'start', align: 'center' },
        { slots: ['avatar', 'author'], direction: 'inline', justify: 'center', align: 'center' },
        { slots: ['extra'], direction: 'stack', justify: 'start', align: 'center' },
      ];
    }
    return n;
  };
  const counterNode = (c) => {
    const n = stamp(clone('counter'));
    const a = n.atts;
    a.number = String(c.number != null ? c.number : '100');
    a.start = String(c.start || '0');
    a.prefix = String(c.prefix || '');
    a.suffix = String(c.suffix || '');
    a.decimals = String(c.decimals || '0');
    // Source stat cell alignment (hero stats are centered) → the counter aligns to match. Parity with PHP n_counter.
    a.alignment = (c.align === 'center' || c.align === 'right') ? c.align : (a.alignment || '');
    a.number_font = counterFont(c.numberWeight, c.numberSize, c.numberFamily); // the digits' own face (a mono stat) — PHP: counter_number_treatment
    a.number_color = counterColor(c.numberColor);
    // Prefix ($) + suffix (K) match the NUMBER's size so `$12K` reads as one uniform unit (was a fixed 24px
    // prefix beside a 44px number). Falls back to the old sizes when the source size wasn't captured.
    a.prefix_font = counterFont(c.numberWeight, c.prefixSize || '24', c.numberFamily);
    a.suffix_font = counterFont(c.suffixWeight || c.numberWeight, c.suffixSize, c.numberFamily);
    a.suffix_color = counterColor(c.suffixColor);
    return n;
  };

  // === Structured / interactive native-widget node builders — parity with the PHP Mapper n_* builders
  //     (class-fw-site-converter-mapper.php: n_table / n_accordion / n_feature_list / n_tabs / n_steps /
  //     n_timeline / n_progress / n_pricing / n_lottie / n_svg_draw). No default-att atom exists for these
  //     shortcodes, so the atts tree is built inline with the SAME overlay keys the PHP finalize_widget
  //     writes; a below-min payload falls back to a code_block, exactly like PHP. ===
  const iconNone = () => ({ type: 'none', 'icon-class': '', 'icon-class-without-root': false, 'pack-name': false, 'pack-css-uri': false });
  const widgetNode = (shortcode, atts) => ({ type: 'simple', shortcode, _items: [], atts: { css_id: '', css_class: '', ...atts, unique_id: uid() } });
  // An EMPTY PAINTED block → a native empty Div wearing the paint + its height / growth. PHP: the 'paint' builder.
  const paintNode = (b) => {
    const css = String(b.css || '').trim(); if (!css) return null;
    const n = stamp(clone('flexbox')); n.atts.custom_css = ((n.atts.custom_css || '') + '\nselector{' + css.replace(/[{}<>]/g, '') + ';}').trim();
    return carryWrapMargins(n, { mtAdd: b.mt || 0, mbAdd: b.mb || 0 });
  };
  // A lone glyph block → the icon shortcode: the inline svg (or an icon-font class), its measured size + ink. PHP: n_lone_icon.
  const loneIconNode = (b) => {
    const svg = String(b.svg || '').trim(), fa = String(b.fa || '').trim();
    if (!svg && !fa) return null;
    const atts = { title: '', icon: svg ? { type: 'svg', 'svg-source': 'inline', markup: svg, 'svg-id': '' } : { type: 'icon-font', 'icon-class': fa, 'icon-class-without-root': '', 'pack-name': '', 'pack-css-uri': '' } };
    // a Lucide glyph whose inline svg carries no geometry → the library icon (PHP n_lone_icon lucide)
    const lucide = String(b.lucide || '');
    if (/^lucide\/[a-z0-9-]+$/.test(lucide) && !/\s(?:d|points|cx|x1|x)="[^"]{2,}"/.test(svg)) atts.icon = { type: 'svg', 'svg-source': 'library', 'svg-id': lucide, markup: '' };
    if (b.size > 0) atts.icon_size = { value: String(b.size), unit: 'px' };
    if (/^rgb/i.test(String(b.color || ''))) atts.icon_color = { predefined: '', custom: rgbToCss(b.color) };
    if (b.align === 'center' || b.align === 'right') atts.custom_css = 'selector{text-align:' + b.align + ';}';
    // the glyph's TILE (capture-extract loneIconOf tile: a ring emblem) → the badge skin for the presets pass (_badge) + the
    // tile drawn around the glyph as scoped CSS (PHP: chip_skin_from → an Icon Badge Preset on the icon)
    if (b.tile && b.tile.w > 0) {
      const t = b.tile; const circle = /9999|50%/.test(String(t.radius || ''));
      atts._badge = { shape: circle ? 'solid-circle' : (t.radius && t.radius !== '0px' ? 'solid-rounded' : 'solid-square'), fill: t.bg || '', iconColor: b.color || '', size: t.w, radius: circle ? '' : (t.radius || ''), borderWidth: t.borderW || '', borderColor: t.borderW ? (t.borderColor || '') : '' };
      const d = ['display:inline-flex', 'align-items:center', 'justify-content:center', 'width:' + t.w + 'px', 'height:' + t.h + 'px', 'border-radius:' + (t.radius || '0'), 'box-sizing:border-box'];
      if (t.bg && !/rgba\(\d+, \d+, \d+, 0\)|transparent/.test(t.bg)) d.push('background:' + t.bg);
      if (t.borderW) d.push('border:' + t.borderW + ' solid ' + (t.borderColor || 'currentColor'));
      if (t.shadow) d.push('box-shadow:' + t.shadow);
      atts.custom_css = ((atts.custom_css || '') + ' selector .sc-icon-glyph{' + d.join(';') + ';}').trim();
    }
    const n = widgetNode('icon', atts);
    return carryWrapMargins(n, { mtAdd: b.mt || 0, mbAdd: b.mb || 0 });
  };

  // A <table> → native `table` (tabular render). Leading all-<th> rows → header_rows (<thead>). Parity
  // with n_table. NOTE: the Table Preset slug is chosen PHP-side (reads the WP preset library), which the
  // capture service can't see, so `table_preset` is left unset here (the style evidence rides on the block).
  const tableNode = (b) => {
    const rows = Array.isArray(b.rows) ? b.rows : [];
    let ncol = 0; for (const r of rows) if (Array.isArray(r)) ncol = Math.max(ncol, r.length);
    if (ncol < 1 || !rows.length) return codeBlock('');
    const cols = []; for (let c = 0; c < ncol; c++) { const votes = {}; for (const r of rows) { const a = (Array.isArray(r) && r[c] && r[c].align) || ''; votes[a] = (votes[a] || 0) + 1; } const al = Object.entries(votes).sort((x, y) => y[1] - x[1])[0][0]; cols.push({ name: 'default-col', align: al === 'right' || al === 'center' ? al : '', width: '' }); } // the column's alignment = the mode of its cells' measured text-align
    let headerRows = 0, seenBody = false;
    for (const r of rows) {
      let allTh = Array.isArray(r) && r.length > 0;
      for (const cell of (r || [])) if (!cell || !cell.header) { allTh = false; break; }
      if (allTh && !seenBody) headerRows++; else seenBody = true;
    }
    const content = [], rowmeta = [];
    rows.forEach((r, ri) => {
      r = Array.isArray(r) ? r : [];
      const line = [];
      for (let c = 0; c < ncol; c++) { const cell = (r[c] && typeof r[c] === 'object') ? r[c] : {}; line[c] = { textarea: String(cell.html || ''), colspan: 1, rowspan: 1, merged: false }; }
      content.push(line); rowmeta.push({ name: ri < headerRows ? 'heading-row' : 'default-row' });
    });
    const atts = { table: { header_options: { table_purpose: 'tabular', header_rows: headerRows, footer_rows: 0 }, cols, rows: rowmeta, content } };
    if (b.caption && String(b.caption).trim()) atts.caption = String(b.caption).trim();
    // The table's MEASURED skin → a Table Preset (PHP register_table_preset → build_table_presets): the node points at
    // 'tbl-table-<hash>' and stashes the normalised skin on '_tableSkin' for capture.mjs to hand to buildTablePresets.
    const skin = tableSkinOf(b.style || {});
    if (skin) { atts.table_preset = 'tbl-' + skin.slug; atts._tableSkin = skin; atts.style_striped = 'no'; atts.style_hover = 'no'; atts.style_bordered = 'no'; } // the preset owns zebra / hover / frame
    return widgetNode('table', atts);
  };
  // PHP register_table_preset: the evidence normalised to the preset's vocabulary, keyed by a hash of itself.
  const tableSkinOf = (st) => {
    const td = st.td || {}, th = st.th || {}, tf = st.tf || {};
    if (!Object.keys(td).length) return null;
    const col = (v) => { v = String(v || '').trim(); return !v || /^transparent$/i.test(v) || /,\s*0\s*\)\s*$/.test(v) ? '' : v; };
    const px = (v) => (/^-?[0-9.]+px$/.test(String(v || '').trim()) ? String(v).trim() : '');
    const face = (v) => { v = String(v || '').trim(); return !v || !/^[a-z0-9"',\s-]+$/i.test(v) ? '' : v.replace(/"/g, "'"); };
    const tt = (v) => (['', 'none'].includes(String(v || '').toLowerCase()) ? '' : String(v).toLowerCase());
    const ls = (v) => (['', 'normal'].includes(String(v || '').toLowerCase()) ? '' : String(v));
    const bodyFace = face(td['font-family']), headFace = face(th['font-family']);
    const pad = (d) => { const t = px(d['padding-top']), r = px(d['padding-right']), b2 = px(d['padding-bottom']), l = px(d['padding-left']); if (!t && !b2) return ''; return (t || '0px') + ' ' + (r || '0px') + ' ' + (b2 || '0px') + ' ' + (l || '0px'); };
    const tdPad = pad(td), thPad = pad(th);
    const skin = {
      pad_y: px(td['padding-top']) ? Math.max(parseFloat(td['padding-top']), parseFloat(td['padding-bottom'] || 0)) + 'px' : '',
      pad_x: px(td['padding-left']) ? Math.max(parseFloat(td['padding-left']), parseFloat(td['padding-right'] || 0)) + 'px' : '',
      hline: st.hline || '', vline: st.vline || '', frame: st.frame || {},
      header: st.has_head ? { bg: col(th['background-color']), color: col(th.color), weight: th['font-weight'] || '', transform: tt(th['text-transform']), family: headFace && headFace.toLowerCase() !== bodyFace.toLowerCase() ? headFace : '', size: px(th['font-size']) !== px(td['font-size']) ? px(th['font-size']) : '', tracking: ls(th['letter-spacing']), lh: px(th['line-height']) !== px(td['line-height']) ? px(th['line-height']) : '', pad: thPad && thPad !== tdPad ? thPad : '', line: st.hdline || '' } : {},
      body: { bg: col(st.row_bg), color: col(td.color), size: px(td['font-size']), weight: td['font-weight'] && !['400', 'normal'].includes(String(td['font-weight'])) ? String(td['font-weight']) : '', family: '', tracking: ls(td['letter-spacing']), transform: tt(td['text-transform']), lh: px(td['line-height']) },
      footer: st.has_foot ? { bg: col(tf['background-color']), color: col(tf.color), weight: tf['font-weight'] || '', line: st.ftline || '' } : {},
      stripe_bg: col(st.stripe_bg), hover: st.hover || '',
      caption: st.caption && Object.keys(st.caption).length ? { color: col(st.caption.color), size: px(st.caption['font-size']), style: st.caption['font-style'] || '' } : {},
      transition: st.transition || '',
    };
    skin.slug = 'table-' + createHash('md5').update(JSON.stringify(skin)).digest('hex').slice(0, 8);
    return skin;
  };

  // An accordion/FAQ toggle group → native `accordion`; each item → one `tabs` row. Parity n_accordion.
  const accordionNode = (b) => {
    const src = Array.isArray(b.items) ? b.items : [];
    const tabs = [];
    let opens = 0;
    for (const it of src) { const title = String(it.title || '').trim(); if (!title) continue; const open = !!it.open; if (open) opens++; tabs.push({ tab_title: title, tab_content: String(it.content || ''), is_open: open ? 'yes' : 'no' }); }
    if (!tabs.length) return codeBlock('');
    const atts = { tabs };
    // Initial open state from the source (parity n_accordion) — explicit so a source with NO open panel
    // doesn't force the default 'first' open. Per-tab is_open carries the specifics.
    atts.initially_open = (opens > 0 && opens === tabs.length) ? 'all' : 'none';
    // Match the SOURCE design captured by accordionDesign (parity n_accordion): style/icon/position/etc.
    const dz = (b.design && typeof b.design === 'object') ? b.design : {};
    for (const k of ['accordion_style', 'icon_style', 'icon_position', 'title_alignment', 'title_tag', 'corner_radius', 'item_spacing', 'elevation', 'multiple_open']) {
      if (dz[k] != null && dz[k] !== '') atts[k] = dz[k];
    }
    for (const ck of ['title_bg_color', 'content_bg_color', 'tab_title_color', 'tab_content_color', 'icon_closed_color']) {
      if (dz[ck] && typeof dz[ck] === 'object') atts[ck] = dz[ck];
    }
    // Re-emit the source's FAQ structured data when the page carried a schema.org/FAQPage for these items.
    if (b.faq) atts.faq_schema = 'yes';
    // Stash a compact hint (consumed + deleted in capture.mjs) so the local-AI verify pass can confirm/correct
    // icon_style & accordion_style from the real icon markup — same _box-style hand-off the box presets use.
    if (dz._hint) atts._accordion_hint = { hint: dz._hint, icon_style: atts.icon_style || '', accordion_style: atts.accordion_style || '', titles: tabs.slice(0, 3).map((t) => t.tab_title) };
    return widgetNode('accordion', atts);
  };

  // A <ul>/<ol> → native `feature_list` (<ul> check, <ol> numbered). Parity n_feature_list.
  const featureListNode = (b) => {
    const src = Array.isArray(b.items) ? b.items : [];
    // A computed colour that carries no distinctive tone (pure black / empty / inherit) stays neutral.
    const isDefaultInk = (v) => { const s = String(v || '').toLowerCase().replace(/\s+/g, ''); return s === '' || ['inherit', 'initial', 'currentcolor', 'transparent', 'black', '#000', '#000000', 'rgb(0,0,0)', 'rgba(0,0,0,1)', 'rgba(0,0,0,0)'].includes(s); };
    const mkColor = (v) => (v && !isDefaultInk(v) ? { predefined: '', custom: rgbToCss(v) } : { predefined: '', custom: '' });
    const items = [];
    for (const r of src) {
      const text = String(r.text || '').trim(); if (!text) continue;
      const icon = String(r.icon_svg || '').trim() ? { type: 'svg', 'svg-source': 'inline', markup: String(r.icon_svg) } : iconNone();
      items.push({ text, subtext: '', value_text: '', icon, marker_color: mkColor(r.icon_color), state: 'on', link_url: '', link_target: '_self' });
    }
    if (!items.length) return codeBlock('');
    const atts = { items, design: b.ordered ? 'numbered' : 'check' };
    // ORIENTATION — a source `flex flex-wrap` strip is HORIZONTAL; a stacked list is vertical.
    if (b.orientation === 'horizontal') atts.orientation = 'horizontal';
    // LIST-LEVEL MARKER + TEXT COLOUR (parity with PHP n_feature_list).
    if (b.markerColor && !isDefaultInk(b.markerColor)) atts.marker_color = mkColor(b.markerColor);
    if (b.textColor && !isDefaultInk(b.textColor)) atts.text_color = mkColor(b.textColor);
    // LABEL SIZE — nearest Text Style preset, else pin the exact px via scoped CSS (a 14px `text-sm` label
    // falls between the 12px Caption + 16px Small presets, so no preset matches within tolerance).
    let css = '';
    const labelFs = Number(b.labelFs) || 0;
    if (labelFs > 0) { const p = textPresetFor(labelFs); if (p) atts.font_size_preset = p; else css += 'selector .fw-fl__text{font-size:' + Math.round(labelFs) + 'px;}'; }
    // MARKER SIZE — the icon width (`w-5` = 20px) → the Icon Size unit-input.
    const markerSize = Number(b.markerSize) || 0;
    if (markerSize > 0) atts.marker_size = { value: String(Math.round(markerSize)), unit: 'px' };
    // ROW SPACING — the wrapping gap (`gap-5` = 20px) → sm/md/lg.
    const listGap = Number(b.listGap) || 0;
    if (listGap > 0) atts.spacing_size = listGap <= 8 ? 'sm' : (listGap >= 28 ? 'lg' : 'md');
    // ICON↔LABEL GAP — each row's own `gap-2` (8px); the skin default is ~12px, so carry a meaningful diff.
    const itemGap = Number(b.itemGap) || 0;
    if (itemGap > 0 && Math.abs(itemGap - 12) >= 2) css += (css ? '\n' : '') + 'selector .fw-fl__item{gap:' + Math.round(itemGap) + 'px;}';
    if (css) atts.custom_css = css;
    return widgetNode('feature_list', atts);
  };

  // A tab widget → native `tabs`; each tab → one entry. Parity n_tabs (needs >=2, first active fallback).
  const tabsNode = (b) => {
    const src = Array.isArray(b.items) ? b.items : [];
    const tabs = []; let haveActive = false;
    for (const it of src) {
      const title = String(it.title || '').trim(); if (!title) continue;
      const active = (!haveActive && it.active === 'yes') ? 'yes' : 'no'; if (active === 'yes') haveActive = true;
      tabs.push({ tab_title: title, tab_content: String(it.content || ''), tab_image: '', badge: '', icon: iconNone(), disabled: 'no', is_active: active });
    }
    if (tabs.length < 2) return codeBlock('');
    if (!haveActive) tabs[0].is_active = 'yes';
    return widgetNode('tabs', { tabs });
  };

  // A numbered process flow → native `steps`. Parity n_steps.
  // A step's per-item `icon` value from the captured hint (parity PHP step_icon_value): lucide → library
  // icon, inline svg → inline markup, img → custom url, else the `none` icon.
  const stepIconValue = (ic) => {
    if (ic && typeof ic === 'object') {
      if (ic.lucide) return { type: 'svg', 'svg-source': 'library', 'svg-id': String(ic.lucide), markup: '' };
      if (ic.svg) return { type: 'svg', 'svg-source': 'inline', markup: String(ic.svg), 'svg-id': '' };
      if (ic.img) return { type: 'custom', url: String(ic.img) };
    }
    return iconNone();
  };
  const stepsNode = (b) => {
    const src = Array.isArray(b.items) ? b.items : [];
    const steps = [];
    for (const it of src) { const title = String(it.title || '').trim(); if (!title) continue; steps.push({ title, content: String(it.content || ''), icon: stepIconValue(it.icon), number: String(it.number || '') }); }
    if (steps.length < 2) return codeBlock('');
    const atts = { steps };
    // Match the SOURCE process design captured by detectStepsDesign (parity n_steps): layout + marker.
    const dz = (b.design && typeof b.design === 'object') ? b.design : {};
    if (dz.design) atts.design = String(dz.design);
    if (dz.marker_shape) atts.marker_shape = String(dz.marker_shape);
    if (dz.connector != null && dz.connector !== '') atts.connector = String(dz.connector);
    if (dz.accent) atts.accent_color = { predefined: '', custom: String(dz.accent) };
    // EVERYTHING the step shows lives in Card Rows (icon badge + number + title + description) so the editor is
    // the single source of truth — no separate marker spine. marker=none; the icon renders as a body badge.
    const hasIcon = steps.some((s) => s.icon && typeof s.icon === 'object' && (s.icon.type || 'none') !== 'none');
    const hasNum = src.some((it) => String(it.number || '').trim() !== '');
    const rows = [];
    if (hasIcon && hasNum) rows.push({ slots: ['icon', 'number'], direction: 'inline', justify: 'between', align: 'center' });
    else if (hasIcon) rows.push({ slots: ['icon'], direction: 'stack', justify: 'start', align: 'start' });
    // a numeral the source sets INLINE at the item's start is LEFT-aligned; the end-aligned row is the
    // "big faded number in the corner" convention, not a left chip list. PHP twin: n_steps.
    else if (hasNum && dz.numBadge) { /* the badge rides the native marker — below */ }
    else if (hasNum && dz.numInline) rows.push({ slots: ['number'], direction: 'stack', justify: 'start', align: 'start' });
    else if (hasNum) rows.push({ slots: ['number'], direction: 'stack', justify: 'end', align: 'end' });
    rows.push({ slots: ['title'], direction: 'stack', justify: 'start', align: 'start' });
    rows.push({ slots: ['content'], direction: 'stack', justify: 'start', align: 'start' });
    atts.card_rows = rows;
    atts.marker = 'none';
    // A numeral drawn as a painted BADGE in its own leading cell is the native MARKER: the design lays it
    // beside the body, which is the source's two-column step. Its measured shape, size and outlined skin ride
    // with it — the shortcode's marker paints a solid accent fill with white text, rarely what the source drew.
    // PHP twin: n_steps' numBadge branch.
    if (hasNum && dz.numBadge) {
      atts.marker = 'number';
      if (dz.numShape) atts.marker_shape = String(dz.numShape);
      if (dz.connector === 'solid' || dz.connector === 'none') atts.connector = String(dz.connector);
      if (dz.markerSize) atts.custom_css = String(atts.custom_css || '') + `selector{--st-size:${Math.round(dz.markerSize)}px;}`;
      const bcs = dz.numBadgeCs && typeof dz.numBadgeCs === 'object' ? dz.numBadgeCs : null;
      if (bcs) {
        const md = [];
        const opaque = bcs.bg && !/rgba?\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/.test(bcs.bg);
        md.push(opaque ? `background:${bcs.bg}` : 'background:transparent');
        if ((parseFloat(bcs.bw) || 0) > 0 && bcs.bc) md.push(`border:${bcs.bw} solid ${bcs.bc}`);
        for (const [p, v] of [['color', bcs.color], ['font-size', bcs.fs], ['font-weight', bcs.fw], ['font-family', bcs.ff], ['letter-spacing', bcs.ls]]) {
          if (v && v !== 'normal') md.push(`${p}:${v}`);
        }
        atts.custom_css = String(atts.custom_css || '') + `selector .fw-steps__marker{${md.join(';')};}`;
      }
    }
    // Stash the step-card box skin for the Box-Preset census in capture.mjs (assigns box_style, then drops _box).
    if (dz.box && typeof dz.box === 'object') atts._box = dz.box;
    return widgetNode('steps', atts);
  };

  // A dated timeline → native `timeline`; each entry → one milestone. Parity n_timeline.
  const timelineNode = (b) => {
    const src = Array.isArray(b.items) ? b.items : [];
    const items = [];
    for (const it of src) { const title = String(it.title || '').trim(); const date = String(it.date || '').trim(); if (!title && !date) continue; items.push({ date, title: title || date, text: String(it.text || ''), icon: iconNone(), image: '', link_label: '', link_url: '', link_target: '_self' }); }
    if (items.length < 2) return codeBlock('');
    return widgetNode('timeline', { items });
  };

  // Skill/progress bars → native `progress` (bar layout). Parity n_progress.
  const progressNode = (b) => {
    const src = Array.isArray(b.bars) ? b.bars : [];
    const bars = [];
    for (const it of src) { const pct = parseInt(it.percent, 10) || 0; bars.push({ label: String(it.label || ''), percent: Math.max(0, Math.min(100, pct)), icon: iconNone(), color: { predefined: '', custom: '' } }); }
    if (bars.length < 2) return codeBlock('');
    return widgetNode('progress', { layout: { type: 'bar' }, bars });
  };

  // A pricing grid → native `pricing_table`; each column → a plan (multi-inline monthly/yearly). Parity n_pricing.
  const pricingNode = (b) => {
    const src = Array.isArray(b.plans) ? b.plans : [];
    const plans = [];
    for (const p of src) {
      const title = String(p.title || '').trim(); const price = String(p.price || '').trim();
      if (!title && !price) continue;
      const period = String(p.period || '').trim();
      plans.push({ plan_title: title || 'Plan', icon: iconNone(), subtitle: '', currency: String(p.currency || '$'),
        price: { monthly: price, yearly: '' }, period: { monthly: period || '/mo', yearly: '/yr' }, original_price: { monthly: '', yearly: '' },
        features: String(p.features || ''), featured: (p.featured === 'yes') ? 'yes' : 'no', ribbon: String(p.ribbon || ''),
        button_label: String(p.btn_label || ''), button_url: localize(p.btn_url || ''), button_target: '_self' });
    }
    if (plans.length < 2) return codeBlock('');
    return widgetNode('pricing_table', { plans, columns: String(Math.max(2, Math.min(5, plans.length))) });
  };

  // A Lottie/Bodymovin embed → native `lottie` (URL source, viewport trigger). Parity n_lottie.
  const lottieNode = (b) => { const src = String(b.src || '').trim(); if (!src) return codeBlock(''); return widgetNode('lottie', { source: 'url', lottie_url: src, trigger: 'viewport' }); };

  // A self-drawing SVG → native `svg_draw` (pasted-code source, view trigger). Parity n_svg_draw.
  const svgDrawNode = (b) => { const code = String(b.code || ''); if (!code.trim()) return codeBlock(''); return widgetNode('svg_draw', { svg: { source: 'code', preset: { preset: 'signature' }, code: { code }, upload: { file: '' } }, trigger: 'view' }); };

  // A logo / "trusted by" strip → native `logo_grid` (each <img> → one editable logo). Parity n_logo_grid.
  const logoGridNode = (b) => {
    const logos = (b.logos || []).map((l) => ({
      image: { attachment_id: '', url: String(l.url || '') },
      svg: String(l.svg || ''),
      name: String(l.name || ''),
      no_label: 'no',
      link_url: String(l.link_url || ''),
      link_target: (l.link_target === '_self' ? '_self' : '_blank'),
    })).filter((l) => l.image.url || l.svg);
    if (!logos.length) return codeBlock(String(b.html || ''));
    // SHOW the brand names only for an icon / svg "trusted by" row — a mark beside VISIBLE text (`label`, or a non-image
    // mark with a name); an image logo carries the brand in its artwork, its name is alt text. PHP: n_logo_grid.
    const src = b.logos || [];
    const iconNamed = src.filter((l) => l && String(l.name || '').trim() && (l.label || !l.url)).length;
    const atts = { logos, design: 'grid', columns: String(Math.min(6, Math.max(2, logos.length))), grayscale: (b.grayscale === 'no' ? 'no' : 'yes'), show_labels: iconNamed >= Math.ceil(logos.length * 0.5) ? 'yes' : 'no' };
    // the SOURCE strip's treatment: mark height from the icon size, the inter-logo gap, the opacity dim as scoped CSS
    if (/^\d+$/.test(String(b.iconSize || '')) && +b.iconSize >= 12 && +b.iconSize <= 96) atts.logo_height = String(+b.iconSize);
    if (b.gap !== undefined && b.gap !== '') { const g = gapSlug(String(b.gap) + 'px'); if (g) atts.gap = g; }
    if (b.opacity !== undefined && b.opacity !== '' && +b.opacity > 0 && +b.opacity < 1) atts.custom_css = 'selector{opacity:' + (+b.opacity) + ';}';
    // the source ITEM's own gap / padding + label typography as scoped CSS (PHP: n_logo_grid item)
    if (b.item && typeof b.item === 'object') {
      const it = b.item, id = [], ld = [];
      if (it.gap > 0) id.push('gap:' + Math.round(it.gap) + 'px');
      if (it.pad && /^[0-9.px\s]+$/.test(String(it.pad))) id.push('padding:' + it.pad);
      if (it.fs) ld.push('font-size:' + it.fs); if (it.fw) ld.push('font-weight:' + it.fw); if (it.lh) ld.push('line-height:' + it.lh);
      const css = (id.length ? 'selector .fw-lg__item{' + id.join(';') + ';}' : '') + (ld.length ? 'selector .fw-lg__label{' + ld.join(';') + ';}' : '');
      if (css) atts.custom_css = ((atts.custom_css || '') + '\n' + css).trim();
    }
    return widgetNode('logo_grid', atts);
  };

  // A CTA band (centered heading + subtext + one button) → native `call_to_action`. Parity n_cta. The
  // source button's distinctive fill is reproduced on `.btn.btn-1` via the node's scoped custom_css.
  const ctaButtonCss = (b) => {
    const bg = String(b.buttonBg || '').trim();
    const fg = String(b.buttonColor || '').trim();
    let body = '';
    if (bg) body += `background-color:${bg} !important;border-color:${bg} !important;`;
    if (fg) body += `color:${fg} !important;`;
    if (b.buttonRadius) body += `border-radius:${b.buttonRadius};`;
    if (b.buttonPad) body += `padding:${b.buttonPad};`;
    return body ? `selector .btn.btn-1{${body}}` : '';
  };
  const ctaNode = (b) => {
    const atts = {
      title: String(b.title || '').trim(),
      message: String(b.message || ''),
      button_label: String(b.button_label || '').trim(),
      button_link: String(b.button_link || '#'),
      button_target: (b.button_target === '_blank' ? '_blank' : '_self'),
    };
    const css = ctaButtonCss(b);
    if (css) atts.custom_css = css;
    return widgetNode('call_to_action', atts);
  };

  // rgb/rgba computed value → hex (opaque) or kept rgba (transparent), for a native color att.
  const rgbToCss = (v) => {
    const m = String(v || '').match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (!m) return String(v || '');
    if (m[4] !== undefined && parseFloat(m[4]) < 1) return String(v); // keep translucency (e.g. bg-pink-100/40)
    const h = (n) => ('0' + (+n).toString(16)).slice(-2);
    return '#' + h(m[1]) + h(m[2]) + h(m[3]);
  };
  const px2slug = (px) => remToSlug(parseFloat(px) / 16); // px → rem → nearest spacing slug

  // Translate a section's Tailwind + captured COMPUTED style into NATIVE section options. bg + padding
  // come from the exact computed values (beats parsing `bg-pink-100/40` / `py-20`); layout/bg utility
  // classes are dropped from css_class (they're dead in the builder), unmapped classes are kept.
  const sectionLayout = (cls, computed, computedSm = null, phonePass = false, computedMd = null) => {
    computed = computed || {};
    const out = { bg: null, padding_top: null, padding_bottom: null, css_class: '' };
    const kept = [];
    for (const c of String(cls || '').split(/\s+/).filter(Boolean)) {
      if (/^(bg-|max-w-|min-w-|mx-|px-|py-|pt-|pb-|pl-|pr-|p-|w-full|relative|overflow-)/.test(c)) continue; // now native / structural
      if (/^(swiper|owl|slick|splide|carousel|aos|init|wow)/i.test(c)) continue;
      kept.push(c);
    }
    out.css_class = kept.join(' ');
    // Section background — the Section shortcode has NO `bg_color` option; its control is the
    // background-pro `background` att, which ALSO accepts the legacy `background_color` STRING and
    // migrates it (`section_migrate_legacy_background`). The old `bg_color` object was a DEAD key, so
    // a section/CTA with a solid background rendered with NO background — its light-on-dark text became
    // invisible white-on-light (the freshpaws CTA + footer bug). Emit the legacy string; migration renders it.
    if (computed.background) out.bg = rgbToCss(computed.background);
    // Vertical rhythm = padding + margin. The section shortcode expresses ALL of it as padding_top/bottom
    // (it has no margin option), so fold the section's own MARGIN into padding — otherwise a section that
    // separates itself with mt-24/mb-16 (margin, not padding) maps to padding_top:0 and the gap vanishes
    // ("no padding"). css `padding`/`margin` shorthand = "T R B L" (or 1/2 values); take T and B.
    const sides = (v) => { const p = String(v || '').split(/\s+/); return [ parseFloat(p[0]) || 0, parseFloat(p.length >= 3 ? p[2] : p[0]) || 0 ]; };
    const [pt, pb] = sides(computed.padding);
    const [mt, mb] = sides(computed.margin);
    const top = pt + mt, bottom = pb + mb;
    // Capture samples ONE (desktop) viewport, so a source's `lg:pt-48` (192px) would otherwise land in
    // the BASE layer and apply that huge padding at EVERY breakpoint (gappy on phones/tablets). Keep the
    // exact value on `lg` (desktop) and CLAMP the base layer so smaller screens aren't over-spaced.
    const BASE_CAP = 112; // px (~7rem) — beyond this a base padding reads as an empty gap on mobile
    const layer = (prefix, v) => { const b = Math.min(v, BASE_CAP); return { base: spacingToken(prefix, b), md: '', lg: b < v ? spacingToken(prefix, v) : '' }; };
    // PHONE PASS (capture-extract computedSm): when the source declares a different phone rhythm, the BASE tier is the
    // MEASURED phone value and desktop rides `lg` — no clamp guesswork. PHP parity: Pass #5 sectionCsSm.
    const smc = computedSm || null;
    // md = the TABLET pass value when it differs from the phone value (else it inherits the base tier).
    const mdc = computedMd || null;
    const mdTop = mdc ? (sides(mdc.padding || computed.padding)[0] + sides(mdc.margin || computed.margin)[0]) : null;
    const mdBot = mdc ? (sides(mdc.padding || computed.padding)[1] + sides(mdc.margin || computed.margin)[1]) : null;
    const layerSm = (prefix, v, vsm, vmd) => ({ base: spacingToken(prefix, vsm), md: (vmd != null && Math.abs(vmd - vsm) > 0.5) ? spacingToken(prefix, vmd) : '', lg: (Math.abs(vsm - v) > 0.5 || (vmd != null && Math.abs(vmd - v) > 0.5)) ? spacingToken(prefix, v) : '' }); // lg = desktop whenever a lower tier differs from it
    if (smc || mdc) {
      const [spt, spb] = sides((smc && smc.padding) || computed.padding); const [smt, smb] = sides((smc && smc.margin) || computed.margin);
      const stop = spt + smt, sbot = spb + smb;
      if (top > 0)    out.padding_top    = layerSm('pt', top, stop, mdTop);
      if (bottom > 0) out.padding_bottom = layerSm('pb', bottom, sbot, mdBot);
    } else if (phonePass) {
      // The phone pass ran and found NO difference: the desktop rhythm IS the phone rhythm — no clamp guesswork.
      if (top > 0)    out.padding_top    = { base: spacingToken('pt', top), md: '', lg: '' };
      if (bottom > 0) out.padding_bottom = { base: spacingToken('pb', bottom), md: '', lg: '' };
    } else {
      if (top > 0)    out.padding_top    = layer('pt', top);
      if (bottom > 0) out.padding_bottom = layer('pb', bottom);
    }
    // ZERO IS A VALUE: a computed padding of exactly 0px on a side (a `pt-0` band, a flush strip) → the explicit
    // zero token; an empty value falls back to the theme's default section padding. PHP parity (Pass #5).
    const padDecl = String(computed.padding || '').trim();
    if (padDecl !== '') {
      if (top <= 0 && pt === 0)    out.padding_top    = { base: 'pt-[0px]', md: '', lg: '' };
      if (bottom <= 0 && pb === 0) out.padding_bottom = { base: 'pb-[0px]', md: '', lg: '' };
    }
    return out;
  };

  // Build a section from decomposed blocks: consecutive intro blocks stack in a full-width
  // column; a `row` block becomes a row of builder columns (one code-block per grid cell).
  const blocksSectionNode = (sec, sIndex) => {
    const s = stamp(clone('section'));
    const centered = sectionCentered(sec);
    if (s.atts) {
      // Translate the section's Tailwind + captured COMPUTED style into NATIVE section options
      // (bg color, padding) instead of dead classes on css_class. The bg/padding come from the
      // captured computed values (exact — beats parsing `bg-pink-100/40` + `py-20`).
      const lay = sectionLayout(sec.sectionClass, sec.computed, sec.computedSm || null, !!((capture.home || capture).phonePass), sec.computedMd || null);
      // WIDE PASS (capture-extract computedXl): the >= 1536px padding when it differs → a min-width:1536px rule on the section
      // (the native rhythm has base / md / lg tiers only). PHP: Pass #5 sectionCsXl.
      if (sec.computedXl && sec.computedXl.padding && /^[0-9.]+px(?:\s+[0-9.]+px){0,3}$/.test(String(sec.computedXl.padding).trim())) {
        const pp = String(sec.computedXl.padding).trim().split(/\s+/); const top = parseFloat(pp[0]) || 0, bot = parseFloat(pp.length >= 3 ? pp[2] : pp[0]) || 0;
        lay.xlCss = '@media (min-width:1536px){selector{padding-top:' + Math.round(top) + 'px !important;padding-bottom:' + Math.round(bot) + 'px !important;}}';
      }
      s.atts.css_class = lay.css_class;
      if (lay.xlCss) s.atts.custom_css = ((s.atts.custom_css || '') + '\n' + lay.xlCss).trim(); // the >= 1536px rhythm (wide pass)
      // Pass #6 — carry a source band's responsive VISIBILITY onto the native responsive_hide option
      // (class-derived; {} for the common case). Parity with PHP Mapper::responsive_hide_from_classes.
      const rhide = responsiveHideFromClasses(sec.sectionClass);
      if (Object.keys(rhide).length) s.atts.responsive_hide = rhide;
      s.atts.is_fullwidth = false; // centred content uses the theme container (source `max-w-* mx-auto`)
      // Set the REAL background-pro custom color. The cloned section's default `background` att is a
      // non-empty bg-pro array, so view.php uses it and IGNORES the legacy `background_color` string
      // (the migration only runs when `background` is empty) — that's why solid section backgrounds
      // silently vanished (CTA/footer white-on-light invisible text). Write the nested custom hex.
      if (lay.bg && s.atts.background && s.atts.background.color && s.atts.background.color.value) {
        // Prefer LINKING a matching Section Style preset (variant); else set the native custom colour.
        if (!applyBandFill(s, lay.bg)) { s.atts.background.color.value.custom = lay.bg; }
      }
      if (lay.padding_top) s.atts.padding_top = lay.padding_top;
      if (lay.padding_bottom) s.atts.padding_bottom = lay.padding_bottom;
      // The band's OWN edge rules / shadow / radius (capture-extract sectionDiag: a `border-t border-white/5` band, a rounded
      // sheet) → the section's scoped CSS, then out of the drop diag (they are carried, not dropped). PHP: n_section band css.
      if (sec.diag && typeof sec.diag === 'object') {
        const dg = sec.diag; const d = [];
        for (const [k, prop] of [['borderTop', 'border-top'], ['borderBottom', 'border-bottom'], ['borderLeft', 'border-left'], ['borderRight', 'border-right'], ['boxShadow', 'box-shadow'], ['borderRadius', 'border-radius']]) {
          if (dg[k] && /^[a-z0-9#(),.%\s-]+$/i.test(String(dg[k]))) { d.push(prop + ':' + dg[k]); delete dg[k]; }
        }
        if (d.length) s.atts.custom_css = ((s.atts.custom_css || '') + String.fromCharCode(10) + 'selector{' + d.join(';') + ';}').trim();
      }
      // The section's COVERING VIDEO (capture-extract sec.bgVideo) → the native Background-Pro video, its scrim the
      // Background Overlay — the section decomposes around it instead of staying verbatim. PHP: apply_bg_video.
      if (sec.bgVideo && (sec.bgVideo.src || sec.bgVideo.webm) && s.atts.background) {
        const bv = sec.bgVideo;
        s.atts.background.video = { enabled: 'yes', external_url: '', source_mp4: bv.src ? { attachment_id: '', url: bv.src } : [], source_webm: bv.webm ? { attachment_id: '', url: bv.webm } : [], poster: bv.poster ? { attachment_id: '', url: bv.poster } : [], fallback: [], loop: 'yes', autoplay: 'yes', mute: 'yes', playsinline: 'yes', allow_interaction: 'no' };
        const ov = String(bv.overlay || '').trim();
        if (ov) {
          const grad = /gradient\(/i.test(ov) ? gradientToStops(ov) : null;
          if (grad) s.atts.background.overlay = { color: '', gradient: grad };
          else if (/^(rgba?\(|#|hsla?\()/i.test(ov)) s.atts.background.overlay = { color: ov, gradient: { type: 'linear', angle: 90, stops: [] } };
        }
        rec({ kind: 'element', sIndex, role: 'bg-video', detected: 'covering <video>', shortcode: 'section', why: 'covering video layer → the section Background video (+ its scrim as the overlay)' });
      }

      // A CENTERED source band → the section's native `text_align='center'` so the whole band's
      // heading + paragraph + buttons inherit text-align:center together (parity with PHP n_section).
      if (centered) s.atts.text_align = 'center';
      // Container Width — constrain the content band to the source's content cap (`max-w-* mx-auto` /
      // computed max-width) instead of always using the site-wide theme container. Parity with the PHP
      // n_section container_width; the flexbox content_width push below completes it for flex bands.
      const cwVal = containerWidthPreset(sectionContentMaxPx(sec));
      if (cwVal) s.atts.container_width = cwVal;
    }
    // Extra section CSS the block loop generates (e.g. a wc_products card skin/hover/ribbon translated
    // from the source cards). Folded into the section's custom_css AFTER the loop so it isn't lost.
    let extraCss = '';
    // NEVER-DROP hero alignment: a FULL-VIEWPORT-HEIGHT hero whose content is LEFT-aligned (not centered)
    // should sit LEFT-FLUSH like the source — not in the theme's auto-centered max-width column, which
    // parks the content mid-viewport (the "hero content is centered, not left" bug). Pin the container to
    // the left edge. Scoped to THIS section only (selector), so normal centered bands are unaffected.
    // Parity with PHP Mapper::hero_left_flush_css().
    if (!centered && /(?:^|\s)(?:min-)?h-(?:screen|\[100s?vh\])(?:\s|$)/.test(' ' + String(sec.sectionClass || '') + ' ')) {
      extraCss += 'selector .fw-container{margin-left:0 !important;margin-right:auto !important;}';
    }
    let items = []; let buf = []; let btnRow = [];
    const flush = () => {
      if (buf.length) {
        const col = column('1_1', buf);
        // The centered source wrapper that decomposes into this intro column holds MIXED children
        // (heading + paragraph + buttons) → set the column's native `text_align='center'` too, so
        // text-align cascades to all of them (parity with the PHP flush_buf). Idempotent with the
        // section text_align (both are the inherited property).
        if (centered && col.atts) col.atts.text_align = 'center';
        // A buffered FLOATING CARD (image-composite icon_box positioned `absolute` via its scoped posCss)
        // needs a POSITIONED ANCESTOR, or it anchors to the section/page and lands top-left. Make this
        // column the containing block. (P0-C fidelity fix; parity with the row-cell path + PHP mapper.)
        if (col.atts && buf.some((n) => n && n.shortcode === 'icon_box' && /position:absolute/.test(String((n.atts && n.atts.custom_css) || '')))) {
          const cur = col.atts.custom_css ? String(col.atts.custom_css) : '';
          col.atts.custom_css = (cur + (cur !== '' ? '\n' : '') + 'selector{position:relative;}').trim();
        }
        items.push(col); buf = [];
      }
    };
    for (const b of coalesceHeadingGroups(sec.blocks)) {
      if (b.t === 'row') {
        flush();
        // Pass #5 — distill the row's inter-column GAP onto the section's NATIVE Gap option (first grid
        // wins; empty = inherit the Theme Settings Default Gap). Parity with the PHP mapper build_section.
        if (s.atts && b.gap > 0 && (!s.atts.gap || !s.atts.gap.base)) {
          // Per-device Section Gap — base / md: / lg: each snap onto the (extended) Gap Scale, so a source
          // `gap-10 lg:gap-16` keeps 40px mobile + 64px desktop instead of one value. Parity with PHP.
          const gr = b.gapResp || {};
          const gBase = (gr.base > 0) ? gr.base : b.gap;
          const gs = gapSlug(gBase);
          if (gs) {
            let gMd = (gr.md > 0) ? gapSlug(gr.md) : '';
            let gLg = (gr.lg > 0) ? gapSlug(gr.lg) : '';
            if (gMd === gs) gMd = '';
            if (gLg === gs) gLg = '';
            s.atts.gap = { base: gs, md: gMd, lg: gLg };
          }
        }
        // A PRODUCT-CARD grid (≥60% of cells = image + price) → ONE wc_products grid, not N icon_boxes.
        const prodCells = b.cols.filter(cellIsProduct).length;
        if (b.cols.length >= 2 && prodCells >= Math.ceil(b.cols.length * 0.6)) {
          const cols = Math.max(2, Math.min(4, b.cols.length));
          // Translate the source cards' skin/hover + ribbon (captured on each product cell) into scoped
          // section CSS, and turn the Ribbon Badge slot ON when a badge was detected. A placeholder grid
          // can't carry the real per-product ribbon TEXT (that's product meta), but show_ribbon:'yes' +
          // the badge skin reproduce the look; the card hover-lift now renders instead of a flat card.
          const skinCell = b.cols.find((c) => c && (c.wrap || c.ribbon)) || {};
          const hasRibbon = b.cols.some((c) => c && c.ribbon);
          extraCss += wcCardCss(skinCell.wrap, hasRibbon ? skinCell.ribbon : null);
          items.push(column('1_1', [wcProductsNode(cols, b.cols.length, hasRibbon)]));
          rec({ kind: 'element', sIndex, role: 'products', detected: 'products', shortcode: 'wc_products',
                why: 'product-card grid → wc_products (configure Source to your products)', width: '1_1',
                text: snip(b.cols.map((c) => c.html).join(' ')), fallback: false, opportunity: true });
          continue;
        }
        for (const n of rowBlockToItems(b, sIndex)) items.push(n);
      } else {
        const node = blockToNode(b);
        rec({ kind: 'element', sIndex, role: b.t, detected: b.t, shortcode: node.shortcode || 'simple',
              why: b.t === 'newsletter' ? 'form → newsletter'
                 : b.t === 'heading' ? 'heading → special_heading'
                 : b.t === 'button' ? 'button → button'
                 : b.t === 'text' ? 'text → text_block'
                 : b.t === 'image' ? 'image → media_image'
                 : b.t === 'video' ? 'video → media_video (' + (b.mode === 'embed' ? 'oEmbed URL' : 'self-hosted') + ')'
                 : b.t === 'testimonials' ? 'testimonials → testimonials'
                 : (node.shortcode || '') !== 'code_block' ? `${b.t} → ${node.type === 'flexbox' ? 'flexbox (native div)' : (node.shortcode || node.type)}` + (b.decor ? ' — decor layer (its paint carried)' : '')
                 : `${b.t} → code_block (unmapped)`,
              sourceTag: b.tag || '', sourceClass: b.cls || '', text: snip(b.text || b.label || b.html),
              textFull: snipFull(b.text || b.label || b.html), html: rawCap(b.html || ''),
              fallback: (node.shortcode || '') === 'code_block',
              opportunity: (node.shortcode || '') === 'code_block' && ['testimonials', 'card', 'counter'].indexOf(b.t) !== -1 });
        // A source button GROUP that lays out as a flex-ROW (sm:flex-row) → collect the buttons into ONE
        // row column (side-by-side, auto-width), instead of the default stacked full-width column.
        if (b.t === 'button' && b.groupRow) {
          if (b.groupFirst) { flush(); btnRow = []; }
          btnRow.push(node);
          if (b.groupLast) {
            const rc = column('1_1', btnRow);
            if (rc.atts) { rc.atts.content_direction = 'row'; rc.atts.content_gap = { base: '3', md: '', lg: '' }; rc.atts.content_h = 'start'; }
            items.push(rc); btnRow = [];
          }
        } else {
          buf.push(node);
        }
      }
    }
    flush();
    // A DECORATIVE full-bleed backdrop (an `absolute inset-0` layer with oversized `w-[800px]` blobs)
    // overflows the viewport BY DESIGN — the source clips it with the section's own `overflow:hidden`.
    // The decomposed section doesn't inherit that, so the blobs push the page width out and cause a
    // horizontal scrollbar. Re-assert the source's clip: a section carrying a decor block is made
    // `position:relative; overflow:hidden` so the backdrop clips at the section edges, like the source.
    const decorIn = (blocks) => (blocks || []).some((b) => b.decor || (b.t === 'row' && (b.cols || []).some((c) => (c.blocks || []).some((x) => x.decor))));
    const hasDecor = decorIn(coalesceHeadingGroups(sec.blocks || []));
    // Fold the section's carried CSS + any block-generated CSS (wc_products card skin/hover/ribbon)
    // into Advanced → Custom CSS, so section-scoped skin travels with the section.
    // A section with a decorative backdrop is made position:relative (so the backdrop's inset:0 anchors
    // to it) + isolation:isolate (a stacking context so the backdrop's z-index:-10 stays BEHIND the
    // content but IN FRONT of the section's own background, not sliding behind the whole page) +
    // overflow:hidden (clip an oversized backdrop at the section edges, like the source).
    const clipCss = hasDecor ? 'selector{position:relative !important;overflow:hidden !important;isolation:isolate !important;}' : '';
    // Re-assert carried `max-width`/`max-height` with `!important` so a source sizing utility (`.max-w-lg`
    // on the hero image, 0,1,0) beats the theme/plugin element resets it collides with — `img{max-width:
    // 100%}` and especially `.woocommerce img{max-width:100%}` (0,1,1) — which otherwise render a
    // decomposed image full-width instead of its source cap. The mirror path wins this via `.sc-tw`
    // scoping; a decomposed section's carried CSS is global, so importantify (source intent; still
    // responsive — `w-full` keeps it fluid below the cap). Skips declarations already `!important`.
    const importantifyMaxSize = (css) => String(css || '').replace(/\b(?:max-width|max-height)\s*:\s*[^;}!]+(?![^;}]*!important)/gi, (m) => m.replace(/\s+$/, '') + ' !important');
    const carried = importantifyMaxSize((sec.css && sec.css.trim()) ? sec.css : '');
    // Re-emit @keyframes for any Tailwind animation the section USES (a verbatim badge's `animate-bounce`,
    // etc.) but the per-section CSS harvest dropped — else `animation-name` is set with no frames to run.
    const kf = missingKeyframes(String(sec.rawHtml || '') + ' ' + carried);
    const allCss = carried + (extraCss ? ('\n' + extraCss) : '') + (clipCss ? ('\n' + clipCss) : '') + kf;
    if (s.atts && allCss.trim()) s.atts.custom_css = flattenCss(allCss);
    // SECTION-LEVEL ROW → flexbox. flexifyItems() previously only ran on rows NESTED inside a section;
    // a section that is ITSELF the row (direct children = ≥2 clean columns — a hero's text+image, a
    // 2-up/3-up feature band) stayed section → [column, column] (classic bootstrap fw-row/fw-col). Run
    // the section's own items through the SAME flexify pass so those section-as-row bands emit a flexbox
    // Div (fw-flex) too. A run that doesn't qualify falls back to columns; a single column is untouched.
    // Twin of the PHP mapper's section-level flexify_items() call. The content_width push below then
    // keeps the new band constrained.
    items = flexifyItems(items);
    s._items = items.length ? items : [column('1_1', [codeBlock(sec.rawHtml || '')])];
    // HOIST a chip pinned via the native Position option OUT of the band's content wrapper to be a direct child of
    // the section: the theme positions every direct child of a media band, so a chip left inside would measure its
    // percentages against the content block, not the band. The SECTION becomes the anchor (Position: relative); the
    // chip's auto container is freed from that theme rule (scoped by the chip's unique class), and the chip paints
    // above the band's media / overlay (z:2). Parity with PHP Mapper::anchor_abs_overlays().
    {
      const hoisted = [];
      const isPinned = (n) => n && n.atts && n.atts.element_position && n.atts.element_position.position === 'absolute';
      for (const it of s._items) {
        if (!it || !Array.isArray(it._items)) continue;
        for (const ch of it._items.slice()) {
          if (isPinned(ch)) { hoisted.push(ch); it._items.splice(it._items.indexOf(ch), 1); continue; }
          if (ch && Array.isArray(ch._items)) { for (const gc of ch._items.slice()) { if (isPinned(gc)) { hoisted.push(gc); ch._items.splice(ch._items.indexOf(gc), 1); } } }
        }
      }
      if (hoisted.length && s.atts) {
        const rules = [];
        for (const gc of hoisted) {
          if (!gc.atts.element_position.absolute.element_zindex) gc.atts.element_position.absolute.element_zindex = '2';
          const u8 = String(gc.atts.unique_id || '').replace(/[^a-z0-9]/gi, '').slice(0, 8);
          if (u8) rules.push('selector > .fw-container:has(.u' + u8 + '){position:static !important;}');
        }
        s._items.push(...hoisted);
        if (!s.atts.element_position || !s.atts.element_position.position || s.atts.element_position.position === 'default') s.atts.element_position = { position: 'relative' };
        s.atts.custom_css = ((s.atts.custom_css || '') + '\n' + [...new Set(rules)].join('')).trim();
      }
    }
    // Push the section's container_width cap onto any DIRECT flexbox child's content_width — a flexbox
    // escapes the section's .fw-container (rendered full-width), so it needs its own cap to stay centred
    // at the source's max-width. Parity with the PHP mapper's flexbox content_width push.
    {
      const cwPx = containerWidthPx(s.atts && s.atts.container_width);
      if (cwPx > 0 && Array.isArray(s._items)) {
        const cwVal = contentWidthValue(cwPx);
        for (const ch of s._items) {
          if (!ch || ch.type !== 'flexbox' || !ch.atts) continue;
          // Already carries a real cap (legacy {value}, or the multi-picker's own preset/custom)? Leave it.
          const ex = ch.atts.content_width;
          const hasCw = ex && typeof ex === 'object' && (ex.value
            || (ex.custom && ex.custom.custom_width && ex.custom.custom_width.value)
            || (ex.preset && ex.preset !== 'inherit'));
          if (hasCw) continue;
          ch.atts.content_width = cwVal;
        }
      }
    }
    return s;
  };

  // Verbatim section. The source root's CLASS is hoisted onto the builder <section> and its
  // INNER html goes in the code-block — so there's no nested <section>, and CSS scoped to inner
  // wrappers (e.g. `.banner .block h1`) still matches. `.sc-mirror` resets the builder
  // container/column gutters so the source markup renders edge-to-edge.
  const mirrorSectionNode = (sec, sIndex) => {
    const s = stamp(clone('section'));
    if (s.atts) {
      s.atts.css_class = 'sc-mirror';
      s.atts.is_fullwidth = true;
      // The verbatim source section owns 100% of its OWN vertical spacing (its py-/mb- classes ride
      // inside the code-block), so zero the builder section's default padding (64px top/bottom) — it
      // renders with id-specificity (.uXXXX{…}) that the .sc-mirror CSS reset can't beat, so the
      // page would otherwise grow ~128px taller per mirror section.
      s.atts.padding_top = '0px';
      s.atts.padding_bottom = '0px';
      if (sec.css && sec.css.trim()) s.atts.custom_css = sec.css;
    }
    // Prefer the source section's OUTER html (its own `<section class="…flex items-center text-center
    // max-w-[1280px] mx-auto…">`) so its self-layout classes (flex/grid centering, max-width
    // container) wrap its children DIRECTLY. Hoisting the class onto the builder <section> + using
    // the INNER html instead breaks that centering, because the builder interposes
    // .fw-container/.fw-row/.fw-col between the section and its content (the heading went left + the
    // buttons stretched full-width). A nested <section> is harmless under the `.sc-mirror` reset.
    // Fall back to inner html + hoisted class for older captures that lack rawHtml.
    let html;
    if (sec.rawHtml) {
      html = sec.rawHtml;
    } else {
      html = sec.rawInner || '';
      const srcCls = String(sec.sectionClass || '').split(/\s+/).filter((c) => c && !/^(swiper|owl|slick|splide|carousel|aos|init|wow)/i.test(c));
      s.atts.css_class = ['sc-mirror'].concat(srcCls).join(' ');
    }
    rec({ kind: 'element', sIndex, role: 'verbatim', detected: 'section-html', shortcode: 'code_block',
          why: 'whole section kept verbatim (hero / media-bearing / undecomposable) → code_block',
          sourceClass: sec.sectionClass || '', text: snip(html), textFull: snipFull(html), html: rawCap(html),
          fallback: true, opportunity: false });
    s._items = [column('1_1', [codeBlock(html)])];
    return s;
  };

  // A detected slider section → the editable `carousel` shortcode. Slides carry image /
  // heading / text / button. Heuristics pick the layout: image-only slides read as a logo
  // strip (multi-per-view, no arrows/dots); slides with a heading+button+image read as a hero
  // (background image, text overlaid); everything else is a 1-up content slider.
  const carouselNode = (slider) => {
    const slides = slider.slides;
    const hasText = slides.some((s) => s.heading || s.text || (s.button && s.button.label));
    const isLogo  = !hasText;
    const isHero  = hasText && slides.some((s) => s.button && s.button.label && s.image);
    const perPage = isLogo ? Math.min(slides.length, 5) : 1;
    return {
      type: 'simple', shortcode: 'carousel', _items: [],
      atts: {
        slides: slides.map((s) => ({
          image: { url: s.image || '' },
          image_mode: isHero ? 'background' : 'inline',
          heading: s.heading || '',
          text: s.text || '',
          button_label: (s.button && s.button.label) || '',
          button_link: (s.button && localize(s.button.href)) || '#',
          link: '',
          content_align: 'center',
        })),
        per_page: String(perPage),
        per_page_tablet: String(isLogo ? Math.min(slides.length, 3) : 1),
        per_page_mobile: isLogo ? '2' : '1',
        gap: isLogo ? '2rem' : '1rem',
        height: isHero ? '80vh' : '',
        arrows: isLogo ? 'no' : 'yes',
        pagination: isLogo ? 'no' : 'yes',
        autoplay: 'yes', interval: '5000', speed: '600',
        pause_hover: 'yes', loop: 'yes', drag: 'yes', effect: 'slide',
        overlay: isHero ? 'yes' : 'no', overlay_opacity: 45,
        unique_id: uid(),
      },
    };
  };
  // Slider section → builder section (carries the source section's bg/padding via its class +
  // custom_css) → optional heading code-block + the carousel shortcode.
  const sliderSectionNode = (sec, sIndex) => {
    const items = [];
    if (sec.slider.heading) {
      rec({ kind: 'element', sIndex, role: 'slider-heading', detected: 'heading', shortcode: 'code_block',
            why: 'slider heading → code_block', text: snip(sec.slider.heading), fallback: true, opportunity: false });
      items.push(codeBlock(`<h2 class="sc-slider-heading">${sec.slider.heading}</h2>`));
    }
    rec({ kind: 'element', sIndex, role: 'slider', detected: 'carousel', shortcode: 'carousel',
          why: `slider → carousel (${(sec.slider.slides || []).length} slides)`, fallback: false, opportunity: false });
    items.push(carouselNode(sec.slider));
    const s = stamp(clone('section'));
    if (s.atts) {
      const srcCls = String(sec.sectionClass || '').split(/\s+/).filter((c) => c && !/^(swiper|owl|slick|splide|carousel|aos|init)/i.test(c));
      // Centered .fw-container (not full-width / sc-mirror) — matches the source's .container.
      s.atts.css_class = srcCls.join(' ');
      s.atts.is_fullwidth = false;
      if (sec.css && sec.css.trim()) s.atts.custom_css = flattenCss(sec.css);
    }
    s._items = [column('1_1', items)];
    return s;
  };

  // No-rawHtml fallback (older captures / a section the capture couldn't snapshot): dump its
  // heading + paragraphs + buttons + lead image as one column of plain text-blocks.
  const headingTitle = (sec) => (sec.headingHtml && sec.headingHtml.trim()) ? sec.headingHtml : esc(sec.heading || '');
  const buildPlain = (sec, sIndex) => {
    rec({ kind: 'element', sIndex, role: 'plain', detected: 'no-rawhtml', shortcode: 'text_block',
          why: 'no rawHtml captured → heading/paragraphs as plain text blocks',
          sourceClass: sec.sectionClass || '', text: snip(sec.heading || ''), fallback: false, opportunity: false });
    const items = [];
    if (sec.heading) {
      const lvl = sec.level >= 1 && sec.level <= 6 ? sec.level : 2;
      items.push(textBlock(`<h${lvl}>${headingTitle(sec)}</h${lvl}>`));
    }
    const seen = new Set();
    for (const p of (sec.paragraphs || []).slice(sec.heading ? 1 : 0)) {
      const t = (p || '').trim(); const k = t.toLowerCase();
      if (t && !seen.has(k)) { seen.add(k); items.push(textBlock(`<p>${esc(t)}</p>`)); }
    }
    for (const b of (sec.buttons || [])) {
      if ((b.label || '').trim()) items.push(textBlock(`<p><a href="${esc(b.href || '#')}">${esc(b.label.trim())}</a></p>`));
    }
    if ((sec.images || []).length) items.push(textBlock(`<figure><img src="${esc(sec.images[0])}" alt="" loading="lazy"></figure>`));
    return items.length ? (() => { const s = stamp(clone('section')); if (s.atts) s.atts.css_class = ''; s._items = [column('1_1', items)]; return s; })() : null;
  };

  const builder = [];
  let patternsApplied = 0;
  let dividersApplied = 0;
  (capture.sections || []).forEach((sec, sIndex) => {
    let node, decision;
    const hasRaw = !!(sec.rawHtml || sec.rawInner);
    // Fidelity guard: decomposition only emits heading / text / button / grid-cell shortcodes, so
    // a section whose visual MEDIA (images, CSS background-images) isn't inside a grid `row` would
    // have that media DROPPED when decomposed — exactly what gutted the Auralis hero (its waveform
    // card vanished, heading got re-styled by special_heading). Keep such sections — and, in
    // --fidelity mode, EVERY raw-captured section — VERBATIM so the source markup + layout (which
    // carry at ~100% CSS coverage) survive intact, edge-to-edge under the `.sc-mirror` reset.
    const hasMedia = (sec.assets || []).length > 0;
    // A `row` grid OR a `testimonials` collection is a CLEAN decomposition — don't force the whole
    // (media-bearing) section to verbatim just because it also carries avatars/images.
    // …a `gallery` counts too: the photos ARE the gallery block, so decomposing drops nothing (before this a
    // photo grid kept the whole band verbatim and the native Gallery element never appeared).
    const hasRow = (sec.blocks || []).some((b) => b.t === 'row' || b.t === 'testimonials' || b.t === 'gallery');
    const preferVerbatim = hasRaw && (opts.fidelity === true || (hasMedia && !hasRow));
    if (sec.slider && sec.slider.slides && sec.slider.slides.length >= 2) {
      decision = 'carousel'; node = sliderSectionNode(sec, sIndex);     // editable carousel shortcode
    } else if (preferVerbatim) {
      decision = 'verbatim'; node = mirrorSectionNode(sec, sIndex);     // preserve design (media-bearing / --fidelity) — keep source markup
    } else if (sec.blocks && sec.blocks.length) {
      decision = 'decomposed'; node = blocksSectionNode(sec, sIndex);   // special_heading / text_block / button + grid columns
    } else if (hasRaw) {
      decision = 'verbatim'; node = mirrorSectionNode(sec, sIndex);     // verbatim (hero / undecomposable) — no nested <section>
    } else {
      decision = 'plain'; node = buildPlain(sec, sIndex);
    }
    // Carry the source section's own id (`<section id="hero">`) onto the builder section's CSS ID, so
    // the source's in-page anchor links (nav → #hero, smooth-scroll) still resolve. `stamp()` cleared it
    // on the cloned atom; set it here after the node is built, for every section-decision path.
    if (node && node.atts && sec.sectionId) {
      // slug_from_id parity (PHP Stitch::slug_from_id): lowercase → [a-z0-9-] → collapse/trim dashes, so
      // an anchor id like "Our Services" / "sec:pricing" still yields a clean css_id the source's in-page
      // links resolve to (was gated to a strict identifier, which dropped ids the PHP path keeps).
      const cid = String(sec.sectionId).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
      if (cid) node.atts.css_id = cid;
    }
    // APPLY a captured background PATTERN (findPattern → the Background Patterns library) as a decorative
    // overlay BEHIND this section's content, so the section actually SHOWS its pattern (the library entry
    // alone doesn't render). Inline CSS — the source's `bg-[url('data:…')]` Tailwind arbitrary is dead on WP.
    // The section is made the positioned ancestor + isolate so the z-index:-10 overlay stays within it.
    if (node && sec.bgPattern && sec.bgPattern.image && sec.bgPattern.image !== 'none') {
      // Apply via the section's NATIVE Background Pattern OPTION (a registered preset), NOT an inline code_block
      // overlay. The id is derived from the image so it agrees with to-presets' backgroundPatterns() (which
      // registers the preset from the same capture.sections). The section view renders the pattern layer from
      // the preset — nothing hardcoded into the page markup. Parity with PHP apply_section_pattern.
      node.atts = node.atts || {};
      node.atts.background_pattern = { pattern: patternPresetId(sec.bgPattern.image) };
      patternsApplied++;
    }
    // Apply a detected SHAPE DIVIDER to the section's native divider option (parity with PHP apply_section_divider).
    if (node && node.atts && sec.divider && ['wave', 'tilt', 'curve', 'triangle'].includes(sec.divider.shape)) {
      const dv = sec.divider;
      const sub = {
        color: dv.color ? { predefined: '', custom: dv.color } : { predefined: '', custom: '' },
        height: { value: dv.height || '100', unit: 'px' },
        flip: dv.flip === 'yes' ? 'yes' : 'no',
      };
      node.atts[dv.placement === 'top' ? 'divider_top' : 'divider_bottom'] = { shape: dv.shape, [dv.shape]: sub };
      dividersApplied++;
    }
    // Apply detected ambient background layers → stacked bg_effect slots (parity with PHP
    // apply_section_bg_effects). leaves+sakura already de-duped to one petals layer on the extract side.
    if (node && node.atts && Array.isArray(sec.bgEffects) && sec.bgEffects.length) {
      let bi = 1;
      for (const spec of sec.bgEffects) {
        const effect = spec && spec.effect ? String(spec.effect) : '';
        if (!effect) continue;
        const val = { effect };
        // The `snow` engine (petals/embers/ash/snow) carries its look in a `variant` sub-option.
        if (effect === 'snow' && spec.variant) val.snow = { variant: String(spec.variant) };
        node.atts[bi === 1 ? 'bg_effect' : 'bg_effect__' + bi] = val;
        bi++;
      }
    }
    rec({ kind: 'section', sIndex, decision, sourceClass: sec.sectionClass || '',
          hasCss: !!(sec.css && sec.css.trim()), computed: sec.computed || {}, diag: sec.diag || {},
          height: sec.h || 0, assets: (sec.assets || []).length, blocks: (sec.blocks || sec.mapBlocks || []).length });
    if (node) builder.push(node);
  });

  // Post-process: a column holding an absolute overlay (a position:absolute code_block — e.g. a translated
  // `-top-4 -right-4` corner badge) must be the positioned ancestor, or it anchors to the section/page and
  // drifts far away. Mark the nearest containing column position:relative. Parity with PHP anchor_abs_overlays().
  const anchorAbs = (n) => {
    if (!n || typeof n !== 'object') return;
    const items = Array.isArray(n._items) ? n._items : [];
    if (n.type === 'column' && items.some((ch) => ch && ch.shortcode === 'code_block' && /position:absolute/.test(String((ch.atts && ch.atts.code) || '')))) {
      n.atts = n.atts || {};
      const cur = n.atts.custom_css ? String(n.atts.custom_css) : '';
      if (!/position:relative/.test(cur)) n.atts.custom_css = (cur + (cur ? '\n' : '') + 'selector{position:relative;}').trim();
    }
    for (const ch of items) anchorAbs(ch);
  };
  builder.forEach(anchorAbs);

  // Bind every emitted colour to the PALETTE this conversion generated. MIRROR of PHP
  // Stitch::bind_palette_colors — see its docblock for the reasoning and the four guards. The palette
  // arrives through opts because it is built in to-presets, not here.
  bindPaletteColors(builder, opts.palette);

  return {
    pages: [{ title: 'Home', slug: 'home', status: 'publish', front_page: true, builder,
      // The native per-page Hide switches for chrome the source doesn't render (no <footer> → hide_site_footer). PHP: chrome_page_options.
      page_options: Object.assign({}, (capture.home || capture).footer ? {} : { hide_site_footer: 'yes' }, ((capture.home || capture).header || (capture.home || capture).nav) ? {} : { hide_site_header: 'yes' }) }],
    patternsApplied,
    dividersApplied,
    css: '', // styling comes from the captured used-CSS shipped with the theme (raw_chrome.css)
  };
}
