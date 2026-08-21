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
import { sectionStyles } from './to-presets.mjs';
import { buildButtonPresets } from './to-theme-settings.mjs';

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
  const _btnPresets = (() => {
    let bp = opts.buttonPresets || null;
    if (!bp) { try { bp = buildButtonPresets(capture.home || capture); } catch { bp = null; } }
    const colors = []; const sizes = [];
    const seen = {};
    for (const c of ((bp && bp.button_colors) || [])) {
      let slug = String(c.color_name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      if (!slug) slug = String(c.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!slug) continue;
      const base = slug; let n = 1; while (seen[slug]) { n++; slug = base + '-' + n; } seen[slug] = true;
      const def = (c.states && c.states.default) || {};
      const pick = (f) => (def[f] && (def[f].custom || def[f].predefined)) || '';
      const bg = _rgb(pick('bg_color')); const fg = _rgb(pick('text_color')); const bd = _rgb(pick('border_color'));
      colors.push({ slug, role: String(c.color_name || '').toLowerCase(), bg, fg, bd });
    }
    for (const s of ((bp && bp.button_sizes) || [])) {
      if (!s || !s.slug) continue;
      const num = (f) => (s[f] && s[f].value !== '' && s[f].value != null ? parseFloat(s[f].value) : null);
      sizes.push({ slug: String(s.slug).toLowerCase().replace(/[^a-z0-9_-]/g, ''), fs: num('font_size'), py: num('padding_y'), px: num('padding_x') });
    }
    return { colors, sizes };
  })();
  const _pxNum = (v) => { const m = String(v == null ? '' : v).trim().match(/^(-?[0-9.]+)\s*px?$/i); return m ? parseFloat(m[1]) : null; };
  const _matchBtnColor = (bg, fg, bd) => {
    if (!_btnPresets.colors.length) return '';
    const dist = (a, b) => (a && b ? Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) : null);
    let best = '', bestd = Infinity;
    for (const p of _btnPresets.colors) {
      let d;
      if (bg && p.bg) { d = dist(bg, p.bg); const dt = dist(fg, p.fg); if (dt != null) d += Math.round(dt / 3); }
      else if (!bg && !p.bg) { if (!bd) continue; d = dist(bd, p.bd); if (d == null) continue; }
      else continue;
      if (d < bestd) { bestd = d; best = p.slug; }
    }
    return bestd <= 40 ? best : '';
  };
  const _buttonPresetFor = (b) => {
    const out = { style: '', size: '' };
    if (!_btnPresets.colors.length && !_btnPresets.sizes.length) return out;
    const lc = ' ' + String(b.cls || '').toLowerCase() + ' ';
    const bs = b.bs || {};
    // COLOR — semantic fill class → the role's preset; else match computed colours.
    let role = '';
    if (/\s(?:btn-primary|bg-primary|bg-brand)\b/.test(lc)) role = 'primary';
    else if (/\s(?:btn-secondary|bg-secondary|bg-accent|bg-cta)\b/.test(lc)) role = 'secondary';
    else if ((/\sbg-white\b/.test(lc) || /\sbg-surface\b/.test(lc)) && /\sborder\b/.test(lc)) role = 'outline';
    let style = '';
    if (role) { const p = _btnPresets.colors.find((x) => x.role === role); if (p) style = 'btn-' + p.slug; }
    if (!style) {
      const bg = _rgb(bs.bg); const fg = _rgb(bs.fg);
      // a border only counts with a real width
      const bd = (bs.bw && bs.bw !== '0px' && bs.bw !== '0' && bs.bds && bs.bds !== 'none') ? _rgb(bs.bd) : null;
      if (bg || bd) { const slug = _matchBtnColor(bg, fg, bd); if (slug) style = 'btn-' + slug; }
    }
    out.style = style;
    // SIZE — explicit btn-lg/md/sm, else match computed font-size + padding.
    let size = '';
    const m = lc.match(/\sbtn-(lg|md|sm|xl|xs)\b/);
    if (m && _btnPresets.sizes.some((s) => s.slug === m[1])) size = m[1];
    if (!size) {
      const fs = _pxNum(b.fontSize || b.fs);
      let py = null, px = null;
      const pp = String(b.pad || '').trim().split(/\s+/).map(_pxNum);
      if (pp.length) { py = pp[0]; px = pp.length >= 2 ? pp[1] : pp[0]; }
      if (fs != null) {
        for (const s of _btnPresets.sizes) {
          if (s.fs == null || Math.abs(s.fs - fs) > 1) continue;
          if (py != null && s.py != null && Math.abs(s.py - py) > 3) continue;
          if (px != null && s.px != null && Math.abs(s.px - px) > 4) continue;
          size = s.slug; break;
        }
      }
    }
    out.size = size ? 'btn-' + size : '';
    return out;
  };

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
    if (s) {
      const clean = (v) => String(v || '').trim();
      if (/^rgb/i.test(clean(s.color))) { n.atts.text_color = { predefined: '', custom: rgbToCss(s.color) }; }
      // TEXT STYLE preset — match the block's OWN computed font-size to the nearest BODY preset (Lead/
      // Subtitle/Small/Caption) so the text references an editable preset CLASS instead of a frozen px.
      // Base (16) / no match within tolerance → '' (Default). MIRROR of PHP n_text. When a preset IS
      // assigned, the redundant `font-size` decl below is dropped so the editable preset owns the size.
      const fsm = clean(s.fontSize).match(/^([0-9.]+)px$/);
      fontSizePreset = fsm ? textPresetFor(parseFloat(fsm[1])) : '';
      n.atts.font_size_preset = fontSizePreset;
      const d = [];
      // PASS #2 NATIVE STRUCTURE PROMOTION — horizontal alignment → the text_block's NATIVE, editable
      // `text_align` option (a Bootstrap `text-*` class on the wrapper — node-scoped, never body-wide)
      // instead of a scoped `selector{text-align}` rule. Parity with the PHP n_text promotion. `justify`
      // has no native alignment option, so it stays on the scoped custom CSS.
      const ta = clean(s.textAlign);
      if (/^(center|right)$/.test(ta)) { n.atts.text_align = ta; }
      else if (ta === 'justify') { d.push('text-align:justify'); }
      const fs = clean(s.fontSize); if (fs && fs !== '16px' && !fontSizePreset) d.push('font-size:' + fs);
      const lh = clean(s.lineHeight); if (lh && lh !== 'normal') d.push('line-height:' + lh);
      const ls = clean(s.letterSpacing); if (ls && ls !== 'normal') d.push('letter-spacing:' + ls);
      const fw = parseInt(s.fontWeight, 10) || 0; if (fw >= 600) d.push('font-weight:' + fw);
      const tt = clean(s.textTransform); if (tt && tt !== 'none') d.push('text-transform:' + tt);
      const mb = clean(s.marginBottom); if (mb && mb !== '0px') d.push('margin-bottom:' + mb + ' !important');
      if (d.length) { n.atts.custom_css = 'selector{' + d.map((x) => x.replace(/[{}<>;]/g, '')).join(';') + ';}'; }
    }
    // HI-FI Pass-2 faithful base — text_block has no native spacing slot, so its vertical margins + the
    // font/color/line-height the unified styler re-asserts are `already`; the base fills the rest (font-weight,
    // letter-spacing, text-transform, background, border, …). Parity with PHP text builder.
    if (hifiCss && s) {
      // FONT-SIZE single source of truth (parity with PHP text builder): the faithful base NEVER emits
      // font-size — when a Text Style preset is assigned the preset owns the size, and when none is
      // assigned the `selector{font-size:…}` custom_css above already carries the faithful px fallback.
      // (Previously the `fontSizePreset ? filter-out : keep` was INVERTED, re-emitting font-size in the
      // base exactly when a preset already owned it → a double-applied size.)
      const props = ['font-family', 'font-size', 'line-height', 'color', 'text-align', 'margin-top', 'margin-bottom'];
      applyHifiBase(n, csFromFields(s), props, hifiCss);
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
    const scale = [[4, '1'], [8, '2'], [16, '3'], [24, '4'], [48, '5']];
    let best = scale[0];
    for (const s of scale) { if (Math.abs(s[0] - px) < Math.abs(best[0] - px)) best = s; }
    return best[1];
  };
  // The verbatim section HTML goes into a `code-block` (raw, un-processed output — the
  // universal fallback for anything we don't yet map to a dedicated shortcode). The section's
  // own CSS rides in the section's Advanced → Custom CSS (`custom_css`), so it travels with
  // the section, renders late (wins the cascade over the plugin's framework CSS) and stays
  // editable. Source selectors pass through the aggregator unchanged (only the literal token
  // `selector` is rewritten), so the rules target the verbatim markup's source classes.
  const codeBlock = (html) => {
    html = String(html == null ? '' : html);
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
      // would balloon to display-5 (the "Why Pets Love FreshPaws" 36px→48px bug). Beyond the tolerance,
      // reproduce the EXACT size instead of promoting it to a display preset.
      if (Math.abs(best[0] - hpx) <= 7) { n.atts.display_size = best[1]; }
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
    // Re-assert the SOURCE font-weight (any 100–900) so it beats the shortcode's
    // `hN.heading-title{font-weight:var(--hN-font-weight, revert)}` = the UA BOLD default — a source
    // heading at 400 (regular) otherwise renders bold. Scoped `.uHASH .heading-title` (0,2,0) wins.
    // Parity with PHP heading_weight_css() re-asserting from the computed style.
    const hw = parseInt(b.fontWeight, 10) || 0;
    if (hw >= 100 && hw <= 900) td.push('font-weight:' + hw);
    // line-height needs custom_css when the display preset out-specificities the class OR the source used
    // an arbitrary `leading-[…]` (dropped as mangle-prone above, so its effect must come from here).
    const lh = _clean(b.lineHeight); if (lh && lh !== 'normal' && (n.atts.display_size || clsHasArbLeading)) td.push('line-height:' + lh);
    const mb = _clean(b.marginBottom); if (mb && mb !== '0px') td.push('margin-bottom:' + mb);
    const mt = _clean(b.marginTop); if (mt && mt !== '0px') td.push('margin-top:' + mt);
    measureDecls(b.cls, td); // title's own max-w-* mx-auto (never-drop)
    const rules = [];
    if (td.length) { rules.push('selector .heading-title{' + td.map((d) => d.replace(/[{}<>;]/g, '') + ' !important').join(';') + ';}'); }
    // Subtitle tier-3: its size / colour classes are routinely mangle-prone (`md:text-xl`, `text-…/70`) and
    // there's no native subtitle size/colour option, so reproduce the computed font-size / colour /
    // line-height. Only emitted for non-default values; the sanitizer-safe subtitle classes still ride
    // `subtitle_class` for editability.
    const ss = b.subtitleStyle || {};
    const sd = [];
    const sfs = _clean(ss.fontSize); if (sfs && sfs !== '16px') sd.push('font-size:' + sfs);
    const slh = _clean(ss.lineHeight); if (slh && slh !== 'normal') sd.push('line-height:' + slh);
    if (/^rgb/i.test(_clean(ss.color))) sd.push('color:' + rgbToCss(ss.color));
    measureDecls(b.subtitleCls, sd); // subtitle's own max-w-* mx-auto (never-drop) — the max-w-2xl case
    if (sd.length) { rules.push('selector .heading-subtitle{' + sd.map((d) => d.replace(/[{}<>;]/g, '') + ' !important').join(';') + ';}'); }
    // NEVER-DROP overline typography: the overline has native casing/colour/align + weight, but NO native
    // font-size or letter-spacing option. A source eyebrow like `text-[11px] tracking-[0.3em] uppercase`
    // lost its 11px size + 0.3em tracking (mangle-prone classes dropped), rendering in the theme default —
    // the "overline looks different" bug. Carry the computed size + tracking as scoped .heading-overline CSS.
    // Parity with PHP overline_typography_css.
    if (b.overline && String(b.overline).trim() !== '') {
      const od = [];
      const ofs = _clean(b.overlineFontSize); if (ofs) od.push('font-size:' + ofs);
      const ols = _clean(b.overlineLetterSpacing); if (ols && ols !== 'normal') od.push('letter-spacing:' + ols);
      if (od.length) { rules.push('selector .heading-overline{' + od.map((d) => d.replace(/[{}<>;]/g, '') + ' !important').join(';') + ';}'); }
    }
    // NO subtitle: reset the theme's default hN bottom margin (never reset by the shortcode) so it doesn't
    // leak as the block's below-gap and dominate the source-derived outer Margin & Padding (e.g. a 48px h1
    // default over a 24px source). The outer `spacing` option then IS the faithful gap. Parity with PHP n_heading.
    // WITH a subtitle, the title→subtitle gap is the title's own `mb-*` (e.g. mb-8 = 32px). The coarse
    // element_spacing select below rounds it to a theme default (much larger than the source), so carry the
    // EXACT px here as scoped .heading-title CSS — never-drop, reproduced faithfully. Parity with PHP n_heading.
    if (!(b.subtitle && String(b.subtitle).trim() !== '')) {
      rules.push('selector .heading-title{margin-bottom:0 !important;}');
    } else {
      // Prefer the title's COMPUTED bottom margin (survives class stripping — `mb-8` is removed from the
      // class), falling back to an `mb-*` still on the class. Parity with PHP cs_margin_bottom_px.
      const _mbc = _clean(b.marginBottom);
      let _tmbPx = /^([0-9.]+)px$/.test(_mbc) ? Math.round(parseFloat(_mbc)) : 0;
      if (!_tmbPx) { const _tmb = String(b.cls || '').match(/\bmb-(\d+(?:\.\d+)?)\b/); _tmbPx = _tmb ? Math.round(parseFloat(_tmb[1]) * 4) : 0; }
      if (_tmbPx > 0) { rules.push('selector .heading-title{margin-bottom:' + _tmbPx + 'px !important;}'); }
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
    return n;
  };
  // Classify a captured button by its RESOLVED look (parity with the PHP mapper's button_style_class):
  // an opaque fill → primary; a transparent/white fill with a border → outline; else a bare fill.
  const buttonKindClasses = (b) => {
    const cls = ' ' + String(b.cls || '').toLowerCase() + ' ';
    const bg = String((b.bs && b.bs.bg) || '');
    const opaque = /rgba?\([^)]*(?:,\s*(?:0?\.[1-9]|1)\s*)?\)/.test(bg) && !/rgba?\([^)]*,\s*0\s*\)/.test(bg) && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)';
    const white = /rgb\(255,\s*255,\s*255\)/.test(bg) || /\sbg-white\s/.test(cls);
    const hasBorder = (b.bs && b.bs.bd && b.bs.bds && b.bs.bds !== 'none') || /\sborder\b/.test(cls);
    if (opaque && !white) return 'primary';
    if (white || hasBorder) return 'outline';
    return opaque ? 'fill' : 'link';
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
    if (b.pad) { decl.push('padding:' + String(b.pad).replace(/[{}<>;]/g, '') + ' !important'); }
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
    const node = { type: 'simple', shortcode: 'button', _items: [], atts: {
      label: b.label, link: localize(b.href), target: 'no',
      style: _btnStyle, size: preset.size, icon, icon_position: (b.iconPos === 'before' ? 'before' : 'after'),
      alignment: btnAlign, state: '', hover_animation: '', css_class: (_btnStyle ? _clsBase : cls), custom_css, unique_id: uid(),
    } };
    // HI-FI Pass-2 faithful base — the color/size preset + the sc-btn class + the per-node safety-net CSS
    // already reproduce the fill / text / border / radius / typography (`already`); the base only fills
    // leftover appearance (a gradient background-image, opacity, transform, …). Parity with PHP button builder.
    if (hifiCss) {
      const bs = b.bs || {};
      const bcs = csFromFields(Object.assign({}, b, {
        bg: bs.bg, color: bs.fg,
        border: (bs.bw && bs.bw !== '0px' && bs.bds && bs.bds !== 'none') ? (bs.bw + ' ' + bs.bds + ' ' + bs.bd) : undefined,
      }));
      applyHifiBase(node, bcs, ['background-color', 'color', 'border', 'border-radius', 'box-shadow', 'font-family', 'font-size', 'font-weight', 'letter-spacing', 'text-transform'], hifiCss);
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
        controls: b.controls || 'yes', playsinline: b.playsinline || 'yes', preload: 'metadata', object_fit: 'contain',
      },
    };
    if (st.self_hosted.autoplay === 'yes') st.self_hosted.muted = 'yes';
    return { type: 'simple', shortcode: 'media_video', _items: [], atts: { source_type: st, width: { value: 600, unit: 'px' }, ratio: '16x9', unique_id: uid() } };
  };

  // A standalone image → the native media_image element (NOT a gallery — that's for multiple
  // images — and NOT a code_block). Mirrors PHP Mapper::n_media_image(); the importer sideloads src.
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
    if (b.borderWidth && b.borderColor) decl.push(`border:${b.borderWidth} solid ${b.borderColor}`);
    if (b.shadow) decl.push(`box-shadow:${b.shadow}`);
    let custom_css = decl.length ? `selector img{${decl.join(';')};}` : '';
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
  // True when a grid cell looks like a product card: an image + a price token (+ usually a CTA).
  const cellIsProduct = (c) => /<img/i.test(String(c.html || '')) && /(?:\$|€|£)\s?\d+[.,]\d{2}/.test(String(c.html || ''));

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
  const decorNode = (html) => codeBlock('<div style="position:absolute;inset:0;z-index:-10;pointer-events:none;overflow:hidden">' + String(html || '') + '</div>');
  // Enable the source reveal animation on a node's Animations tab — ONLY for the standard
  // { enable, yes:{effect} } shape (heading/text/button/image/counter/testimonials/icon_box). A node
  // without that shape (the interactive widgets built inline) is left at its default, mirroring the PHP
  // apply_block_anim (whose interactive-widget multi-picker effect vocabulary is the animation-engine
  // registry, not animate.css). No `b.anim` → untouched (no false motion).
  const applyAnim = (node, b) => {
    if (node && b && b.anim && node.atts && node.atts.animation && typeof node.atts.animation === 'object' && 'enable' in node.atts.animation) {
      node.atts.animation = { ...node.atts.animation, enable: 'yes', yes: { ...(node.atts.animation.yes || {}), effect: b.anim } };
    }
    return node;
  };
  const blockToNode = (b) => applyAnim(_blockToNode(b), b);
  const _blockToNode = (b) => (b.decor ? decorNode(b.html) : b.t === 'heading' ? headingNode(b) : b.t === 'button' ? buttonBlockNode(b) : b.t === 'overline' ? textBlock(b.html, { color: b.color, textAlign: b.align, textTransform: b.textTransform }) : b.t === 'text' ? textBlock(b.html, b) : b.t === 'image' ? mediaImageNode(b) : b.t === 'video' ? videoNode(b) : b.t === 'testimonials' ? testimonialsNode(b.items) : b.t === 'rating' ? ratingRowNode(b) : b.t === 'table' ? tableNode(b) : b.t === 'accordion' ? accordionNode(b) : b.t === 'feature_list' ? featureListNode(b) : b.t === 'tabs' ? tabsNode(b) : b.t === 'steps' ? stepsNode(b) : b.t === 'timeline' ? timelineNode(b) : b.t === 'progress' ? progressNode(b) : b.t === 'pricing' ? pricingNode(b) : b.t === 'lottie' ? lottieNode(b) : b.t === 'svg_draw' ? svgDrawNode(b) : b.t === 'logo_grid' ? logoGridNode(b) : b.t === 'cta' ? ctaNode(b) : codeBlock(b.html));

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
    const html = String((b && (b.html || b.text)) || '');
    if (/<(ul|ol|h[1-6]|table|blockquote|figure|hr|div)\b/i.test(html)) return false;
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
      if (prev && (prev.t === 'overline' || (prev.t === 'text' && prev.text && prev.text.length <= 48 && prev.text === prev.text.toUpperCase()))) {
        h.overline = prev.html || prev.text || '';
        h.overlinePill = !!prev.pill || /rounded-full|pill/i.test(prev.cls || '');
        if (prev.color) h.overlineColor = prev.color; // the pill's text colour → native overline_color
        h.overlineTransform = prev.textTransform || '';   // css text-transform → overline_uppercase
        h.overlineText = prev.text || '';                 // plain text, for the all-caps heuristic
        if (prev.iconSvg) { h.overlineIcon = prev.iconSvg; h.overlineIconPos = prev.iconPos || 'before'; }
        h.overlineCls = prev.cls || '';                   // overline's own classes → native overline_class
        h.overlineFontSize = prev.fontSize || '';         // NEVER-DROP: no native overline size option → scoped CSS
        h.overlineLetterSpacing = (prev.letterSpacing && prev.letterSpacing !== 'normal') ? prev.letterSpacing : '';
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
        h.subtitleStyle = { fontSize: next.fontSize || '', color: next.color || '', lineHeight: next.lineHeight || '' };
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
  const counterFont = (weight, size) => ({
    google_font: false, subset: false, variation: false, family: '', style: 'normal',
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
    if (/^#[0-9a-f]{3,8}$/i.test(ibc)) { a.icon_badge_color = { predefined: '', custom: ibc }; }
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
      iconLayout: fc.iconLayout || 'inline-left', align: 'left',
    };
    const n = iconBoxNode(card);
    const pos = floatingCardPosCss(fc.pos);
    if (n.atts && pos) { n.atts.custom_css = (n.atts.custom_css ? n.atts.custom_css + '\n' : '') + pos; }
    return n;
  };
  // A testimonials collection → the editable `testimonials` shortcode (parity with PHP
  // n_testimonials). Each detected item carries quote/name/position/image/site/rating.
  const testimonialsNode = (rows) => {
    const n = stamp(clone('testimonials'));
    const a = n.atts;
    a.testimonials = (rows || []).map((r) => {
      const hasRating = r.rating != null && r.rating !== '';
      return {
        content: String(r.quote || ''),
        author_avatar: { attachment_id: '', url: String(r.image || '') },
        author_name: String(r.name || ''),
        author_job: String(r.position || ''),
        site_name: String(r.siteName || ''),
        site_url: String(r.siteUrl || ''),
        rating: hasRating ? Number(r.rating) : 5,
      };
    });
    a.title = '';
    a.container_type = 'container';
    a.text_align = 'text-center';
    a.avatar_shape = 'rounded-circle';
    a.avatar_size = 'avatar-lg';
    a.show_rating = 'yes';
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
    a.number_font = counterFont(c.numberWeight, c.numberSize);
    a.number_color = counterColor(c.numberColor);
    a.prefix_font = counterFont(c.numberWeight, '24');
    a.suffix_font = counterFont(c.suffixWeight || c.numberWeight, c.suffixSize);
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

  // A <table> → native `table` (tabular render). Leading all-<th> rows → header_rows (<thead>). Parity
  // with n_table. NOTE: the Table Preset slug is chosen PHP-side (reads the WP preset library), which the
  // capture service can't see, so `table_preset` is left unset here (the style evidence rides on the block).
  const tableNode = (b) => {
    const rows = Array.isArray(b.rows) ? b.rows : [];
    let ncol = 0; for (const r of rows) if (Array.isArray(r)) ncol = Math.max(ncol, r.length);
    if (ncol < 1 || !rows.length) return codeBlock('');
    const cols = []; for (let c = 0; c < ncol; c++) cols.push({ name: 'default-col', align: '', width: '' });
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
    return widgetNode('table', atts);
  };

  // An accordion/FAQ toggle group → native `accordion`; each item → one `tabs` row. Parity n_accordion.
  const accordionNode = (b) => {
    const src = Array.isArray(b.items) ? b.items : [];
    const tabs = [];
    for (const it of src) { const title = String(it.title || '').trim(); if (!title) continue; tabs.push({ tab_title: title, tab_content: String(it.content || ''), is_open: 'no' }); }
    if (!tabs.length) return codeBlock('');
    return widgetNode('accordion', { tabs });
  };

  // A <ul>/<ol> → native `feature_list` (<ul> check, <ol> numbered). Parity n_feature_list.
  const featureListNode = (b) => {
    const src = Array.isArray(b.items) ? b.items : [];
    const items = [];
    for (const r of src) { const text = String(r.text || '').trim(); if (!text) continue; items.push({ text, subtext: '', value_text: '', icon: iconNone(), marker_color: { predefined: '', custom: '' }, state: 'on', link_url: '', link_target: '_self' }); }
    if (!items.length) return codeBlock('');
    return widgetNode('feature_list', { items, design: b.ordered ? 'numbered' : 'check' });
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
  const stepsNode = (b) => {
    const src = Array.isArray(b.items) ? b.items : [];
    const steps = [];
    for (const it of src) { const title = String(it.title || '').trim(); if (!title) continue; steps.push({ title, content: String(it.content || ''), icon: iconNone(), number: String(it.number || '') }); }
    if (steps.length < 2) return codeBlock('');
    return widgetNode('steps', { steps });
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
    return widgetNode('logo_grid', { logos, design: 'grid', columns: String(Math.min(6, Math.max(2, logos.length))), grayscale: 'yes', show_labels: 'no' });
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
  const sectionLayout = (cls, computed) => {
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
    if (top > 0)    out.padding_top    = layer('pt', top);
    if (bottom > 0) out.padding_bottom = layer('pb', bottom);
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
      const lay = sectionLayout(sec.sectionClass, sec.computed);
      s.atts.css_class = lay.css_class;
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
      // A CENTERED source band → the section's native `text_align='center'` so the whole band's
      // heading + paragraph + buttons inherit text-align:center together (parity with PHP n_section).
      if (centered) s.atts.text_align = 'center';
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
    const items = []; let buf = []; let btnRow = [];
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
          const gs = gapSlug(b.gap);
          if (gs) s.atts.gap = { base: gs, md: '', lg: '' };
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
        for (const c of b.cols) {
          // Map each grid cell to a dedicated, editable shortcode using the role the extractor
          // already detected (parity with the PHP mapper). A cell with plain text (but no media /
          // structure) → editable text_block rather than an opaque code_block; a truly EMPTY /
          // decorative cell is DROPPED (no column emitted). Only a media/structural blob stays verbatim.
          const cInner = String(c.html || '');
          const cPlain = cInner.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
          const cMedia = /<(img|svg|video|iframe|picture|canvas|input|button|select|textarea)\b/i.test(cInner);
          if (!c.counter && !c.card && !(c.buttons && c.buttons.length) && !c.text && !c.grid && !cPlain && !cMedia) { continue; } // drop empty / decorative cell
          let detected, cellItems, why;
          if (c.counter) {
            detected = 'counter'; why = 'counter → counter shortcode';
            cellItems = [counterNode(c.counter)];
            const lbl = String(c.counter.label || '').trim();
            if (lbl) { cellItems.push(textBlock('<p>' + esc(lbl) + '</p>')); }
          } else if (c.card) {
            detected = 'card'; why = 'card → icon_box'; cellItems = [iconBoxNode(c.card)];
          } else if (c.buttons && c.buttons.length) {
            detected = 'buttons'; why = 'button group → button(s)';
            cellItems = c.buttons.map((bt) => buttonBlockNode(bt));
          } else if (c.text) {
            detected = 'text'; why = 'text cell → text_block'; cellItems = [textBlock(c.html)];
          } else if (c.blocks && c.blocks.length) {
            detected = 'blocks'; why = 'content column → decomposed shortcodes'; cellItems = blocksToNodes(c.blocks);
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
          const sc = cellItems[0].shortcode || 'simple';
          rec({ kind: 'element', sIndex, role: 'row-cell', detected, shortcode: sc, why, width: c.width,
                sourceClass: c.cls || '', text: snip(c.html), textFull: snipFull(c.html), html: rawCap(c.html),
                fallback: sc === 'code_block', opportunity: false });
          const col = column(c.width, cellItems);
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
            if (decl.length && col.atts) {
              const cur = col.atts.custom_css ? String(col.atts.custom_css) : '';
              col.atts.custom_css = (cur + (cur !== '' ? '\n' : '') + 'selector{' + decl.join(';') + ';}').trim();
            }
          }
          // Replay the cell's OWN flex layout via the column's NATIVE options (content_direction / gap)
          // instead of a CSS wrapper — a flex-ROW cell lays its children side-by-side with the source gap.
          const fx = c.flex;
          if (fx && /^row/.test(fx.dir || '') && col.atts) {
            col.atts.content_direction = 'row';
            const g = gapSlug(fx.gap);
            if (g) col.atts.content_gap = { base: g, md: '', lg: '' };
            if (/^row-reverse/.test(fx.dir)) col.atts.content_order = 'reverse';
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
          items.push(col);
        }
      } else {
        const node = blockToNode(b);
        rec({ kind: 'element', sIndex, role: b.t, detected: b.t, shortcode: node.shortcode || 'simple',
              why: b.t === 'heading' ? 'heading → special_heading'
                 : b.t === 'button' ? 'button → button'
                 : b.t === 'text' ? 'text → text_block'
                 : b.t === 'image' ? 'image → media_image'
                 : b.t === 'video' ? 'video → media_video (' + (b.mode === 'embed' ? 'oEmbed URL' : 'self-hosted') + ')'
                 : b.t === 'testimonials' ? 'testimonials → testimonials'
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
    s._items = items.length ? items : [column('1_1', [codeBlock(sec.rawHtml || '')])];
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
    const hasRow = (sec.blocks || []).some((b) => b.t === 'row' || b.t === 'testimonials');
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
    rec({ kind: 'section', sIndex, decision, sourceClass: sec.sectionClass || '',
          hasCss: !!(sec.css && sec.css.trim()), computed: sec.computed || {}, diag: sec.diag || {},
          height: sec.h || 0, assets: (sec.assets || []).length, blocks: (sec.blocks || sec.mapBlocks || []).length });
    if (node) builder.push(node);
  });

  return {
    pages: [{ title: 'Home', slug: 'home', status: 'publish', front_page: true, builder }],
    css: '', // styling comes from the captured used-CSS shipped with the theme (raw_chrome.css)
  };
}
