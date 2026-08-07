// Chrome → parent-theme Theme Settings (`theme-settings.json`) — the URL-path MIRROR of the PHP
// FW_Site_Converter_Stitch::tokens_to_theme_settings_chrome(). The playbook's "chrome = theme,
// not page content" model: emit the source header/footer as native Header/Footer Theme-Settings
// values so the converted site runs on a NEAR-EMPTY child theme (Template: unysonplus-theme, no
// header.php/footer.php) instead of a baked one.
//
// The plugin's FW_Site_Converter_Theme_Settings::import() writes each id via
// fw_set_db_settings_option (overlay). Value shapes mirror the gold reference
// (unysonplus-website/wordpress/demos/anime-header-footer.php) EXACTLY:
//   header_logo   = { site_title, title_weight, color:{predefined,custom}, tagline,
//                     logo_icon:{type,svg-source,svg-id}, logo_icon_position, logo_icon_color }
//   header_main   = { main_left|center|right:[ element_type nodes ] }
//   header_menu   = { menu_link_color, menu_link_hover_color }
//   header_layout = { header_mode, header_behavior, header_glass, bg_color, … }
//   footer_background = background-pro { color:{ value:{predefined,custom} } }   (NOT compact color)
//   copyright_settings = { enabled, yes:{ copyright_columns:{ count:'1', '1':{ copyright_col_1 } } } }
//
// KEEP IN SYNC with the PHP emitter (see CONVERSION-ALGORITHM-SYNC.md).

const hex = (h) => ({ predefined: '', custom: String(h || '') });
const el = (type, settings) => {
  const et = { element: type };
  if (settings && typeof settings === 'object') et[type] = settings;
  return { element_type: et };
};

