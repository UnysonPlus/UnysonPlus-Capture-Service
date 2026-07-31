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

  const textBlock = (html) => {
    const n = stamp(clone('text_block'));
    n.atts.text = html;
    n.atts.css_class = '';
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
  const codeBlock = (html) => ({ type: 'simple', shortcode: 'code_block', _items: [], atts: { code: html, unique_id: uid() } });

  // Decomposed leaves → dedicated, editable shortcodes (intro-only): a heading → special_heading,
  // a paragraph → text_block, a CTA → button. Everything else stays a code-block (incl. each grid
  // cell). The source section class is carried onto the builder section so descendant CSS
  // (`.section h2`, `.section .speaker-item`) still styles the extracted/verbatim content.
  // Tailwind max-w scale → rem, for block_max_width (arbitrary max-w-[Npx|rem|…] handled inline).
  const TW_MAXW = { sm: 24, md: 28, lg: 32, xl: 36, '2xl': 42, '3xl': 48, '4xl': 56, '5xl': 64, '6xl': 72, '7xl': 80 };
  const emptySpacing = () => ({ margin: { all: '', top: '', right: '', bottom: '', left: '' }, padding: { all: '', top: '', right: '', bottom: '', left: '' }, advanced: [] });

  const headingNode = (b) => {
    const n = stamp(clone('special_heading'));
    n.atts.title = b.html;
    n.atts.subtitle = b.subtitle || '';
    n.atts.overline = b.overline || '';
    n.atts.overline_container = b.overlinePill ? 'pill' : '';
    n.atts.heading = 'h' + (b.level >= 1 && b.level <= 6 ? b.level : 2);
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
      else if ((m = c.match(/^mb-(\d+(?:\.\d+)?)$/))) {
        if (!n.atts.spacing || typeof n.atts.spacing !== 'object') { n.atts.spacing = emptySpacing(); }
        n.atts.spacing.margin.bottom = (parseFloat(m[1]) * 0.25) + 'rem';
      }
      else { kept.push(c); }
    }
    n.atts.alignment = align;
    n.atts.css_class = kept.join(' ');
    if (n.atts.overline_color) n.atts.overline_color = { predefined: '', custom: '' };
    return n;
  };
  const buttonBlockNode = (b) => ({ type: 'simple', shortcode: 'button', _items: [], atts: { label: b.label, link: localize(b.href), target: 'no', unique_id: uid() } });

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
  const mediaImageNode = (b) => ({ type: 'simple', shortcode: 'media_image', _items: [], atts: {
    image: { attachment_id: '', url: b.src || '', alt: b.alt || '' },
    width: { value: '', unit: 'px' }, height: { value: '', unit: 'px' },
    fetchpriority: 'auto', link: '', target: '_self', unique_id: uid(),
  } });

  const blockToNode = (b) => (b.t === 'heading' ? headingNode(b) : b.t === 'button' ? buttonBlockNode(b) : b.t === 'overline' ? textBlock(b.html) : b.t === 'text' ? textBlock(b.html) : b.t === 'image' ? mediaImageNode(b) : b.t === 'video' ? videoNode(b) : b.t === 'testimonials' ? testimonialsNode(b.items) : codeBlock(b.html));

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
        out.pop();
      }
      const next = blocks[i + 1];
      const inGroup = !!h.overline || !!b.wrapCls;
      if (inGroup && next && next.t === 'text') {
        // Subtitle = the paragraph's INNER content (strip a single outer <p>), parity with textBlockOf.
        h.subtitle = String(next.html || '').replace(/^\s*<p[^>]*>([\s\S]*)<\/p>\s*$/i, '$1');
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
    a.css_class = '';
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

  // Build a section from decomposed blocks: consecutive intro blocks stack in a full-width
  // column; a `row` block becomes a row of builder columns (one code-block per grid cell).
  const blocksSectionNode = (sec, sIndex) => {
    const s = stamp(clone('section'));
    const srcCls = String(sec.sectionClass || '').split(/\s+/).filter((c) => c && !/^(swiper|owl|slick|splide|carousel|aos|init|wow)/i.test(c));
    if (s.atts) {
      // Centered .fw-container (not full-width / sc-mirror) — the extracted content has no
      // source .container of its own, so match the source's .container width.
      s.atts.css_class = srcCls.join(' ');
      s.atts.is_fullwidth = false;
      if (sec.css && sec.css.trim()) s.atts.custom_css = flattenCss(sec.css);
    }
    const items = []; let buf = [];
    const flush = () => { if (buf.length) { items.push(column('1_1', buf)); buf = []; } };
    for (const b of coalesceHeadingGroups(sec.blocks)) {
      if (b.t === 'row') {
        flush();
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
            detected = 'blocks'; why = 'content column → decomposed shortcodes'; cellItems = coalesceHeadingGroups(c.blocks).map(blockToNode);
          } else if (c.image) {
            detected = 'image'; why = 'image cell → media_image'; cellItems = [mediaImageNode(c.image)];
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
        buf.push(node);
      }
    }
    flush();
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
