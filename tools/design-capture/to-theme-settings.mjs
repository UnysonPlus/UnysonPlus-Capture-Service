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

/**
 * Derive Button Colour + Size Presets from the source's REAL button skin (deterministic, no AI).
 * Reads the enriched button blocks/nodes (bs colours + `tw` token intent: shadow/radius/border/padding)
 * captured by capture-extract, so the converted site's `.btn-primary/.btn-secondary/.btn-lg` match the
 * source instead of falling back to Bootstrap defaults. Returns `{button_colors?, button_sizes?}` or null.
 */
function buildButtonPresets(home) {
  const btns = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if ((n.role === 'button' || n.t === 'button') && (n.label || n.text)) btns.push(n);
    for (const k in n) if (n[k] && typeof n[k] === 'object') walk(n[k]);
  };
  walk(home && home.sections);
  if (!btns.length) return null;
  const skin = (n) => {
    const s = n.styles || {}, tw = n.tw || s.tw || {};
    return {
      bg: (n.bs && n.bs.bg) || s.bg || '', fg: (n.bs && n.bs.fg) || s.color || '', bd: (n.bs && n.bs.bd) || '',
      shadow: tw.shadow || '', radius: tw.radius || n.rad || s.borderRadius || '',
      // '0px' computed border = NO border; only a real width (from a `border-*` token or non-zero computed) counts.
      bw: tw.borderWidth || (n.bw && n.bw !== '0px' ? n.bw : ''),
      px: tw.px || '', py: tw.py || '', fw: tw.fontWeight || n.fw || s.fontWeight || '',
      fs: tw.fontSize || n.fs || s.fontSize || '', lh: tw.lineHeight || n.lh || s.lineHeight || '',
      hoverBg: (n.hover && n.hover.backgroundColor) || (s.hover && s.hover.backgroundColor) || '',
    };
  };
  const skins = btns.map(skin);
  const isWhitish = (bg) => { const m = String(bg).match(/(\d+),\s*(\d+),\s*(\d+)/); return m ? (+m[1] > 240 && +m[2] > 240 && +m[3] > 240) : false; };
  // PRIMARY = the saturated filled CTA (not white). SECONDARY = a bordered button (transparent OR white
  // fill with a border — the "outline / on-white" style). White-with-border must NOT read as primary.
  const filled = skins.find((k) => isFilled(k.bg) && !isWhitish(k.bg));
  const outline = skins.find((k) => k !== filled && k.bw && k.bw !== '0px');
  const colState = (fg, bg, bd, bw, bstyle, sh) => {
    const st = { text_color: fg ? hex(fg) : { predefined: '', custom: '' }, bg_color: isFilled(bg) ? hex(bg) : { predefined: '', custom: '' } };
    if (bd) st.border_color = hex(bd);
    if (bstyle) st.border_style = bstyle;
    if (bw) { const u = unitOf(bw); if (u) st.border_width = u; }
    if (sh) { const b = shadowBox(sh); if (b) st.box_shadow = b; }
    return st;
  };
  const colors = [];
  if (filled) colors.push({ id: '0000000001', color_name: 'Primary', states: {
    default: colState(filled.fg, filled.bg, filled.bw ? filled.bd : '', filled.bw, filled.bw ? 'solid' : 'none', filled.shadow),
    hover: colState('', filled.hoverBg || filled.bg, '', '', '', filled.shadow === 'lg' ? 'xl' : filled.shadow), active: {}, focus: {}, disabled: {} } });
  if (outline) colors.push({ id: '0000000002', color_name: 'Secondary', states: {
    default: colState(outline.fg, outline.bg, outline.bd || outline.fg, outline.bw || '2px', 'solid', outline.shadow),
    hover: colState('', outline.hoverBg, '', '', '', outline.shadow), active: {}, focus: {}, disabled: {} } });
  const src = filled || outline, sizes = [];
  if (src && (src.fs || src.px || src.radius)) {
    const sz = { id: '0000010004', size_name: 'Large', slug: 'lg' };
    if (src.fs) sz.font_size = unitOf(src.fs);
    if (src.lh && src.lh !== 'normal') sz.line_height = /px|rem|em/.test(src.lh) ? src.lh : String(src.lh);
    if (src.py) sz.padding_y = unitOf(src.py);
    if (src.px) sz.padding_x = unitOf(src.px);
    if (src.radius) sz.border_radius = unitOf(src.radius);
    sizes.push(sz);
  }
  const out = {};
  if (colors.length) out.button_colors = colors;
  if (sizes.length) out.button_sizes = sizes;
  return Object.keys(out).length ? out : null;
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

  /* --- header_logo (wordmark + optional icon) --- */
  const hl = {
    site_title: title,
    title_weight: '600',
    color: hex(headerDark ? '#ffffff' : ink),
    tagline: ' d-none',
  };
  if (homeLogo.icon && /^lucide\//.test(homeLogo.icon)) {
    hl.logo_icon = { type: 'svg', 'svg-source': 'library', 'svg-id': homeLogo.icon };
    hl.logo_icon_position = 'before';
    hl.logo_icon_color = accent ? { predefined: 'text-primary', custom: '' } : hex(ink);
  }
  values.header_logo = hl;

  /* --- header_main: logo · menu · CTA --- */
  const right = [];
  if (header.cta && header.cta.enabled && header.cta.label) {
    right.push(el('cta_button', {
      cta_text: header.cta.label,
      cta_link: header.cta.href || '#',
      cta_style: 'btn-primary',
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
    header_behavior: header.sticky ? 'sticky' : 'default',
    header_glass: 'no',
    header_shadow: 'no',
    header_border: 'no',
    header_uppercase_nav: 'no',
    bg_color: hex(colors.header_bg && /^#|rgb/.test(colors.header_bg) ? colors.header_bg : (headerDark ? '#111111' : '#ffffff')),
  };

  /* --- footer colors (background-pro shape for the fill) --- */
  const footerBg = colors.footer_bg || '#141414';
  const footerText = colors.footer_text || '#94a3b8';
  values.footer_background = { color: { value: { predefined: '', custom: footerBg } } };
  values.footer_text_color = hex(footerText);
  values.footer_link_color = hex(footerText);

  /* --- social_profiles (footer social links → Lucide) --- */
  const socialSeen = {};
  const social = [];
  (footer.social || []).forEach((s) => {
    const icon = socialLucide(s.url);
    if (!icon || socialSeen[icon]) return;
    socialSeen[icon] = true;
    let host = ''; try { host = new URL(s.url).host.replace(/^www\./, ''); } catch { host = ''; }
    const wm = host.match(/([a-z0-9-]+)\.[a-z.]+$/i);
    let word = (s.label || '').trim() || (wm ? wm[1] : icon.replace('lucide/', ''));
    if (word.toLowerCase() === 'x') word = 'Twitter';
    social.push({ name: word.charAt(0).toUpperCase() + word.slice(1), link: s.url, new_tab: 'yes',
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

  return { values };
}
