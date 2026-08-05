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

export function toPages(capture, opts = {}) {
  const atoms = opts.atoms || defaultAtoms();
  const clone = (k) => structuredClone(atoms[k]);
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
    if (s) {
      const clean = (v) => String(v || '').trim();
      if (/^rgb/i.test(clean(s.color))) { n.atts.text_color = { predefined: '', custom: rgbToCss(s.color) }; }
      const d = [];
      const ta = clean(s.textAlign); if (/^(center|right|justify)$/.test(ta)) d.push('text-align:' + ta);
      const fs = clean(s.fontSize); if (fs && fs !== '16px') d.push('font-size:' + fs);
      const lh = clean(s.lineHeight); if (lh && lh !== 'normal') d.push('line-height:' + lh);
      const ls = clean(s.letterSpacing); if (ls && ls !== 'normal') d.push('letter-spacing:' + ls);
      const fw = parseInt(s.fontWeight, 10) || 0; if (fw >= 600) d.push('font-weight:' + fw);
      const tt = clean(s.textTransform); if (tt && tt !== 'none') d.push('text-transform:' + tt);
      const mb = clean(s.marginBottom); if (mb && mb !== '0px') d.push('margin-bottom:' + mb + ' !important');
      if (d.length) { n.atts.custom_css = 'selector{' + d.map((x) => x.replace(/[{}<>;]/g, '')).join(';') + ';}'; }
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

  const headingNode = (b) => {
    const n = stamp(clone('special_heading'));
    n.atts.title = b.html;
    n.atts.subtitle = b.subtitle || '';
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
    n.atts.subtitle_class = routeClass(b.subtitleCls, false); // no native subtitle colour/size option → keep text-*
    // LAST-RESORT Custom CSS — ONLY effects a carried class can't deliver:
    //   • the title's own vertical MARGINS (no native option AND the mb-*/mt-* class collides), and
    //   • WEIGHT + LINE-HEIGHT when a display preset is set — the preset emits at `:root .display-N`
    //     (0,2,0), which outranks a plain carried class like `.font-extrabold` / `.leading-[1.1]` (0,1,0),
    //     so those two need the `!important` a class can't carry. Without a display preset the carried
    //     classes win on their own and neither is emitted here.
    // Uses the captured COMPUTED values. font-family + letter-spacing ride the class (no preset conflict).
    const clsHasArbLeading = /leading-\[/.test(String(b.cls || ''));
    const td = [];
    // A heading whose size didn't match a display preset (e.g. a 36px section heading) → reproduce its
    // exact font-size here rather than promoting it to the nearest (too-large) display preset.
    if (exactHeadingSize) td.push('font-size:' + exactHeadingSize);
    const hw = parseInt(b.fontWeight, 10) || 0;
    if (hw >= 800 && n.atts.display_size) td.push('font-weight:' + hw);
    // line-height needs custom_css when the display preset out-specificities the class OR the source used
    // an arbitrary `leading-[…]` (dropped as mangle-prone above, so its effect must come from here).
    const lh = _clean(b.lineHeight); if (lh && lh !== 'normal' && (n.atts.display_size || clsHasArbLeading)) td.push('line-height:' + lh);
    const mb = _clean(b.marginBottom); if (mb && mb !== '0px') td.push('margin-bottom:' + mb);
    const mt = _clean(b.marginTop); if (mt && mt !== '0px') td.push('margin-top:' + mt);
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
    if (sd.length) { rules.push('selector .heading-subtitle{' + sd.map((d) => d.replace(/[{}<>;]/g, '') + ' !important').join(';') + ';}'); }
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
    const cls = [stripSpacingUtils(b.cls), 'sc-btn-' + kind].filter(Boolean).join(' ').trim();
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
    const custom_css = 'selector{' + decl.map((d) => d.replace(/[{}<>;]/g, '')).join(';') + ';}';
    // A STANDALONE button carries its own horizontal alignment (a centred CTA button under a `text-center`
    // block reads `text-align:center`). Grouped buttons (a hero flex-row) are positioned by their row
    // column instead (content_direction/content_h), so leave those at default to avoid wrapping each in a
    // centring div that would break the side-by-side layout.
    const btnAlign = (!b.groupRow && /^(center|right)$/.test(String(b.align || ''))) ? b.align : '';
    return { type: 'simple', shortcode: 'button', _items: [], atts: {
      label: b.label, link: localize(b.href), target: 'no',
      style: '', size: '', icon, icon_position: (b.iconPos === 'before' ? 'before' : 'after'),
      alignment: btnAlign, state: '', hover_animation: '', css_class: cls, custom_css, unique_id: uid(),
    } };
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
    if (b.radius) decl.push(`border-radius:${b.radius}`);
    if (b.objectFit) decl.push(`object-fit:${b.objectFit}`);
    if (b.shadow) decl.push(`box-shadow:${b.shadow}`);
    const custom_css = decl.length ? `selector img{${decl.join(';')};}` : '';
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
  const blockToNode = (b) => (b.decor ? decorNode(b.html) : b.t === 'heading' ? headingNode(b) : b.t === 'button' ? buttonBlockNode(b) : b.t === 'overline' ? textBlock(b.html, { color: b.color, textAlign: b.align, textTransform: b.textTransform }) : b.t === 'text' ? textBlock(b.html, b) : b.t === 'image' ? mediaImageNode(b) : b.t === 'video' ? videoNode(b) : b.t === 'testimonials' ? testimonialsNode(b.items) : b.t === 'rating' ? ratingRowNode(b) : codeBlock(b.html));

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
        out.pop();
      }
      const next = blocks[i + 1];
      const inGroup = !!h.overline || !!b.wrapCls;
      if (inGroup && next && next.t === 'text') {
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
    if (s.atts) {
      // Translate the section's Tailwind + captured COMPUTED style into NATIVE section options
      // (bg color, padding) instead of dead classes on css_class. The bg/padding come from the
      // captured computed values (exact — beats parsing `bg-pink-100/40` + `py-20`).
      const lay = sectionLayout(sec.sectionClass, sec.computed);
      s.atts.css_class = lay.css_class;
      s.atts.is_fullwidth = false; // centred content uses the theme container (source `max-w-* mx-auto`)
      // Set the REAL background-pro custom color. The cloned section's default `background` att is a
      // non-empty bg-pro array, so view.php uses it and IGNORES the legacy `background_color` string
      // (the migration only runs when `background` is empty) — that's why solid section backgrounds
      // silently vanished (CTA/footer white-on-light invisible text). Write the nested custom hex.
      if (lay.bg && s.atts.background && s.atts.background.color && s.atts.background.color.value) {
        s.atts.background.color.value.custom = lay.bg;
      }
      if (lay.padding_top) s.atts.padding_top = lay.padding_top;
      if (lay.padding_bottom) s.atts.padding_bottom = lay.padding_bottom;
    }
    // Extra section CSS the block loop generates (e.g. a wc_products card skin/hover/ribbon translated
    // from the source cards). Folded into the section's custom_css AFTER the loop so it isn't lost.
    let extraCss = '';
    const items = []; let buf = []; let btnRow = [];
    const flush = () => { if (buf.length) { items.push(column('1_1', buf)); buf = []; } };
    for (const b of coalesceHeadingGroups(sec.blocks)) {
      if (b.t === 'row') {
        flush();
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
          } else if (c.imgComposite) {
            // Image + a content-bearing overlay (a floating badge / decorative blob). Kept VERBATIM, but
            // WRAPPED in a positioned container that carries the source cell's own classes (`relative
            // lg:h-[600px] flex …`) + an inline `position:relative` — otherwise the absolute overlays
            // (`inset-0` blob, `top-10 -left-6` badge) lose their anchor when the cell becomes a code_block
            // inside a builder column and fly to the section corner / balloon full-bleed. code_block html
            // is NOT class-sanitized, so the source classes (incl. `lg:h-[600px]`, `blob-shape`) survive.
            detected = 'image-composite';
            why = 'image + content overlay → verbatim in a positioned wrapper (overlays anchor to the image)';
            // Rebuild the cell's OWN wrapper with its FULL class list (relative / flex / items-center /
            // justify-center / lg:h-[600px] …) so the image centres and the `inset-0` blob fills the cell,
            // exactly like the source — `c.cls` (col-* only) left it class-less. code_block html isn't
            // class-sanitized, so responsive/arbitrary classes (`lg:h-[600px]`) survive. `width:100%`:
            // the builder column is `d-flex flex-row`, so without it the wrapper is a flex item that
            // SHRINKS to the image (512px) instead of filling the column — the image then can't centre and
            // the blob can't span the column.
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
          // Replay the cell's OWN flex layout via the column's NATIVE options (content_direction / gap)
          // instead of a CSS wrapper — a flex-ROW cell lays its children side-by-side with the source gap.
          const fx = c.flex;
          if (fx && /^row/.test(fx.dir || '') && col.atts) {
            col.atts.content_direction = 'row';
            const g = gapSlug(fx.gap);
            if (g) col.atts.content_gap = { base: g, md: '', lg: '' };
            if (/^row-reverse/.test(fx.dir)) col.atts.content_order = 'reverse';
          }
          // A CTA button group with 2+ buttons sits side-by-side — via the native content_direction
          // (not the old `.btn-row` CSS wrapper), even when the source cell's flex wasn't captured.
          if (detected === 'buttons' && cellItems.length > 1 && col.atts) {
            col.atts.content_direction = 'row';
            if (!(col.atts.content_gap && col.atts.content_gap.base)) {
              col.atts.content_gap = { base: gapSlug((c.flex && c.flex.gap) || '') || '3', md: '', lg: '' };
            }
            col.atts.content_h = 'center';
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
    if (node && node.atts && sec.sectionId && /^[A-Za-z][\w-]*$/.test(String(sec.sectionId))) {
      node.atts.css_id = String(sec.sectionId);
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
