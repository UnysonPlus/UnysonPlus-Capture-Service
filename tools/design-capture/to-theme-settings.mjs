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
    px: s.px || '', py: s.py || '', fs: s.fs || '', lh: s.lh || '', height: s.height || '',
    // Typography extras → the preset Custom CSS (parity with PHP appearance_css).
    ff: (s.ff || '').trim(), ls: (s.ls || '').trim(), tt: (s.tt || '').trim(), fw: (s.fw || '').trim(),
    hoverBg: normc(s.hoverBg),
  }));
  if (!skins.length) return null;

  // Normalize a font stack to its first family, lowercased, for compare (parity with PHP $ff_key).
  const ffKey = (ff) => { ff = String(ff || '').trim().toLowerCase(); if (!ff) return ''; return ff.split(',')[0].trim().replace(/^["']|["']$/g, ''); };
  const baseFf = ffKey((home && home.typography && home.typography.body && home.typography.body.family) || '');
  // Typography → the preset's NATIVE `font` field (family/weight/letter-spacing), so Theme Settings shows the
  // real font (not Arial) and the CSS emits ONE `.btn-{slug}` rule instead of a duplicate `{{SELECTOR}}` block.
  // text-transform rides the default state; family carried only when it deviates from the page body font.
  // Mirror of the PHP stitch. Returns { font, textTransform }.
  const fontFields = (g) => {
    const font = {};
    const ff = String(g.ff || '').trim();
    if (ff && ffKey(ff) && ffKey(ff) !== baseFf && !/inherit/i.test(ff)) font.family = ff.split(',')[0].trim().replace(/^["']|["']$/g, '');
    const fw = String(g.fw || '').trim();
    if (/^(100|200|300|500|600|700|800|900)$/.test(fw)) font.weight = fw;
    const ls = String(g.ls || '').trim();
    if (ls && ls !== 'normal' && ls !== '0px' && ls !== '0') font['letter-spacing'] = ls;
    const tt = String(g.tt || '').trim().toLowerCase();
    return { font, textTransform: (tt && tt !== 'none') ? tt : '' };
  };

  // Cluster by role + colours; the most common skin wins each role.
  const groups = new Map();
  for (const s of skins) {
    const key = s.role + '|' + s.bg + '|' + s.bw + s.bd;
    if (!groups.has(key)) groups.set(key, { ...s, count: 0 });
    const g = groups.get(key);
    g.count++;
    // The winning group keeps the first-seen skin's fields, but the resolved hover often lives on only one
    // member (e.g. a single outline button with hover:bg-secondary). Adopt a later member's hoverBg when the
    // stored one has none — parity with the PHP stitch's cluster-adopt.
    if (!g.hoverBg && s.hoverBg) g.hoverBg = s.hoverBg;
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
    // Hover: PREFER the capture's resolved hover fill (hoverStyle → g.hoverBg) — this carries an outline
    // button's `hover:bg-secondary` to its real colour instead of dropping it. Fall back to darkening a fill
    // to 90% alpha (the classic hover:bg-*/90 lift) only when no explicit hover was captured.
    const hoverBg = (g.hoverBg && g.hoverBg !== g.bg) ? g.hoverBg
      : (isFilled(g.bg) ? String(g.bg).replace(/^rgb\((.+)\)$/, 'rgba($1, 0.9)') : '');
    const { font, textTransform } = fontFields(g);
    const defState = colState(g.fg, g.bg, g.bw ? (g.bd || g.fg) : '', g.bw, g.bw ? 'solid' : (isOutline ? 'solid' : 'none'), g.shadow);
    if (textTransform) defState.text_transform = textTransform;
    colors.push({
      id: roleId[name] || ('00000000' + (colors.length + 1)),
      color_name: name,
      // slug + role let to-pages.mjs _buttonPresetFor() match a body button to this preset (parity with the
      // PHP stitch). slug mirrors the plugin's choice key `btn-` + sanitize_title_with_dashes(color_name).
      slug: String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
      role: String(name).toLowerCase(),
      // Typography on the NATIVE font field (shows in the UI, one .btn-{slug} rule) — not Custom CSS.
      font,
      states: {
        default: defState,
        hover: hoverBg ? { bg_color: hex(hoverBg) } : {},
        active: {}, focus: {}, disabled: {},
      },
    });
  }

  // Size presets — CLUSTER near-identical skins (#1: computed values are noisy, 43.99≈44), rank by VISUAL
  // size (#2: fixed height, else font-box + paddings — not font alone), tag the MOST-USED as base/Default
  // (#3). Representative value per property = the MODE (most common exact value). Parity with the PHP stitch.
  const pxOf = (v) => { v = String(v || '').trim(); let m; if ((m = v.match(/^([0-9.]+)px$/))) return parseFloat(m[1]); if ((m = v.match(/^([0-9.]+)rem$/))) return parseFloat(m[1]) * 16; if ((m = v.match(/^([0-9.]+)$/))) return parseFloat(m[1]); return 0; };
  const clusters = [];
  for (const s of skins) {
    if (s.fs === '' && s.px === '' && s.radius === '') continue;
    const fsn = pxOf(s.fs), pxn = pxOf(s.px), pyn = pxOf(s.py), hn = pxOf(s.height);
    let hit = clusters.find((c) => Math.abs(c.fsn - fsn) <= 1 && Math.abs(c.pxn - pxn) <= 3 && Math.abs(c.pyn - pyn) <= 3 && Math.abs(c.hn - hn) <= 3);
    if (!hit) { hit = { fsn, pxn, pyn, hn, count: 0, modes: {} }; clusters.push(hit); }
    hit.count++;
    for (const [p, val] of Object.entries({ fs: s.fs, px: s.px, py: s.py, radius: s.radius, height: s.height || '', lh: s.lh })) {
      const v = String(val); (hit.modes[p] = hit.modes[p] || {})[v] = (hit.modes[p][v] || 0) + 1;
    }
  }
  const mode = (counts) => { if (!counts) return ''; let best = '', bc = -1; for (const [k, v] of Object.entries(counts)) { if (v > bc) { bc = v; best = k; } } return best; };
  const sizeDefs = clusters.map((c) => {
    const rep = {}; for (const p of ['fs', 'px', 'py', 'radius', 'height', 'lh']) rep[p] = mode(c.modes[p]);
    rep._visual = Math.max(c.hn, c.fsn * 1.3 + 2 * c.pyn); rep._fs = c.fsn; rep._count = c.count; return rep;
  });
  // Rank by visual size, then font-size (same-height tie), then frequency.
  sizeDefs.sort((a, b) => (b._visual - a._visual) || (b._fs - a._fs) || (b._count - a._count));
  let domIdx = 0, domCt = -1;
  sizeDefs.forEach((d, i) => { if (d._count > domCt) { domCt = d._count; domIdx = i; } });
  const sizeNames = (sizeDefs.length <= 3)
    ? [['Large', 'lg', '0000010004'], ['Medium', 'md', '0000010003'], ['Small', 'sm', '0000010002']]
    : [['X-Large', 'xl', '0000010005'], ['Large', 'lg', '0000010004'], ['Medium', 'md', '0000010003'], ['Small', 'sm', '0000010002'], ['X-Small', 'xs', '0000010001'], ['2X-Small', 'xxs', '0000010000']];
  const sizes = [];
  sizeDefs.slice(0, sizeNames.length).forEach((s, i) => {
    const [nm0, slug, sid] = sizeNames[i];
    const nm = (i === domIdx && sizeDefs.length > 1) ? nm0 + ' (Default)' : nm0;
    const sz = { id: sid, size_name: nm, slug };
    if (s.fs) { const u = unitOf(s.fs); if (u) sz.font_size = u; }
    if (s.lh && s.lh !== 'normal') sz.line_height = /px|rem|em/.test(s.lh) ? s.lh : String(s.lh);
    if (s.py) { const u = unitOf(s.py); if (u) sz.padding_y = u; }
    if (s.px) { const u = unitOf(s.px); if (u) sz.padding_x = u; }
    if (s.height) { const u = unitOf(s.height); if (u) sz.min_height = u; } // fixed h-N → Min Height (content centres to it)
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
    { name: '3', size: '1rem' }, { name: '4', size: '1.5rem' },
    // Mid-range steps bridging the 24px→48px cliff (2rem / 2.5rem). Parity with the theme default.
    { name: '[32px]', size: '32px' }, { name: '[40px]', size: '40px' },
    { name: '5', size: '3rem' },
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

// GAP SCALE — mirrors the theme default (0-12 + the [32px]/[40px] mid-range) so g-{slug} ≡ p-{slug} and large
// gutters (64px, 80px) are expressible, then appends any off-scale gutter the source uses (from the harvested
// spacing tokens — off-scale gaps surface there). Parity with PHP build_gap_scale(). Returns {name,size} rows.
function buildGapScale(home) {
  const base = [
    { name: '0', size: '0' }, { name: '1', size: '0.25rem' }, { name: '2', size: '0.5rem' },
    { name: '3', size: '1rem' }, { name: '4', size: '1.5rem' },
    { name: '[32px]', size: '32px' }, { name: '[40px]', size: '40px' },
    { name: '5', size: '3rem' },
    { name: '6', size: '3.5rem' }, { name: '7', size: '4rem' }, { name: '8', size: '4.5rem' },
    { name: '9', size: '5rem' }, { name: '10', size: '6rem' }, { name: '11', size: '7rem' },
    { name: '12', size: '8rem' },
  ];
  const basePx = [0, 4, 8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 96, 112, 128];
  const onScale = (px) => basePx.some((b) => Math.abs(b - px) <= 1);
  const have = new Set();
  const extras = [];
  for (const t of (home && Array.isArray(home.gapTokens) ? home.gapTokens : (home && Array.isArray(home.spacingTokens) ? home.spacingTokens : []))) {
    const px = Math.round(t.px || 0);
    if (!px || px < 4 || onScale(px) || have.has(px)) continue; have.add(px);
    extras.push({ px, row: { name: '[' + px + 'px]', size: px + 'px' } });
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
    logo_layout: (det.layout && ['icon-only', 'inline-left', 'inline-right', 'stacked-left', 'stacked-right', 'eyebrow-left', 'eyebrow-right'].includes(det.layout)) ? det.layout : 'inline-left',
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
  // NEVER-DROP wordmark skin — font-family (`font-serif`), letter-spacing (`tracking-tight`) and the hover
  // colour (`hover:text-primary`) have no native logo option → scoped logo_custom_css. Mirror of PHP detect_logo.
  {
    let logoCss = logoCustom.logo_custom_css || '';
    let baseDecls = '';
    const fam = String(det.title_font || '').trim();
    if (fam) {
      const parts = fam.split(',').map((s) => s.trim());
      const generic = (parts[parts.length - 1] || '').toLowerCase();
      // Carry only a DISTINCTIVE family (serif / mono / display, or a named font); skip a plain system-sans stack.
      if (['serif', 'monospace', 'cursive', 'fantasy'].includes(generic) || /["']/.test(fam)) baseDecls += 'font-family:' + fam + ';';
    }
    const ls = String(det.title_ls || '').trim();
    if (ls && ls !== 'normal' && ls !== '0px') baseDecls += 'letter-spacing:' + ls + ';';
    if (baseDecls) logoCss += '.site-title-text{' + baseDecls + '}';
    if (det.title_hover) {
      const htok = String(det.title_hover).toLowerCase().replace(/[^a-z0-9-]/g, '');
      if (htok) logoCss += '.site-title a:hover .site-title-text,.site-title a:hover{color:var(--color-' + htok + ')}';
    }
    if (logoCss) logoCustom.logo_custom_css = logoCss;
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
  // Prefer the captured menu-<ul> nav_style; when the header nav is bare <nav><a> anchors (an SPA menu with
  // no <ul>, so navMapper returns null → nav_style null), FALL BACK to the first nav link's own computed
  // style (home.header.nav[0]) so menu colour / size / weight / FONT still map to native options instead of
  // being dropped. See header.md → header_menu.
  const navStyle = (home && home.chrome && home.chrome.nav_style) || {};
  const navLinks0 = (home && home.header && Array.isArray(home.header.nav)) ? home.header.nav : [];
  const navFallback = (navLinks0[0] && navLinks0[0].computed) || {};
  const nsGet = (k) => navStyle[k] || navFallback[k] || '';
  const navColor = nsGet('color');
  // Real hover colour (from the nav link's hover:* utilities, captured as nav[].hover) beats the
  // white/accent default when present — parity with PHP detect_menu_styles hover_color.
  let navHover = '';
  for (const n of navLinks0) { if (n && n.hover && n.hover.color) { navHover = n.hover.color; break; } }
  values.header_menu = {
    menu_link_color: hex(navColor || (headerDark ? '#cbd5e1' : ink)),
    menu_link_hover_color: hex(navHover || (headerDark ? '#ffffff' : (accent || ink))),
  };
  // NEVER-DROP menu typography — FONT FAMILY / size / weight / letter-spacing / uppercase. Font family was
  // previously only in the .sc-menu generated CSS; route it into the native menu_font option.
  const navFamily = nsGet('fontFamily');
  if (navFamily && !/^(inherit|initial|unset)$/i.test(navFamily)) values.header_menu.menu_font = { family: navFamily };
  const nfs = unitOf(nsGet('fontSize')); if (nfs) values.header_menu.menu_link_font_size = nfs;
  const nfw = String(parseInt(nsGet('fontWeight'), 10) || '');
  if (/^(300|400|500|600|700|800)$/.test(nfw)) values.header_menu.menu_link_font_weight = nfw;
  const _nls = nsGet('letterSpacing');
  const nls = (_nls && _nls !== 'normal' && _nls !== '0px') ? unitOf(_nls) : null;
  if (nls) values.header_menu.menu_link_letter_spacing = nls;
  const _ntt = nsGet('textTransform');
  if (_ntt && /uppercase/i.test(_ntt)) values.header_menu.menu_link_uppercase = 'yes';

  /* --- header_layout — the TWO-STATE model (see the Header Layout doc). POSITION + the AT-TOP appearance
     come from the RESTING snapshot; the ON-SCROLL appearance comes from the captured scroll state
     (chrome.header_scroll.scrolled), mapped only as DELTAS vs resting. This makes the OBSIDIAN pattern —
     clear over the hero, then frosted + shrunk on scroll — reproduce natively instead of collapsing into a
     single behavior enum. */
  const _chrome = (home && home.chrome) || {};
  const _hs = _chrome.header_scroll || {};
  const _hsTop = _hs.top || {};
  const _hsScr = _hs.scrolled || {};
  const _hbar = (home && home.header && home.header.bar) || {};
  const _hel = (home && home.header && home.header.element) || {};
  const _pos = String(_hel.position || _hsTop.position || '').toLowerCase();
  const _pinned = !!header.sticky || _pos === 'fixed' || _pos === 'sticky';
  const _isClear = (c) => { c = String(c || '').trim().toLowerCase(); return c === '' || c === 'transparent' || /rgba?\([^)]*[,/]\s*0\s*\)/.test(c); };
  const _restClear = _isClear(_hel.backgroundColor) && _isClear(_hbar.backgroundColor) && _isClear(_hsTop.bg);
  const _hasBlur = (v) => /blur\(\s*[0-9.]*[1-9]/.test(String(v || ''));
  const _colOf = (v) => (String(v || '').match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}/i) || [''])[0];
  const _hasBorder = (v) => { v = String(v || '').trim(); if (v === '' || v === 'none') return false; const w = v.split(/\s+/)[0]; if (/^0(px)?$/.test(w)) return false; return !_isClear(_colOf(v)); };
  const _hasShadow = (v) => { v = String(v || '').trim(); return v !== '' && v !== 'none'; };
  const EMPTY_COLOR = { predefined: '', custom: '' };
  // Resting (AT TOP) vs scrolled (ON SCROLL).
  const restBlur = _hasBlur(_hbar.backdropFilter) || _hasBlur(_hsTop.backdrop);
  const restBorder = _hasBorder(_hbar.border) || _hasBorder(_hsTop.borderBottom);
  const restShadow = _hasShadow(_hsTop.shadow) || _hasShadow(_hbar.boxShadow);
  const scrBlur = _hasBlur(_hsScr.backdrop);
  const scrBorder = _hasBorder(_hsScr.borderBottom);
  const scrShadow = _hasShadow(_hsScr.shadow);
  const _tpt = parseFloat(_hsTop.padTop), _spt = parseFloat(_hsScr.padTop);
  const scrShrink = isFinite(_tpt) && isFinite(_spt) && _spt < _tpt - 2;
  const scrBg = _colOf(_hsScr.bg);
  const scrBgOpaque = scrBg && !_isClear(_hsScr.bg);
  // Position: pinned + transparent at rest = overlay; pinned + solid = sticky; else static.
  const position = _pinned ? (_restClear ? 'overlay' : 'sticky') : 'static';
  // At-top background: the resting fill (empty for a transparent overlay — do NOT inject a dark default,
  // that belongs to the scrolled state).
  const restBg = _colOf(_hel.backgroundColor) || _colOf(_hbar.backgroundColor) || (colors.header_bg && /^#|rgb/.test(colors.header_bg) ? colors.header_bg : '');
  // On-scroll deltas (only what CHANGES vs resting).
  const onGlass = scrBlur && !restBlur, onBorder = scrBorder && !restBorder, onShadow = scrShadow && !restShadow, onShrink = scrShrink;
  const scrollChange = onGlass || onBorder || onShadow || onShrink || scrBgOpaque;
  values.header_layout = {
    header_mode: { mode: 'top', top: { header_design: { design: 'classic' } } },
    header_position: position,
    header_uppercase_nav: 'no',
    // Appearance — AT TOP.
    bg_color: (_restClear || !restBg) ? EMPTY_COLOR : hex(restBg),
    header_glass: restBlur ? 'yes' : 'no',
    header_border: restBorder ? 'yes' : 'no',
    header_shadow: restShadow ? 'yes' : 'no',
  };
  if (scrollChange) {
    values.header_layout.header_scroll_change = 'yes';
    if (onGlass) values.header_layout.scroll_glass = 'yes';
    if (onBorder) values.header_layout.scroll_border = 'yes';
    if (onShadow) values.header_layout.scroll_shadow = 'yes';
    if (onShrink) values.header_layout.scroll_shrink = 'yes';
    // Scrolled Background: the solid scrolled fill if opaque; else a dark tint for a dark overlay/glass so
    // the frost reads dark.
    if (scrBgOpaque) values.header_layout.scroll_bg_color = hex(scrBg);
    else if ((onGlass || position === 'overlay') && headerDark) values.header_layout.scroll_bg_color = hex(isDark(colors.bg) ? colors.bg : '#111111');
  }
  // Mobile breakpoint — the width at which the inline nav collapses (only on a real signal).
  if (home && (home.mobileBreakpoint === 'md' || home.mobileBreakpoint === 'lg')) {
    values.mobile_breakpoint = home.mobileBreakpoint;
  }
  // Mobile drawer PANEL appearance (mirror of detect: header_layout drawer_* in the PHP stitch). The drawer
  // used to inherit the desktop menu palette (tuned for the header BAR over a hero), so its links rendered
  // washed-out on a solid panel. Map a legible drawer look: panel bg = the resting SOLID header fill when
  // opaque (else the theme light default), drawer link colour = the source nav colour ONLY if it contrasts
  // on that panel, else a legible ink; active colour = the accent when it reads on the panel.
  {
    const _panelSolid = restBg && !_restClear;
    const _panelBg = _panelSolid ? restBg : '#ffffff';
    if (_panelSolid) values.drawer_bg = hex(restBg);
    const _panelDark = isDark(_panelBg);
    const _dnav = navColor || '';
    const _dlegible = _dnav && isDark(_dnav) !== _panelDark;
    values.drawer_link_color = _dlegible ? hex(_dnav) : hex(_panelDark ? '#f1f1f1' : (ink || '#1a1a1a'));
    if (accent && isDark(accent) !== _panelDark) values.drawer_link_active_color = hex(accent);
  }
  // Mobile BAR background (top-level key, Header → Mobile & Tablet). A transparent / overlay desktop header
  // leaves the COLLAPSED mobile bar see-through over content, so give it a solid fill. Prefer the scrolled
  // fill; else the site background (dark sites → dark bar); else white. Mirror of the PHP stitch.
  if (position === 'overlay' || (!restBg || _restClear)) {
    const scrolled = values.header_layout.scroll_bg_color && values.header_layout.scroll_bg_color.custom;
    const mbar = scrolled || (colors.bg && /^#|rgb/.test(colors.bg) ? colors.bg : '') || '#ffffff';
    if (mbar) values.mobile_bar_bg = hex(mbar);
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
  // NEVER-DROP footer COLUMN-HEADING typography — uppercase / tracking / weight / size / colour → a scoped
  // `.footer-links-title` rule (no native footer-heading option). Parity with PHP footer_heading_css().
  const fhs = (home && home.chrome && home.chrome.footer_heading_style) || null;
  if (fhs) {
    let d = '';
    if (fhs.transform && /uppercase/i.test(fhs.transform)) d += 'text-transform:uppercase;';
    if (fhs.letterSpacing && fhs.letterSpacing !== 'normal' && fhs.letterSpacing !== '0px') d += 'letter-spacing:' + fhs.letterSpacing + ';';
    const fw = String(parseInt(fhs.fontWeight, 10) || '');
    if (/^(300|400|500|600|700|800|900)$/.test(fw)) d += 'font-weight:' + fw + ';';
    if (/^[0-9.]+px$/.test(String(fhs.fontSize || '').trim())) d += 'font-size:' + String(fhs.fontSize).trim() + ';';
    if (fhs.color) d += 'color:' + fhs.color + ';';
    if (d) miscCssParts.push('.footer-links-title{' + d + '}');
  }
  // NEVER-DROP footer LINK typography (transform/tracking/weight/size + hover token). Parity with PHP footer_link_css().
  const fls = (home && home.chrome && home.chrome.footer_link_style) || null;
  if (fls) {
    let d = '';
    if (fls.transform && /uppercase/i.test(fls.transform)) d += 'text-transform:uppercase;';
    if (fls.letterSpacing && fls.letterSpacing !== 'normal' && fls.letterSpacing !== '0px') d += 'letter-spacing:' + fls.letterSpacing + ';';
    const fw = String(parseInt(fls.fontWeight, 10) || '');
    if (/^(300|400|500|600|700|800|900)$/.test(fw)) d += 'font-weight:' + fw + ';';
    if (/^[0-9.]+px$/.test(String(fls.fontSize || '').trim())) d += 'font-size:' + String(fls.fontSize).trim() + ';';
    if (d) miscCssParts.push('.footer-menu a{' + d + '}');
    if (fls.hover) { const t = String(fls.hover).toLowerCase().replace(/[^a-z0-9-]/g, ''); if (t) miscCssParts.push('.footer-menu a:hover{color:var(--color-' + t + ')}'); }
    // List-item vertical spacing — override the theme's 8px default so the source's own rhythm shows.
    // Parity with PHP footer_link_css()'s footer_list_gap_px() emit.
    const gap = parseInt(fls.gap, 10) || 0;
    if (gap > 0 && Math.abs(gap - 8) >= 1) miscCssParts.push('.footer-column .footer-links-list>li:not(:last-child){margin-bottom:' + gap + 'px}');
    // Line-height — the source's own (e.g. 20px); the theme's tighter default leaves the list cramped even
    // once the gap matches. Applied to every list item (links AND plain-text rows). Parity with PHP.
    const flh = String(fls.lineHeight || '').trim();
    if (/^[0-9.]+(px|rem|em)$/.test(flh)) miscCssParts.push('.footer-column .footer-links-list>li,.footer-column .footer-links-list .list-item__text{line-height:' + flh + '}');
  }
  // NEVER-DROP footer TAGLINE typography (size / line-height / colour). Parity with PHP footer_tagline_css().
  const fts = (home && home.chrome && home.chrome.footer_tagline_style) || null;
  if (fts) {
    let d = '';
    if (/^[0-9.]+px$/.test(String(fts.fontSize || '').trim())) d += 'font-size:' + String(fts.fontSize).trim() + ';';
    if (/^[0-9.]+px$/.test(String(fts.lineHeight || '').trim())) d += 'line-height:' + String(fts.lineHeight).trim() + ';';
    if (fts.color) d += 'color:' + fts.color + ';';
    if (d) miscCssParts.push('.footer-tagline{' + d + '}');
  }

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
    // text-transform — reproduce a heading font uppercased purely by CSS (a display face like Syncopate).
    if (h['text-transform'] && ['uppercase', 'lowercase', 'capitalize', 'none'].includes(String(h['text-transform']).toLowerCase())) hv['text-transform'] = String(h['text-transform']).toLowerCase();
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
    if (fdesc) brandCol.push({ element_type: { element: 'text', text: { text_content: `<p class="footer-tagline">${escHtml(fdesc)}</p>` } } });
    if (social.length) brandCol.push(el('social_icons'));

    const cols = [brandCol];
    // NAV column → heading + one unified `list_item` element (URL link) per {label,url}. Each stays editable,
    // and the theme's footer column renderer auto-wraps a RUN of 2+ consecutive List Item elements into a
    // semantic <ul><li> list. Mirror of PHP footer_group_to_column() — the unified element supersedes the old
    // link / icon_text / text split.
    groups.forEach((g) => {
      const col = [];
      if (g.label) col.push({ element_type: { element: 'heading', heading: { heading_text: g.label, heading_level: 'h3' } } });
      (g.children || []).forEach((l) => {
        const label = String(l.label || '').trim();
        if (!label) return;
        col.push({ element_type: { element: 'list_item', list_item: { li_text: label, li_link_type: 'url', li_link: (l.url && l.url !== '') ? l.url : '#', li_target: '_self' } } });
      });
      if (col.length) cols.push(col);
    });
    // CONTACT column → heading + one unified `list_item` per row (leading icon-v2 svg tinted its source
    // colour, value, tel/mailto/url link). Mirror of PHP footer_group_to_column(); the theme groups the rows
    // into a <ul>. The unified element supersedes the old icon_text/text emit.
    const fc = footer.contact;
    if (fc && Array.isArray(fc.rows) && fc.rows.length) {
      const contactCol = [{ element_type: { element: 'heading', heading: { heading_text: fc.title || 'Contact', heading_level: 'h4' } } }];
      fc.rows.forEach((r) => {
        const txt = String(r.text || '').trim();
        if (!txt) return;
        const li = { li_text: txt, li_link_type: 'none' };
        const svg = String(r.icon || '').trim();
        if (/^<svg\b/i.test(svg)) {
          const markup = (r.color && /currentcolor/i.test(svg)) ? svg.replace(/currentColor/gi, r.color) : svg;
          li.li_icon = { type: 'svg', 'svg-source': 'inline', markup, 'svg-id': '' };
        }
        const lnk = String(r.link || '').trim();
        if (lnk) {
          li.li_link = lnk;
          li.li_link_type = /^tel:/i.test(lnk) ? 'phone' : (/^mailto:/i.test(lnk) ? 'email' : 'url');
          if (li.li_link_type === 'url') li.li_target = '_self';
        }
        contactCol.push({ element_type: { element: 'list_item', list_item: li } });
      });
      cols.push(contactCol);
    }
    // NEWSLETTER / signup column → the native `newsletter` element (heading + description + email + button),
    // so a 4-col footer keeps its 4th column instead of dropping it. Mirror of PHP.
    const fn = footer.newsletter;
    if (fn && fn.title) {
      cols.push([{ element_type: { element: 'newsletter', newsletter: {
        title: fn.title,
        description: fn.tagline || '',
        email_placeholder: fn.placeholder || 'Your email address',
        button_label: fn.button || 'Subscribe',
        show_name: 'no',
        design: 'inline',
      } } }]);
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

  /* --- font_sizes (Text Styles): the Display scale + BODY roles (Lead/Subtitle/Small/Caption) + Eyebrow
     distilled from the source in capture-extract (typography.textStyles). MIRROR of PHP
     Stitch::build_text_styles(); the same {name,size,weight,line_height,letter_spacing,transform,class}
     entry shape so a converted text block's `font_size_preset` (its preset CLASS) resolves. --- */
  const textStyles = (home && home.typography && Array.isArray(home.typography.textStyles)) ? home.typography.textStyles : [];
  if (textStyles.length) values.font_sizes = textStyles;

  /* --- spacing_scale (Components → Spacing): the source's spacing steps → editable scale. --- */
  values.spacing_scale = buildSpacingScale(home);
  /* --- gap_scale (Components → Spacing → Gaps): extended to mirror the spacing scale + off-scale gutters. --- */
  values.gap_scale = buildGapScale(home);

  // Flush every scoped rule (footer width cap + Tailwind .container ladder) into one custom_css block.
  if (miscCssParts.length) values.misc_custom_css = { custom_css: miscCssParts.join('\n') };

  return { values };
}