// A social URL host → Lucide icon id (mirror of the PHP social_lucide()). '' if not a known network.
function socialLucide(url) {
  let host = '';
  try { host = new URL(url).host.toLowerCase(); } catch { host = ''; }
  const map = {
    twitter: 'lucide/twitter', 'x.com': 'lucide/twitter', facebook: 'lucide/facebook',
    instagram: 'lucide/instagram', linkedin: 'lucide/linkedin', youtube: 'lucide/youtube',
    github: 'lucide/github', discord: 'lucide/message-circle', dribbble: 'lucide/dribbble',
    twitch: 'lucide/twitch', tiktok: 'lucide/music', pinterest: 'lucide/image',
    telegram: 'lucide/send', 't.me': 'lucide/send', whatsapp: 'lucide/message-circle',
    slack: 'lucide/slack', mastodon: 'lucide/at-sign',
  };
  for (const needle in map) { if (host && host.includes(needle)) return map[needle]; }
  return '';
}
const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Is a CSS color string a dark fill? (hex or rgb/rgba). Conservative: unknown → false.
function isDark(c) {
  c = String(c || '').trim();
  let r, g, b;
  let m = c.match(/^#([0-9a-f]{3})$/i);
  if (m) { r = parseInt(m[1][0] + m[1][0], 16); g = parseInt(m[1][1] + m[1][1], 16); b = parseInt(m[1][2] + m[1][2], 16); }
  else if ((m = c.match(/^#([0-9a-f]{6})$/i))) { r = parseInt(m[1].slice(0, 2), 16); g = parseInt(m[1].slice(2, 4), 16); b = parseInt(m[1].slice(4, 6), 16); }
  else if ((m = c.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i))) { r = +m[1]; g = +m[2]; b = +m[3]; }
  else return false;
  // Relative luminance; < 0.4 reads as dark.
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.4;
}

// Tailwind shadow token → single-layer box_shadow {x,y,blur,spread,color,inset} (dominant layer).
const TW_SHADOW_BOX = { sm: [0, 1, 2, 0, 0.05], DEFAULT: [0, 1, 3, 0, 0.1], md: [0, 4, 6, -1, 0.1], lg: [0, 10, 15, -3, 0.1], xl: [0, 20, 25, -5, 0.1], '2xl': [0, 25, 50, -12, 0.25] };
const shadowBox = (name) => { const s = TW_SHADOW_BOX[name]; return s ? { x: s[0], y: s[1], blur: s[2], spread: s[3], color: `rgba(0,0,0,${s[4]})`, inset: false } : null; };
const unitOf = (v) => { const m = String(v == null ? '' : v).match(/^(-?[0-9.]+)\s*(px|rem|em|%)?$/); return m ? { value: m[1], unit: m[2] || 'px' } : null; };
const isFilled = (bg) => bg && bg !== 'rgba(0, 0, 0, 0)' && String(bg).toLowerCase() !== 'transparent';

// Normalize a computed colour (rgb/rgba/hex, incl. `R G B / a` spacing) → clean rgb()/rgba()/hex, or ''
// for transparent. Mirror of build_button_presets()'s $normc so the emitted values match PHP exactly.
const normc = (c) => {
  c = String(c == null ? '' : c).toLowerCase().trim();
  if (c === '' || c === 'transparent' || c === 'none') return '';
  let m = c.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([0-9.]+))?/);
  if (m) { const a = (m[4] !== undefined && m[4] !== '') ? parseFloat(m[4]) : 1; if (a <= 0.02) return ''; return a < 1 ? `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${a})` : `rgb(${m[1]}, ${m[2]}, ${m[3]})`; }
  if (/^#[0-9a-f]{3,8}$/.test(c)) return c;
  return '';
};
// The FIRST visible (non-transparent) layer of a computed box-shadow → {x,y,blur,spread,color,inset}.
const shadow1 = (css) => {
  css = String(css || '').trim();
  if (css === '' || css.toLowerCase() === 'none') return null;
  const layers = []; let depth = 0, cur = '';
  for (const ch of css) { if (ch === '(') depth++; else if (ch === ')') depth--; if (ch === ',' && depth === 0) { layers.push(cur); cur = ''; } else cur += ch; }
  if (cur) layers.push(cur);
  for (let layer of layers) {
    layer = layer.trim();
    const inset = /inset/i.test(layer);
    let rest = layer.replace(/inset/ig, '');
    let color = '';
    const cm = rest.match(/(rgba?\([^)]*\)|#[0-9a-f]{3,8})/i);
    if (cm) { color = normc(cm[1]); rest = rest.replace(cm[1], ''); }
    if (!color) continue;
    const nums = []; for (const tok of rest.trim().split(/\s+/)) { const tm = tok.match(/^(-?[0-9.]+)(?:px)?$/); if (tm) nums.push(Math.round(parseFloat(tm[1]))); }
    return { x: nums[0] || 0, y: nums[1] || 0, blur: nums[2] || 0, spread: nums[3] || 0, color, inset };
  }
  return null;
};
/**
 * Derive Button Colour + Size Presets from the source's REAL button skins (deterministic, no AI).
 * URL-path MIRROR of PHP FW_Site_Converter_Stitch::build_button_presets(): consumes home.buttonSkins
 * (captured in-browser by capture-extract — one skin per short-text a/button, ROLE from its semantic
 * fill class + resolved computed style), clusters them by role, emits ONE colour preset per role
 * (Primary/Secondary/Outline/Fill, stable ids) + up to 3 size presets (Large/Medium/Small, biggest
 * font = Large; pill radius rides on the size). Returns `{button_colors?, button_sizes?}` or null.
 */
export function buildButtonPresets(home) {
  const skins = (home && Array.isArray(home.buttonSkins) ? home.buttonSkins : []).map((s) => ({
    role: s.role || 'Fill',
    bg: normc(s.bg), fg: normc(s.fg), bd: normc(s.bd),
    bw: (s.bw && s.bw !== '0px' && s.bw !== '0') ? s.bw : '',
    shadow: s.shadow || '', radius: (s.radius || '').trim(),
    px: s.px || '', py: s.py || '', fs: s.fs || '', lh: s.lh || '',
    hoverBg: normc(s.hoverBg),
  }));
  if (!skins.length) return null;

  // Cluster by role + colours; the most common skin wins each role.
  const groups = new Map();
  for (const s of skins) {
    const key = s.role + '|' + s.bg + '|' + s.bw + s.bd;
    if (!groups.has(key)) groups.set(key, { ...s, count: 0 });
    groups.get(key).count++;
  }
  const order = { Primary: 0, Secondary: 1, Outline: 2, Fill: 3 };
  const byRole = {};
  for (const g of groups.values()) { const r = g.role; if (!byRole[r] || g.count > byRole[r].count) byRole[r] = g; }
  const roles = Object.values(byRole).sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9));

  const colState = (fg, bg, bd, bw, bstyle, sh) => {
    const st = { text_color: fg ? hex(fg) : { predefined: '', custom: '' }, bg_color: isFilled(bg) ? hex(bg) : { predefined: '', custom: '' } };
    if (bd) st.border_color = hex(bd);
    if (bstyle) st.border_style = bstyle;
    if (bw) { const u = unitOf(bw); if (u) st.border_width = u; }
    if (sh) { const b = shadow1(sh); if (b) st.box_shadow = b; }
    return st;
  };
  const roleId = { Primary: '0000000001', Secondary: '0000000002', Outline: '0000000003', Fill: '0000000004' };
  const colors = [];
  for (const g of roles) {
    const name = g.role;
    const isOutline = name === 'Outline' || (!isFilled(g.bg) && g.bw);
    // Hover: darken a fill to 90% alpha (the source's hover:bg-*/90); else inherit.
    const hoverBg = isFilled(g.bg) ? String(g.bg).replace(/^rgb\((.+)\)$/, 'rgba($1, 0.9)') : '';
    colors.push({
      id: roleId[name] || ('00000000' + (colors.length + 1)),
      color_name: name,
      states: {
        default: colState(g.fg, g.bg, g.bw ? (g.bd || g.fg) : '', g.bw, g.bw ? 'solid' : (isOutline ? 'solid' : 'none'), g.shadow),
        hover: hoverBg ? { bg_color: hex(hoverBg) } : {},
        active: {}, focus: {}, disabled: {},
      },
    });
  }

  // Size presets — one per distinct (fs,px,py,radius); biggest font = Large.
  const seenSz = new Set(); const sizeDefs = [];
  for (const s of skins) {
    if (s.fs === '' && s.px === '' && s.radius === '') continue;
    const k = s.fs + '|' + s.px + '|' + s.py + '|' + s.radius;
    if (seenSz.has(k)) continue; seenSz.add(k); sizeDefs.push(s);
  }
  sizeDefs.sort((a, b) => (parseFloat(b.fs) || 0) - (parseFloat(a.fs) || 0));
  const sizeNames = [['Large', 'lg', '0000010004'], ['Medium', 'md', '0000010003'], ['Small', 'sm', '0000010002']];
  const sizes = [];
  sizeDefs.slice(0, 3).forEach((s, i) => {
    const [nm, slug, sid] = sizeNames[i];
    const sz = { id: sid, size_name: nm, slug };
    if (s.fs) { const u = unitOf(s.fs); if (u) sz.font_size = u; }
    if (s.lh && s.lh !== 'normal') sz.line_height = /px|rem|em/.test(s.lh) ? s.lh : String(s.lh);
    if (s.py) { const u = unitOf(s.py); if (u) sz.padding_y = u; }
    if (s.px) { const u = unitOf(s.px); if (u) sz.padding_x = u; }
    if (s.radius) { const u = unitOf(s.radius); if (u) sz.border_radius = u; }
    sizes.push(sz);
  });

  const out = {};
  if (colors.length) out.button_colors = colors;
  if (sizes.length) out.button_sizes = sizes;
  return Object.keys(out).length ? out : null;
}

// SPACING SCALE — the Tailwind/Bootstrap base scale + any arbitrary off-scale spacing the source uses
// (home.spacingTokens, ≥40px). Mirror of build_spacing_scale(). Returns the {name,size} rows.
function buildSpacingScale(home) {
  const base = [
    { name: '0', size: '0' }, { name: '1', size: '0.25rem' }, { name: '2', size: '0.5rem' },
    { name: '3', size: '1rem' }, { name: '4', size: '1.5rem' }, { name: '5', size: '3rem' },
    { name: '6', size: '3.5rem' }, { name: '7', size: '4rem' }, { name: '8', size: '4.5rem' },
    { name: '9', size: '5rem' }, { name: '10', size: '6rem' }, { name: '11', size: '7rem' },
    { name: '12', size: '8rem' },
  ];
  const have = new Set(base.map((e) => e.size.toLowerCase()));
  const extras = [];
  for (const t of (home && Array.isArray(home.spacingTokens) ? home.spacingTokens : [])) {
    const v = String(t.value || '').toLowerCase();
    if (!v || have.has(v)) continue; have.add(v);
    extras.push({ px: t.px || 0, row: { name: '[' + v + ']', size: v } });
  }
  extras.sort((a, b) => a.px - b.px);
  return base.concat(extras.map((e) => e.row));
}

/**
 * @param {object} config the toDesignConfig() output (header/footer/colors)
 * @param {object} home   the home capture (home.header.logo.text/.icon, home.footer.copyright)
 * @returns {{values: object}} the theme-settings.json payload
 */
export function toThemeSettings(config, home) {
  const colors = config.colors || {};
  const header = config.header || {};
  const footer = config.footer || {};
  const homeLogo = (home && home.header && home.header.logo) || {};

  const headerDark = isDark(colors.header_bg) || isDark(colors.bg);
  const ink = colors.ink || '#111111';
  const accent = colors.accent || '';
  const title = (homeLogo.text && String(homeLogo.text).trim())
    || (config.theme && config.theme.name) || 'Site';

  const values = {};
  const miscCssParts = []; // accumulates every scoped rule → one `misc_custom_css.custom_css` at the end

  /* --- header_logo — faithful to the SOURCE brand (nested logo_type/custom shape, MIRROR of PHP
     tokens_to_theme_settings_chrome()): the wordmark's own size/weight/colour + an optional icon
     mark (inline svg or lucide id) + a coloured frame tile (shape inferred from its radius). --- */
  const det = homeLogo.detail || {};
  const siteTitle = (det.text && det.text.trim()) || title;
  const titleColor = det.title_color || (headerDark ? '#ffffff' : ink);
  const logoCustom = {
    site_title: siteTitle,
    logo_layout: 'inline-left',
    title_weight: det.title_weight || '700',
    color: hex(titleColor),
  };
  const tsz = unitOf(det.title_size);
  if (tsz) logoCustom.title_size = tsz;
  // Icon mark: inline svg (verbatim) preferred, else a Lucide library id.
  if (det.svg) logoCustom.logo_icon = { type: 'svg', 'svg-source': 'inline', markup: det.svg };
  else if (det.icon && /^lucide\//.test(det.icon)) logoCustom.logo_icon = { type: 'svg', 'svg-source': 'library', 'svg-id': det.icon };
  else if (homeLogo.icon && /^lucide\//.test(homeLogo.icon)) logoCustom.logo_icon = { type: 'svg', 'svg-source': 'library', 'svg-id': homeLogo.icon };
  if (logoCustom.logo_icon) {
    logoCustom.logo_icon_color = hex(det.icon_color || accent || titleColor);
    const isz = unitOf(det.icon_size);
    if (isz) logoCustom.logo_icon_size = isz;
    // A coloured tile behind the mark → its shape (circle/squircle/rounded/square) + fill.
    if (det.frame && det.frame !== 'none' && det.frame_bg) {
      logoCustom.logo_icon_frame = ['circle', 'squircle', 'rounded', 'square'].includes(det.frame) ? det.frame : 'rounded';
      logoCustom.logo_icon_frame_bg = hex(det.frame_bg);
    }
  }
  // Two-tone wordmark residual — a single `color` can't split e.g. "Fresh"(dark)+"Paws"(accent).
  if (det.title_accent_color && det.title_accent_color !== titleColor) {
    logoCustom.logo_custom_css = '.site-title-text .accent,.site-title-text b,.site-title-text strong{color:' + det.title_accent_color + '}';
    // SPLIT the wordmark so the scoped CSS has something to paint (the theme prints site_title RAW inside
    // `.site-title-text`): wrap the measured accent run in `<span class="accent">`. Mirror of the PHP emit.
    const acc = det.title_accent_text || '';
    const pos = acc && siteTitle ? siteTitle.indexOf(acc) : -1;
    if (pos !== -1) {
      logoCustom.site_title = escHtml(siteTitle.slice(0, pos)) + '<span class="accent">' + escHtml(acc) + '</span>' + escHtml(siteTitle.slice(pos + acc.length));
    }
  }
  const logoType = (!det.text && det.image) ? 'simple' : 'custom';
  const logoSimple = {};
  if (det.image) { logoSimple.image = { url: det.image, attachment_id: 0 }; logoSimple.alt = siteTitle; }
  values.header_logo = { logo_type: { logo_type: logoType, custom: logoCustom, simple: logoSimple } };

  /* --- header_main: logo · menu · CTA --- */
  const homeCta = (home && home.header && home.header.cta) || {};
  const right = [];
  if (header.cta && header.cta.enabled && header.cta.label) {
    right.push(el('cta_button', {
      cta_text: header.cta.label,
      cta_link: header.cta.href || '#',
      cta_style: homeCta.style || 'btn-primary',
      cta_size: 'btn-md',
    }));
  }
  values.header_main = {
    main_left: [el('logo')],
    main_center: [el('menu_area', { menu_location: 'primary' })],
    main_right: right,
  };

  /* --- header_menu --- */
  const navColor = (home && home.chrome && home.chrome.nav_style && home.chrome.nav_style.color) || '';
  values.header_menu = {
    menu_link_color: hex(navColor || (headerDark ? '#cbd5e1' : ink)),
    menu_link_hover_color: hex(headerDark ? '#ffffff' : (accent || ink)),
  };

  /* --- header_layout --- */
  values.header_layout = {
    header_mode: { mode: 'top', top: { header_design: { design: 'classic' } } },
    header_behavior: header.sticky ? 'sticky' : 'static',
    header_glass: 'no',
    header_shadow: 'no',
    header_border: 'no',
    header_uppercase_nav: 'no',
    bg_color: hex(colors.header_bg && /^#|rgb/.test(colors.header_bg) ? colors.header_bg : (headerDark ? '#111111' : '#ffffff')),
  };
  // Mobile breakpoint — the width at which the inline nav collapses (only on a real signal).
  if (home && (home.mobileBreakpoint === 'md' || home.mobileBreakpoint === 'lg')) {
    values.header_layout.mobile_breakpoint = home.mobileBreakpoint;
  }
  // HEADER container width — from the header's INNER content wrapper (header.bar) computed max-width.
  // A real capped px → Fixed Width ('container') + the numeric width; full-bleed → Full Width. Mirror
  // of detect_chrome_container()/detect_header_chrome_styles().
  const barMw = (home && home.header && home.header.bar && home.header.bar.maxWidth) || '';
  const mwPx = String(barMw).match(/^([0-9.]+)px$/);
  if (mwPx) {
    const px = Math.round(parseFloat(mwPx[1]));
    if (px >= 320 && px <= 2200) { values.header_layout.container = 'container'; values.header_layout.container_width = { value: String(px), unit: 'px' }; }
  } else if (/^(none|100%|full)$/i.test(String(barMw).trim())) {
    values.header_layout.container = 'container-fluid';
  }

  /* --- footer colors (background-pro shape for the fill) --- */
  const footerBg = colors.footer_bg || '#141414';
  const footerText = colors.footer_text || '#94a3b8';
  values.footer_background = { color: { value: { predefined: '', custom: footerBg } } };
  values.footer_text_color = hex(footerText);
  values.footer_link_color = hex(footerText);

  /* --- footer container width — per-bar Fixed/Full Width (+ a scoped px cap residual), mirror of the
     footer branch of PHP tokens_to_theme_settings_chrome(). --- */
  const fMax = (home && home.footerContainerMax) || '';
  if (fMax) {
    const fluid = fMax === 'fluid';
    const fContainer = fluid ? 'container-fluid' : 'container';
    for (const ck of ['main_footer_custom_styling', 'copyright_custom_styling']) {
      const prefix = ck === 'main_footer_custom_styling' ? 'main_footer' : 'copyright';
      values[ck] = { enabled: 'yes', yes: { [`${prefix}_container`]: fContainer } };
    }
    if (!fluid && /^[0-9]+$/.test(String(fMax))) {
      const fwPx = parseInt(fMax, 10);
      miscCssParts.push(`.footer .fw-container{max-width:calc(${fwPx}px + 2 * var(--container-gutter, clamp(1.25rem, 3vw, 2rem)))}`);
    }
  }

  /* --- SITE-WIDE Container Width + responsive Tailwind `.container` ladder — URL-path MIRROR of the
     container block in PHP FW_Site_Converter_Stitch::tokens_to_theme_settings_chrome()
     (class-fw-site-converter-stitch.php ~line 1574–1615). The source's header/footer inner content
     wrapper caps at the source `.container` (e.g. 1280px measured at the 1440 capture viewport). Map it
     to the theme's GLOBAL Container Width (general_layout → layout_container_width) so BODY sections
     match the chrome. The detected value is the source BOX (max-width, includes the source's own
     gutters); UnysonPlus's Container Width is a CONTENT width the theme ADDS gutters OUTSIDE of, so
     convert box→content (box − 48, theme default 24px gutter each side). When the source uses the
     literal Tailwind `.container` (a responsive ladder sm 640 / md 768 / lg 1024 / xl 1280 / 2xl 1536)
     the native base/md/lg option can't express the tiers ABOVE lg, so emit them as scoped @media CSS
     targeting the `.fw-container` BOX directly (same calc the theme's `body .fw-container` uses, with
     !important so the rendered box wins at ≥xl regardless of the `--container-max-desktop` var cascade). */
  const boxToContent = (boxPx) => { const box = Math.round(parseFloat(boxPx) || 0); const content = box - 48; return content >= 320 ? content : box; };
  const barMwNum = (String(barMw).match(/^([0-9.]+)px$/) || [])[1] || '';        // header bar content wrapper width (px)
  const fMaxNum = /^[0-9]+$/.test(String((home && home.footerContainerMax) || '')) ? String(home.footerContainerMax) : '';
  let siteBox = 0;
  for (const cwv of [barMwNum, fMaxNum]) { const n = parseFloat(cwv); if (!isNaN(n)) siteBox = Math.max(siteBox, Math.round(n)); }
  if (siteBox > 0) {
    const contentW = boxToContent(siteBox);
    values.general_layout = Object.assign({}, values.general_layout, {
      layout_container_width: {
        base: { value: '100', unit: '%' },
        md: { value: '720', unit: 'px' },
        lg: { value: String(contentW), unit: 'px' },
      },
    });
    // Only emit the ladder when the source genuinely uses the literal Tailwind `container` class AND
    // its measured cap sits ON a Tailwind step (a fixed `max-w-[..]` cap stays a single width).
    if (home && home.usesTwContainer) {
      const twSteps = [640, 768, 1024, 1280, 1536];
      if (twSteps.includes(siteBox)) {
        const gutter = 'var(--container-gutter, clamp(1.25rem, 3vw, 2rem))';
        const lines = [];
        for (const bp of twSteps) {
          if (bp <= siteBox) continue; // tiers up to siteBox are covered by the lg map
          const content = boxToContent(bp);
          lines.push('@media (min-width:' + bp + 'px){body .fw-container,body .container,body .site-header .fw-container{max-width:calc(' + content + 'px + 2 * ' + gutter + ') !important;}}');
        }
        if (lines.length) miscCssParts.push('/* Tailwind .container responsive ladder (tiers above lg) */\n' + lines.join('\n'));
      }
    }
  }

  /* --- typography — URL-path MIRROR of PHP detect_typography() + the $typo assembly nested under the
     `typography` multi container (General → Typography). The FAMILIES come from the design config (the
     same source-of-truth tokens_to_design_config() uses); the MEASURED size/weight/line-height/
     letter-spacing come from home.typography (computed styles captured in-browser). Values MUST nest
     under values.typography[...] — css-tokens reads fw_get_db_settings_option('typography') and looks
     up heading_font / body / h1..h6 on THAT array (a flat store is invisible to it). --- */
  const ty = (home && home.typography) || {};
  const fonts = config.fonts || {};
  let tyHead = String(fonts.heading || '').trim();
  let tyBody = String(fonts.body || '').trim();
  if (!tyHead) { for (const lvl of ['h1', 'h2', 'h3']) { if (ty[lvl] && ty[lvl].family) { tyHead = ty[lvl].family; break; } } }
  if (!tyBody && ty.body && ty.body.family) tyBody = ty.body.family;
  const typo = {};
  // Heading Font — family only (empty inherits body). Loads via css-tokens `google` list.
  if (tyHead) typo.heading_font = { family: tyHead };
  // Body Font & Text — family + measured base size/line-height/letter-spacing.
  if (tyBody || ty.body) {
    const bodyVal = { family: tyBody || '', variation: 'regular', color: '' };
    if (ty.body && ty.body.size != null) bodyVal.size = { value: String(ty.body.size), unit: 'px' };
    if (ty.body && ty.body['line-height'] != null && ty.body['line-height'] !== '') bodyVal['line-height'] = ty.body['line-height'];
    if (ty.body && ty.body['letter-spacing'] != null && ty.body['letter-spacing'] !== '') bodyVal['letter-spacing'] = ty.body['letter-spacing'];
    typo.body = bodyVal;
  }
  // Per-heading scale H1–H6 — only levels the source uses. `variation` carries the weight; family left
  // '' to inherit the Heading Font unless the source heading uses a DIFFERENT family than it.
  for (const lvl of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
    const h = ty[lvl];
    if (!h) continue;
    const hasW = h.weight != null && String(h.weight) !== '' && parseInt(h.weight, 10) !== 400;
    const hv = { family: '', variation: hasW ? String(h.weight) : 'regular', color: '' };
    if (h.family && tyHead && String(h.family).toLowerCase() !== tyHead.toLowerCase()) hv.family = h.family;
    if (h.size != null) hv.size = { value: String(h.size), unit: 'px' };
    if (h['line-height'] != null && h['line-height'] !== '') hv['line-height'] = h['line-height'];
    if (h['letter-spacing'] != null && h['letter-spacing'] !== '') hv['letter-spacing'] = h['letter-spacing'];
    typo[lvl] = hv;
  }
  if (Object.keys(typo).length) values.typography = typo;

  /* --- social_profiles (footer social links → Lucide) --- */
  // Network name → Lucide id (mirror of PHP social_network_map), for icon-sniffed socials whose href is a
  // placeholder '#' (so host-based socialLucide misses them).
  const NET_LUCIDE = { facebook: 'lucide/facebook', instagram: 'lucide/instagram', twitter: 'lucide/twitter',
    youtube: 'lucide/youtube', linkedin: 'lucide/linkedin', github: 'lucide/github', tiktok: 'lucide/music',
    dribbble: 'lucide/dribbble', twitch: 'lucide/twitch', pinterest: 'lucide/image', discord: 'lucide/message-circle',
    telegram: 'lucide/send', whatsapp: 'lucide/message-circle', slack: 'lucide/slack', mastodon: 'lucide/at-sign' };
  const socialSeen = {};
  const social = [];
  (footer.social || []).forEach((s) => {
    const net = (s.net || '').trim().toLowerCase();
    const icon = (net && NET_LUCIDE[net]) || socialLucide(s.url);
    if (!icon || socialSeen[icon]) return;
    socialSeen[icon] = true;
    let host = ''; try { host = new URL(s.url).host.replace(/^www\./, ''); } catch { host = ''; }
    const wm = host.match(/([a-z0-9-]+)\.[a-z.]+$/i);
    let word = net || (s.label || '').trim() || (wm ? wm[1] : icon.replace('lucide/', ''));
    if (word.toLowerCase() === 'x') word = 'Twitter';
    // A placeholder '#' keeps the icon rendered (the theme skips an EMPTY link).
    const link = /^https?:/i.test(s.url || '') ? s.url : '#';
    social.push({ name: word.charAt(0).toUpperCase() + word.slice(1), link, new_tab: 'yes',
      icon: { type: 'svg', 'svg-source': 'library', 'svg-id': icon } });
  });
  if (social.length) values.social_profiles = social.slice(0, 6);

  /* --- main_footer_columns: brand column + link columns (source footer grid) --- */
  // footer.menu = top-level groups { label, url:'#', children:[{label,url}] } (link columns).
  const groups = (footer.menu || []).filter((g) => Array.isArray(g.children) && g.children.length >= 2).slice(0, 4);
  if (groups.length) {
    const brandCol = [el('logo')];
    const fdesc = (footer.copyright || '').trim();
    if (fdesc) brandCol.push({ element_type: { element: 'text', text: { text_content: `<p>${escHtml(fdesc)}</p>` } } });
    if (social.length) brandCol.push(el('social_icons'));

    const cols = [brandCol];
    groups.forEach((g) => {
      let h = `<h4>${escHtml(g.label)}</h4><ul>`;
      g.children.forEach((l) => { h += `<li><a href="${escHtml(l.url || '#')}">${escHtml(l.label)}</a></li>`; });
      h += '</ul>';
      cols.push([{ element_type: { element: 'text', text: { text_content: h } } }]);
    });
    // CONTACT column → a native leading-icon list (map-pin/phone/mail), each tinted its source colour and
    // with address line-breaks preserved. Richer than the hand-built demo (which dropped these). Mirror of PHP.
    const fc = footer.contact;
    if (fc && Array.isArray(fc.rows) && fc.rows.length) {
      let h = `<h4>${escHtml(fc.title || 'Contact')}</h4><ul class="fw-footer-contact">`;
      fc.rows.forEach((r) => {
        let mark = '';
        if (r.icon) { const style = r.color ? ` style="color:${escHtml(r.color)}"` : ''; mark = `<span class="fw-ci-icon"${style}>${r.icon}</span> `; }
        const val = escHtml(String(r.text || '')).replace(/\n/g, '<br>');
        h += `<li class="fw-ci-row">${mark}<span class="fw-ci-text">${val}</span></li>`;
      });
      h += '</ul>';
      cols.push([{ element_type: { element: 'text', text: { text_content: h } } }]);
    }
    const trimmed = cols.slice(0, 5);
    const n = trimmed.length;
    const mfc = {};
    trimmed.forEach((c, i) => { mfc[`main_footer_col_${i + 1}`] = c; });
    // 4 columns whose brand column is wider → the fifths "2/5+1/5+1/5+1/5" layout.
    let countKey = String(n);
    if (n === 4) { mfc.main_footer_layout = 'f5-2-1-1-1'; countKey = '5'; }
    values.main_footer_columns = { count: countKey, [countKey]: mfc };
  }

  /* --- copyright bar --- */
  let copy = (home && home.footer && String(home.footer.copyright || '').trim()) || '';
  if (copy) { copy = copy.replace(/\b(19|20)\d{2}\b/, '{{current_year}}'); }
  else { copy = `&copy; {{current_year}} ${title}. All rights reserved.`; }
  values.copyright_settings = {
    enabled: 'yes',
    yes: {
      copyright_columns: {
        count: '1',
        1: { copyright_col_1: [{ element_type: { element: 'text', text: { text_content: copy } } }] },
      },
    },
  };

  /* --- button_colors / button_sizes: presets derived from the source's real button skin --- */
  const btnPresets = buildButtonPresets(home);
  if (btnPresets) {
    Object.assign(values, btnPresets);
    // A Large size preset exists → the header CTA should use it (matches the source's chunky CTA).
    if (btnPresets.button_sizes && values.header_main && Array.isArray(values.header_main.main_right)) {
      for (const node of values.header_main.main_right) {
        const cta = node && node.element_type && node.element_type.cta_button;
        if (cta && cta.cta_size === 'btn-md') cta.cta_size = 'btn-lg';
      }
    }
  }

  /* --- spacing_scale (Components → Spacing): the source's spacing steps → editable scale. --- */
  values.spacing_scale = buildSpacingScale(home);

  // Flush every scoped rule (footer width cap + Tailwind .container ladder) into one custom_css block.
  if (miscCssParts.length) values.misc_custom_css = { custom_css: miscCssParts.join('\n') };

  return { values };
}
