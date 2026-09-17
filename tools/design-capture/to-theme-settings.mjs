// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
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

import { parseLinearGradient } from './box-presets.mjs';
import { makeButtonResolver } from './button-match.mjs';
// A colour fit for a theme option: drop a utility framework's `/ var(--tw-*-opacity, 1)` alpha; a value still carrying var() → ''
// (the theme default), never a broken string the CSS generator swaps for the brand primary. PHP: clean_color_value.
const cleanColor = (h) => { let v = String(h || '').trim(); if (!v) return ''; v = v.replace(/\s*\/\s*var\([^)]*\)/g, ''); if (/var\(/i.test(v)) return ''; while ((v.match(/\(/g) || []).length > (v.match(/\)/g) || []).length) v += ')'; if ((v.match(/\(/g) || []).length !== (v.match(/\)/g) || []).length) return ''; const m = v.match(/^rgba?\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/); if (m) v = 'rgb(' + m[1] + ', ' + m[2] + ', ' + m[3] + ')'; return v; };
const hex = (h) => ({ predefined: '', custom: cleanColor(h) });
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

// oklch()/oklab()/hsl()/hsla() → [r, g, b(, a)] (0-255). A dark AI page commonly declares its canvas +
// text in oklch(), which the rgb/hex-only parsers dropped — so the palette defaulted to a WHITE background
// AND kept the light text, rendering white-on-white. Mirrors the PHP color_to_hex() math (oklab→linear sRGB).
function cssToRgb(c) {
  c = String(c || '').trim().toLowerCase();
  let m;
  if ((m = c.match(/^okl(ch|ab)\(\s*([0-9.]+%?)[,\s]+(-?[0-9.]+)[,\s]+(-?[0-9.]+)(?:[,\s/]+([0-9.]+%?))?\s*\)$/))) {
    let L = parseFloat(m[2]); if (m[2].includes('%') || L > 1.5) L /= 100;
    let aa, bb;
    if (m[1] === 'ch') { const C = parseFloat(m[3]), H = parseFloat(m[4]) * Math.PI / 180; aa = C * Math.cos(H); bb = C * Math.sin(H); }
    else { aa = parseFloat(m[3]); bb = parseFloat(m[4]); }
    const l_ = L + 0.3963377774 * aa + 0.2158037573 * bb;
    const m_ = L - 0.1055613458 * aa - 0.0638541728 * bb;
    const s_ = L - 0.0894841775 * aa - 1.2914855480 * bb;
    const lc = l_ ** 3, mc = m_ ** 3, sc = s_ ** 3;
    const lin = [4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
      -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
      -0.0041960863 * lc - 0.7034186147 * mc + 1.7076147010 * sc];
    const gam = (x) => { x = Math.max(0, Math.min(1, x)); return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055; };
    const a5 = (m[5] !== undefined && m[5] !== '') ? (m[5].includes('%') ? parseFloat(m[5]) / 100 : parseFloat(m[5])) : undefined;
    return [Math.max(0, Math.min(255, Math.round(gam(lin[0]) * 255))), Math.max(0, Math.min(255, Math.round(gam(lin[1]) * 255))), Math.max(0, Math.min(255, Math.round(gam(lin[2]) * 255))), a5];
  }
  if ((m = c.match(/^hsla?\(\s*([0-9.]+)(?:deg)?[,\s]+([0-9.]+)%[,\s]+([0-9.]+)%(?:[,\s/]+([0-9.]+%?))?\s*\)$/))) {
    const h = ((((parseFloat(m[1]) % 360) + 360) % 360) / 360), s = parseFloat(m[2]) / 100, l = parseFloat(m[3]) / 100;
    const hue = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
    let r, g, b;
    if (s === 0) { r = g = b = l; } else { const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q; r = hue(p, q, h + 1 / 3); g = hue(p, q, h); b = hue(p, q, h - 1 / 3); }
    const a4 = (m[4] !== undefined && m[4] !== '') ? (m[4].includes('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])) : undefined;
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), a4];
  }
  return null;
}

// Is a CSS color string a dark fill? (hex, rgb/rgba, oklch/oklab, hsl/hsla). Conservative: unknown → false.
function isDark(c) {
  c = String(c || '').trim();
  let r, g, b;
  let m = c.match(/^#([0-9a-f]{3})$/i);
  if (m) { r = parseInt(m[1][0] + m[1][0], 16); g = parseInt(m[1][1] + m[1][1], 16); b = parseInt(m[1][2] + m[1][2], 16); }
  else if ((m = c.match(/^#([0-9a-f]{6})$/i))) { r = parseInt(m[1].slice(0, 2), 16); g = parseInt(m[1].slice(2, 4), 16); b = parseInt(m[1].slice(4, 6), 16); }
  else if ((m = c.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i))) { r = +m[1]; g = +m[2]; b = +m[3]; }
  else { const rc = cssToRgb(c); if (rc) { r = rc[0]; g = rc[1]; b = rc[2]; } else return false; }
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
  // oklch()/oklab()/hsl() → rgb() so a dark AI-page palette (canvas/text in oklch) isn't dropped to white.
  const rc = cssToRgb(c);
  if (rc) { const a = rc[3]; if (a !== undefined && a <= 0.02) return ''; return (a !== undefined && a < 1) ? `rgba(${rc[0]}, ${rc[1]}, ${rc[2]}, ${a})` : `rgb(${rc[0]}, ${rc[1]}, ${rc[2]})`; }
  return '';
};
// The FIRST visible (non-transparent) layer of a computed box-shadow → {x,y,blur,spread,color,inset}.
const shadow1 = (css) => {
  css = String(css || '').trim();
  if (css === '' || css.toLowerCase() === 'none') return null;
  const layers = []; let depth = 0, cur = '';
  for (const ch of css) { if (ch === '(') depth++; else if (ch === ')') depth--; if (ch === ',' && depth === 0) { layers.push(cur); cur = ''; } else cur += ch; }
  if (cur) layers.push(cur);
  const cands = [];
  for (let layer of layers) {
    layer = layer.trim();
    const inset = /inset/i.test(layer);
    let rest = layer.replace(/inset/ig, '');
    let color = '';
    const cm = rest.match(/(rgba?\([^)]*\)|#[0-9a-f]{3,8})/i);
    if (cm) { color = normc(cm[1]); rest = rest.replace(cm[1], ''); }
    if (!color) continue;
    const nums = []; for (const tok of rest.trim().split(/\s+/)) { const tm = tok.match(/^(-?[0-9.]+)(?:px)?$/); if (tm) nums.push(Math.round(parseFloat(tm[1]))); }
    cands.push({ x: nums[0] || 0, y: nums[1] || 0, blur: nums[2] || 0, spread: nums[3] || 0, color, inset });
  }
  if (!cands.length) return null;
  // The native field holds ONE layer: pick the MOST VISIBLE — a non-inset drop over an inset highlight, then the
  // widest blur. (Taking the FIRST layer lost a `inset 0 1px 0 …, 0 16px 42px …` CTA's real drop.) Parity w/ PHP.
  cands.sort((a, b) => (a.inset !== b.inset) ? (a.inset ? 1 : -1) : ((b.blur + b.spread) - (a.blur + a.spread)));
  return cands[0];
};
// Top-level layer count of a box-shadow (commas outside parens + 1); 0 for none.
const shadowLayers = (css) => {
  css = String(css || '').trim(); if (!css || css.toLowerCase() === 'none') return 0;
  let n = 1, depth = 0; for (const ch of css) { if (ch === '(') depth++; else if (ch === ')') depth--; else if (ch === ',' && depth === 0) n++; }
  return n;
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
    cls: String(s.cls || ''),
    bg: normc(s.bg), fg: normc(s.fg), bd: normc(s.bd),
    bw: (s.bw && s.bw !== '0px' && s.bw !== '0') ? s.bw : '',
    grad: (s.grad || '').trim(),
    shadow: s.shadow || '', radius: (s.radius || '').trim(),
    px: s.px || '', py: s.py || '', fs: s.fs || '', lh: s.lh || '', height: s.height || '',
    // Typography extras → the preset Custom CSS (parity with PHP appearance_css).
    ff: (s.ff || '').trim(), ls: (s.ls || '').trim(), tt: (s.tt || '').trim(), fw: (s.fw || '').trim(),
    hoverBg: normc(s.hoverBg),
    hov: (s.hov || '').trim(), tr: (s.tr || '').trim(), kf: (s.kf || '').trim(),
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
    const key = s.role + '|' + s.bg + '|' + s.bw + s.bd + '|' + s.grad;
    if (!groups.has(key)) groups.set(key, { ...s, count: 0 });
    const g = groups.get(key);
    g.count++;
    // The winning group keeps the first-seen skin's fields, but the resolved hover often lives on only one
    // member (e.g. a single outline button with hover:bg-secondary). Adopt a later member's hoverBg when the
    // stored one has none — parity with the PHP stitch's cluster-adopt.
    if (!g.hoverBg && s.hoverBg) g.hoverBg = s.hoverBg;
    if (!g.hov && s.hov) { g.hov = s.hov; g.kf = s.kf; }
  }
  const order = { Primary: 0, Secondary: 1, Accent: 2, Outline: 3, Fill: 4 };
  const byRole = {};
  for (const g of groups.values()) { const r = g.role; if (!byRole[r] || g.count > byRole[r].count) byRole[r] = g; }
  const roles = Object.values(byRole).sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9));
  // A role's OTHER distinct skins (a white-bordered header CTA beside slate-bordered plan buttons — both "Outline") → their
  // own "<Role> 2" / "<Role> 3" presets, reached only by a COLOUR match (a semantic class keeps the winner). PHP: $variants.
  const variants = {};
  for (const g of groups.values()) {
    const r = g.role;
    if (!byRole[r] || byRole[r] === g) continue;
    if (!g.bg && !g.bd && !g.grad) continue;
    variants[r] = variants[r] || [];
    if (variants[r].length >= 2) continue;
    if (variants[r].some((v) => v.bg === g.bg && v.bd === g.bd && v.grad === g.grad)) continue;
    variants[r].push({ ...g, role: r + ' ' + (variants[r].length + 2) });
  }
  for (const vs of Object.values(variants)) roles.push(...vs);

  const colState = (fg, bg, bd, bw, bstyle, sh) => {
    const st = { text_color: fg ? hex(fg) : { predefined: '', custom: '' }, bg_color: isFilled(bg) ? hex(bg) : { predefined: '', custom: '' } };
    if (bd) st.border_color = hex(bd);
    if (bstyle) st.border_style = bstyle;
    if (bw) { const u = unitOf(bw); if (u) st.border_width = u; }
    if (sh) { const b = shadow1(sh); if (b) st.box_shadow = b; }
    return st;
  };
  const roleId = { Primary: '0000000001', Secondary: '0000000002', Outline: '0000000003', Fill: '0000000004', Accent: '0000000005' };
  // The source's hover MOTION → the preset's Custom CSS ({{SELECTOR}}-aware), eased with the source's own transition.
  // Mirror of the PHP stitch $hover_transform_css: the capture's resolved `hover-self{transform:…}` first, else a
  // Tailwind `hover:scale-N`; `active:scale-N` too. The preset owns it — the page builder never substitutes a
  // `.btnfx-*` effect (which would add a shadow / easing the source lacks).
  const hoverTransformCss = (g) => {
    const cls = ' ' + String(g.cls || '').toLowerCase() + ' ';
    const rules = [];
    const hm = String(g.hov || '').match(/hover-self\{([^}]*)\}/i);
    const tm = hm && hm[1].match(/(?:^|;)\s*transform\s*:\s*([^;]+)/i);
    if (tm && tm[1].trim() && tm[1].trim().toLowerCase() !== 'none') rules.push('{{SELECTOR}}:hover { transform: ' + tm[1].trim() + '; }');
    // the REST of the hover state (a lifted shadow, a glow filter, a wider tracking) — verbatim (PHP parity)
    if (hm) { const hd = []; for (const hp of ['box-shadow', 'filter', 'letter-spacing', 'opacity']) { const pm = hm[1].match(new RegExp('(?:^|;)\\s*' + hp + '\\s*:\\s*([^;]+)', 'i')); if (pm && /^[a-z0-9()%.,\s#\/-]+$/i.test(pm[1].trim())) hd.push(hp + ': ' + pm[1].trim()); } if (hd.length) rules.push('{{SELECTOR}}:hover { ' + hd.join('; ') + '; }'); }
    // PSEUDO LAYERS — the button's own ::before / ::after (+ their hover state + @keyframes), positioned + clipped (PHP parity)
    { const pr = []; let rel = false;
      for (const pk of ['before', 'after', 'hover-before', 'hover-after']) {
        const mm = String(g.hov || '').match(new RegExp('(?:^|\\|)' + pk + '\\{([^}]*)\\}', 'i')); if (!mm) continue;
        const pd = [];
        for (const decl of mm[1].split(';')) { const cp = decl.indexOf(':'); if (cp < 0) continue; const k = decl.slice(0, cp).trim().toLowerCase(); let v = decl.slice(cp + 1).trim(); if (!v || v === 'initial' || k.startsWith('--') || /^transition-(property|duration|timing-function)$/.test(k)) continue; if (!/^[a-z0-9()%.,\s#\/"'-]+$/i.test(v)) continue; if (k === 'content') v = '""'; if (k === 'position' && v.toLowerCase() === 'absolute') rel = true; pd.push(k + ':' + v); }
        if (!pd.length) continue;
        if (!pk.startsWith('hover-') && !pd.includes('pointer-events:none')) pd.push('pointer-events:none');
        pr.push((pk.startsWith('hover-') ? '{{SELECTOR}}:hover::' + pk.slice(6) : '{{SELECTOR}}::' + pk) + ' { ' + pd.join('; ') + '; }');
      }
      if (pr.length) { if (rel) pr.unshift('{{SELECTOR}} { position: relative; overflow: hidden; isolation: isolate; }'); rules.push(...pr); const kf = String(g.kf || '').trim(); if (kf && /@keyframes/i.test(kf) && !/<\/|expression\(|javascript:/i.test(kf)) rules.push(kf); }
    }
    let m;
    if (!rules.length && (m = cls.match(/\shover:scale-(\d{1,3})\s/))) rules.push('{{SELECTOR}}:hover { transform: scale(' + String(parseInt(m[1], 10) / 100) + '); }');
    if ((m = cls.match(/\sactive:scale-(\d{1,3})\s/))) rules.push('{{SELECTOR}}:active { transform: scale(' + String(parseInt(m[1], 10) / 100) + '); }');
    // A source-declared transition rides the preset even with NO hover transform (a colour-only hover still eases
    // at the source's own speed, not the button base's). Parity with PHP.
    const tr = String(g.tr || '').trim();
    const hasTr = tr && !/^(?:all\s+)?0s\b/i.test(tr) && tr.toLowerCase() !== 'none';
    if (!rules.length && !hasTr) return '';
    rules.unshift('{{SELECTOR}} { transition: ' + (hasTr ? tr : 'transform .15s ease') + '; }');
    return rules.join('\n');
  };
  // Preset Custom CSS (advanced) = only what the native fields can't hold: the hover MOTION (+ transition) and,
  // for a MULTI-LAYER shadow (inset highlight + drop), the exact full box-shadow — the native Box Shadow field
  // holds one layer (the most visible). Native first, the rest advanced. Parity with the PHP stitch.
  const presetCustomCss = (g) => {
    let css = hoverTransformCss(g);
    const sh = String(g.shadow || '').trim();
    if (shadowLayers(sh) >= 2 && /^[a-z0-9()%.,\s#-]+$/i.test(sh)) css = (css ? css + '\n' : '') + '{{SELECTOR}} { box-shadow: ' + sh + '; }';
    return css;
  };
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
    // GRADIENT FILL → the preset's native Background Gradient (gradient-v2). Parity with the PHP stitch, which
    // emits $def_state['gradient'] from parse_linear_gradient(); the solid bg_color stays empty so the gradient shows.
    if (g.grad) { const gv = parseLinearGradient(g.grad); if (gv) defState.gradient = gv; }
    colors.push({
      id: roleId[name] || ('00000000' + (colors.length + 1)),
      color_name: name,
      // slug + role let to-pages.mjs _buttonPresetFor() match a body button to this preset (parity with the
      // PHP stitch). slug mirrors the plugin's choice key `btn-` + sanitize_title_with_dashes(color_name).
      slug: String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
      role: String(name).toLowerCase(),
      // Typography on the NATIVE font field (shows in the UI, one .btn-{slug} rule) — not Custom CSS.
      font,
      // Custom CSS holds ONLY the source's hover/active MOTION (transform + its transition) — parity with PHP.
      custom_css: presetCustomCss(g),
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
    if (!hit) { hit = { fsn, pxn, pyn, hn, count: 0, modes: {}, names: {} }; clusters.push(hit); }
    hit.count++;
    // The source's OWN size name on this button (btn-sm / btn-lg / button--large / btn-xl …) — a vote for the
    // cluster's name. Same "the author already named it" principle as the colour roles. Parity with PHP.
    const snm = (' ' + String(s.cls || '').toLowerCase() + ' ').match(/\s(?:btn|button|cta)[-_]{1,2}(xxs|xs|sm|md|lg|xl|xxl|2xl|small|medium|large|x-?small|x-?large|2x-?large|2x-?small)\s/);
    if (snm) hit.names[snm[1]] = (hit.names[snm[1]] || 0) + 1;
    for (const [p, val] of Object.entries({ fs: s.fs, px: s.px, py: s.py, radius: s.radius, height: s.height || '', lh: s.lh })) {
      const v = String(val); (hit.modes[p] = hit.modes[p] || {})[v] = (hit.modes[p][v] || 0) + 1;
    }
  }
  const mode = (counts) => { if (!counts) return ''; let best = '', bc = -1; for (const [k, v] of Object.entries(counts)) { if (v > bc) { bc = v; best = k; } } return best; };
  const sizeDefs = clusters.map((c) => {
    const rep = {}; for (const p of ['fs', 'px', 'py', 'radius', 'height', 'lh']) rep[p] = mode(c.modes[p]);
    rep._visual = Math.max(c.hn, c.fsn * 1.3 + 2 * c.pyn); rep._fs = c.fsn; rep._count = c.count; rep._srcname = mode(c.names); return rep;
  });
  // Rank by visual size, then font-size (same-height tie), then frequency.
  sizeDefs.sort((a, b) => (b._visual - a._visual) || (b._fs - a._fs) || (b._count - a._count));
  let domIdx = 0, domCt = -1;
  sizeDefs.forEach((d, i) => { if (d._count > domCt) { domCt = d._count; domIdx = i; } });
  // NAMING — a size name describes a button RELATIVE to the site's normal button: (a) the source's OWN size
  // names win (btn-sm / btn-lg / button--large …); (b) otherwise the MOST-USED size is "Default" (slug md) and
  // the rest are named by where they sit relative to it — bigger → Large, X-Large, 2X-Large; smaller → Small,
  // X-Small, 2X-Small. 1 size → Default; 2 → Default + Large (or + Small); 3 → Small / Default / Large.
  // EXACT mirror of the PHP stitch.
  const defs = sizeDefs.slice(0, 7);
  const ladder = { xxl: ['2X-Large', 'xxl', '0000010006'], xl: ['X-Large', 'xl', '0000010005'], lg: ['Large', 'lg', '0000010004'], md: ['Default', 'md', '0000010003'], sm: ['Small', 'sm', '0000010002'], xs: ['X-Small', 'xs', '0000010001'], xxs: ['2X-Small', 'xxs', '0000010000'] };
  const srcSlug = (n) => { n = String(n || '').toLowerCase().replace(/[_ ]/g, '-'); const map = { small: 'sm', medium: 'md', large: 'lg', 'x-small': 'xs', xsmall: 'xs', 'x-large': 'xl', xlarge: 'xl', '2x-large': 'xxl', '2xlarge': 'xxl', '2xl': 'xxl', '2x-small': 'xxs', '2xsmall': 'xxs' }; return map[n] || n; };
  const assigned = {}, used = {}, auto = {};
  defs.forEach((s, i) => { const sl = srcSlug(s._srcname); if (sl && ladder[sl] && !used[sl]) { assigned[i] = sl; used[sl] = true; } });
  const up = ['lg', 'xl', 'xxl'], down = ['sm', 'xs', 'xxs'];
  if (assigned[domIdx] === undefined && !used.md) { assigned[domIdx] = 'md'; used.md = true; }
  const anchor = assigned[domIdx] !== undefined ? domIdx : -1;
  let ui = 0, di = 0;
  defs.forEach((s, i) => {
    if (assigned[i] !== undefined) return;
    const bigger = (anchor < 0) ? (i < domIdx) : (i < anchor);
    const pool = bigger ? up : down; let sl = '';
    while (!sl) { const cand = bigger ? pool[ui] : pool[di]; if (!cand) break; if (bigger) ui++; else di++; if (!used[cand]) sl = cand; }
    if (!sl) return;
    assigned[i] = sl; used[sl] = true; auto[i] = true;
  });
  const freeUp = up.filter((u) => !Object.keys(assigned).some((j) => assigned[j] === u && !auto[j]));
  const above = Object.keys(assigned).map(Number).filter((i) => auto[i] && up.includes(assigned[i])).sort((a, b) => b - a);
  above.forEach((i, k) => { if (freeUp[k]) assigned[i] = freeUp[k]; });
  const sizes = [];
  defs.forEach((s, i) => {
    if (assigned[i] === undefined) return;
    const [nm0, slug, sid] = ladder[assigned[i]];
    const nm = (i === domIdx && defs.length > 1 && slug !== 'md') ? nm0 + ' (Default)' : nm0;
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
  // A colour for a custom colour field: translucent (alpha < 1) keeps its rgba() so a hairline stays a hairline;
  // opaque → #hex (PHP color_keep_alpha).
  const keepAlpha = (c) => {
    const m = /^rgba?\(\s*([0-9.]+)[,\s]+([0-9.]+)[,\s]+([0-9.]+)(?:[,\s\/]+([0-9.]+%?))?\s*\)$/i.exec(String(c || '').trim());
    if (!m) return String(c || '').trim();
    const a = m[4] === undefined ? 1 : (m[4].includes('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    if (a < 0.99) return String(c).replace(/\s+/g, ' ');
    return '#' + [m[1], m[2], m[3]].map((v) => Math.max(0, Math.min(255, Math.round(+v))).toString(16).padStart(2, '0')).join('');
  };
  // ONE linear-gradient → gradient-v2 data { type, angle, stops }; null for a multi-layer stack / radial (PHP parse_linear_gradient).
  const parseLinearGradient = (css) => {
    css = String(css || '').trim();
    if ((css.match(/[a-z-]*gradient\(/gi) || []).length > 1) return null;
    const m = /linear-gradient\(\s*(.+)\)\s*$/is.exec(css); if (!m) return null;
    const parts = []; let buf = '', depth = 0;
    for (const ch of m[1]) { if (ch === '(') depth++; else if (ch === ')') depth--; if (ch === ',' && depth === 0) { parts.push(buf.trim()); buf = ''; continue; } buf += ch; }
    if (buf.trim()) parts.push(buf.trim());
    let angle = 180;
    if (/^-?[0-9.]+deg$/.test(parts[0] || '')) { angle = parseFloat(parts.shift()); }
    else if (/^to /i.test(parts[0] || '')) { const map = { top: 0, right: 90, bottom: 180, left: 270, 'top right': 45, 'bottom right': 135, 'bottom left': 225, 'top left': 315 }; const d = parts.shift().slice(3).trim().toLowerCase(); angle = map[d] !== undefined ? map[d] : 90; }
    const stops = []; const n = parts.length;
    parts.forEach((part, i) => { const pm = /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))\s*([0-9.]+)?%?/.exec(part); if (!pm) return; stops.push({ color: pm[1], position: pm[2] !== undefined && pm[2] !== '' ? parseFloat(pm[2]) : (n > 1 ? Math.round(i * 100 / (n - 1)) : 0) }); });
    return stops.length >= 2 ? { type: 'linear', angle, stops } : null;
  };

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
  // HEADER CTAs — EVERY masthead action (home.header.ctas, DOM order), each resolved through the SHARED
  // button-preset resolver (button-match.mjs) to the colour + size preset matching its OWN skin, exactly as
  // body buttons are. The presets are built here (once; re-used for the emitted button_colors/button_sizes
  // below). A CTA the resolver can't place falls back to its fill-class role (first CTA only — the legacy
  // single-CTA read) and to Default size; the style falls back to '' (the bare `.btn`, which the theme
  // generator maps the source's own button onto) — parity with PHP tokens_to_theme_settings_chrome().
  const btnPresets = buildButtonPresets(home);
  const btnResolver = makeButtonResolver(btnPresets);
  const hasLgSize = !!(btnPresets && (btnPresets.button_sizes || []).some((s) => s.slug === 'lg'));
  const homeCta = (home && home.header && home.header.cta) || {};
  const homeHdr = (home && home.header) || {};
  const right = [];
  // SECONDARY TEXT LINKS (home.header.textLinks): "Sign in" beside the CTA → list_items ahead of the buttons (PHP: textLinks).
  (Array.isArray(homeHdr.textLinks) ? homeHdr.textLinks : []).forEach((tl, i) => {
    if (!tl || !tl.label) return;
    const tcls = 'sc-hdr-link' + (i > 0 ? '-' + (i + 1) : '');
    const node = el('list_item', { li_text: tl.label, li_link_type: 'url', li_link: tl.href || '#', li_target: '_self' });
    node.element_css_class = tcls; right.push(node);
    const d = ['white-space:nowrap'];
    for (const [k, v] of [['color', tl.color], ['font-size', tl.fontSize], ['font-weight', tl.fontWeight], ['letter-spacing', tl.letterSpacing], ['text-transform', tl.textTransform]]) if (v && !/^(none|normal)$/i.test(String(v))) d.push(k + ':' + v);
    miscCssParts.push('\n/* Source header text link */\n.site-header .' + tcls + ' .list-item, .site-header .' + tcls + ' .list-item a{' + d.join(';') + ';}');
    if (tl.hover && tl.hover.color) miscCssParts.push('\n.site-header .' + tcls + ' .list-item a:hover{color:' + tl.hover.color + ';}');
  });
  let ctas = Array.isArray(homeHdr.ctas) ? homeHdr.ctas : [];
  if (!ctas.length && header.cta && header.cta.enabled && header.cta.label) ctas = [{ label: header.cta.label, href: header.cta.href || '', cls: '', bs: null }];
  ctas.forEach((c, i) => {
    const res = (c.cls || c.bs) ? btnResolver.presetFor(c) : { style: '', size: '' };
    const style = res.style || (i === 0 && homeCta.style ? homeCta.style : '');
    const size = res.size || (hasLgSize ? 'btn-lg' : 'btn-md');
    right.push(el('cta_button', { cta_text: c.label, cta_link: c.href || '#', cta_style: style, cta_size: size }));
  });
  // TEXT CHIPS (home.header.chips) → native list_item elements: text + an SVG dot icon, the source's responsive
  // hide as the element's Hide On, the pill skin as scoped CSS keyed by the element CSS Class (parity w/ PHP).
  const chipEls = [];
  const _clear = (c) => { c = String(c || '').trim().toLowerCase(); return c === '' || c === 'transparent' || /rgba?\([^)]*[,/]\s*0\s*\)/.test(c); };
  (Array.isArray(homeHdr.chips) ? homeHdr.chips : []).forEach((chip, i) => {
    const ccls = 'sc-hdr-chip' + (i > 0 ? '-' + (i + 1) : '');
    const li = { li_text: chip.text, li_link_type: 'none', li_link: '' };
    if (chip.dot) {
      const sz = chip.dot.size;
      li.li_icon = { type: 'svg', 'svg-source': 'inline', 'svg-id': '', markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="' + sz + '" height="' + sz + '" aria-hidden="true"><circle cx="5" cy="5" r="5" fill="' + String(chip.dot.color).replace(/"/g, '&quot;') + '"/></svg>' };
    }
    const node = el('list_item', li);
    if (Array.isArray(chip.hide) && chip.hide.length) node.visibility = chip.hide;
    node.element_css_class = ccls;
    chipEls.push(node);
    // Only properties the source set are carried (no invented defaults) — same list/order as PHP header_chip_css().
    const cs = chip.cs || {}; const d = ['display:inline-flex', 'align-items:center', 'white-space:nowrap'];
    for (const [k, p] of [['gap', 'gap'], ['padding', 'padding'], ['borderRadius', 'border-radius'], ['backgroundColor', 'background-color'], ['color', 'color'], ['fontSize', 'font-size'], ['fontWeight', 'font-weight'], ['letterSpacing', 'letter-spacing'], ['textTransform', 'text-transform'], ['lineHeight', 'line-height'], ['boxShadow', 'box-shadow']]) {
      const v = String(cs[k] || '').trim();
      if (!v || v === 'normal' || v === 'none' || v === '0px' || (p === 'background-color' && _clear(v))) continue;
      d.push(p + ':' + v);
    }
    if (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle && cs.borderTopStyle !== 'none' && cs.borderTopColor) d.push('border:' + cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor);
    const sel = '.site-header .' + ccls;
    let css = '\n/* Source header chip */\n' + sel + ' .list-item{' + d.join(';') + ';}';
    if (chip.dot) { const sz = chip.dot.size; css += sel + ' .list-item__icon{width:' + sz + 'px;height:' + sz + 'px;border-radius:999px;' + (chip.dot.shadow ? 'box-shadow:' + chip.dot.shadow + ';' : '') + '}' + sel + ' .list-item__icon svg{width:' + sz + 'px;height:' + sz + 'px;display:block;}'; }
    miscCssParts.push(css);
  });
  // TWO-ROW masthead (home.header.rows): the brand row keeps logo · chips · CTAs and the links-only nav row
  // becomes the native Bottom Bar (or Top Bar) carrying the menu — assembled below once header_layout exists.
  const hdrRows = (homeHdr.rows && homeHdr.rows.nav_pos) ? homeHdr.rows : null;
  values.header_main = hdrRows
    ? { main_left: [el('logo')], main_center: chipEls, main_right: right }
    : { main_left: [el('logo')], main_center: [el('menu_area', { menu_location: 'primary' })], main_right: chipEls.concat(right) };

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
  // Active/hover fallback: when no hover is captured, brighten the BASE nav colour (a translucent link like
  // rgba(255,255,255,.6) → the same at ~.9 alpha) so the active/current item stays in the nav's palette,
  // instead of leaving it empty and letting the theme paint `.current-menu-item` with --color-primary (brand
  // green). Mirror of PHP's menu_link_hover_color fallback.
  const _baseNav = navColor || (headerDark ? '#cbd5e1' : ink);
  const _brighten = (c) => { const m = String(c || '').match(/^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/i); return (m && parseFloat(m[4]) < 0.9) ? `rgba(${m[1]}, ${m[2]}, ${m[3]}, 0.9)` : c; };
  const _hoverFinal = navHover || (String(_baseNav).trim() !== '' ? _brighten(_baseNav) : (headerDark ? '#ffffff' : (accent || ink)));
  values.header_menu = {
    menu_link_color: hex(navColor || (headerDark ? '#cbd5e1' : ink)),
    menu_link_hover_color: hex(_hoverFinal),
  };
  // NEVER-DROP menu typography — FONT FAMILY / size / weight / letter-spacing / uppercase. Font family was
  // previously only in the .sc-menu generated CSS; route it into the native menu_font option.
  // Link padding (PHP H3 parity): the median measured inset when the links carry one; PADDING-LESS links (a
  // flex row spaced by its gap) pin both insets to 0 — the theme's default 0.5rem × 1rem inset otherwise
  // inflates every item box — and the row's gap rides as a scoped rule (no native menu-gap field).
  {
    const pads = navLinks0.map((n) => (n && n.computed) || {}).filter((c) => c.paddingLeft !== undefined || c.paddingTop !== undefined);
    if (pads.length >= 2) {
      const med = (arr) => { if (!arr.length) return 0; const s = arr.slice().sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; };
      const pxs = pads.map((c) => parseFloat(c.paddingLeft)).filter((n) => n > 0);
      const pys = pads.map((c) => parseFloat(c.paddingTop)).filter((n) => n > 0);
      if (pxs.length) values.header_menu.menu_link_padding_x = { value: Math.round(med(pxs)), unit: 'px' };
      if (pys.length) values.header_menu.menu_link_padding_y = { value: Math.round(med(pys)), unit: 'px' };
      if (!pxs.length && !pys.length) {
        values.header_menu.menu_link_padding_x = { value: 0, unit: 'px' };
        values.header_menu.menu_link_padding_y = { value: 0, unit: 'px' };
        if (homeHdr.navGap > 0) miscCssParts.push('\n/* Source nav item gap (padding-less links) */\n.site-header .primary-menu{gap:' + homeHdr.navGap + 'px;}');
      }
    }
  }
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
  // Include the header ELEMENT: many sources frost the <header> itself rather than an inner bar,
  // and those were coming through as header_glass:'no' — the frost was dropped entirely.
  const restBlur = _hasBlur(_hbar.backdropFilter) || _hasBlur(_hel.backdropFilter) || _hasBlur(_hsTop.backdrop);
  // The header ELEMENT's own bottom border (a plain-CSS `.header{border-bottom:1px solid …}`) is the
  // hairline on most non-utility sites — read it alongside the inner bar / scroll-snapshot borders.
  const _helBorder = (parseFloat(_hel.borderBottomWidth) > 0 && _hel.borderBottomStyle && _hel.borderBottomStyle !== 'none')
    ? (_hel.borderBottomWidth + ' ' + _hel.borderBottomStyle + ' ' + (_hel.borderBottomColor || '')) : '';
  const restBorder = _hasBorder(_hbar.border) || _hasBorder(_hsTop.borderBottom) || _hasBorder(_helBorder);
  const restShadow = _hasShadow(_hsTop.shadow) || _hasShadow(_hbar.boxShadow) || _hasShadow(_hel.boxShadow);
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
  /* --- NUMERIC refinements of the two-state model (theme 2.5.90). The booleans above say a header
     frosts / shadows / shrinks; these say by HOW MUCH, which is the difference between "behaves like
     the source" and "matches it". Every one is derived from a signal the capture already carries. --- */
  const _blurPx = (v) => { const m = /blur\(\s*([0-9.]+)px/.exec(String(v || '')); return m ? Math.round(parseFloat(m[1])) : null; };
  const _satOf  = (v) => { const m = /saturate\(\s*([0-9.]+)(%?)/.exec(String(v || '')); if (!m) return null;
                           const n = parseFloat(m[1]); return Math.round(m[2] === '%' ? n : n * 100); };
  // Shadow depth from the blur radius of the FIRST length triple — soft < 12px, strong > 26px.
  // `0 1px 4px` is as common as `0px 1px 4px` — a unitless zero is legal CSS, so the third length
  // (the blur radius) must be found without demanding `px` on the first two.
  const _shadowDepth = (v) => { const m = /(-?[0-9.]+)(?:px)?\s+(-?[0-9.]+)(?:px)?\s+(-?[0-9.]+)px/.exec(String(v || ''));
                                if (!m) return ''; const b = parseFloat(m[3]);
                                return b < 12 ? 'soft' : (b > 26 ? 'strong' : 'medium'); };
  const _unit = (px) => ({ value: String(Math.round(px)), unit: 'px' });
  // Colours elsewhere in this mapper are hex strings; a captured computed style is rgb()/rgba().
  const _rgbHex = (v) => { const m = /rgba?\(\s*([0-9.]+)[,\s]+([0-9.]+)[,\s]+([0-9.]+)/.exec(String(v || ''));
    if (!m) return String(v || '');
    const h = (n) => Math.max(0, Math.min(255, Math.round(parseFloat(n)))).toString(16).padStart(2, '0');
    return '#' + h(m[1]) + h(m[2]) + h(m[3]); };

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
  // Two-row masthead: the at-rest height the theme applies to its main row is the BRAND row's own height,
  // not the two source rows stacked (the nav row is laid out as its own Bottom / Top Bar).
  if (hdrRows && hdrRows.brand_height >= 32) values.header_layout.min_height = _unit(hdrRows.brand_height);
  // A 1px hairline in the SOURCE's own colour (often a faint translucent tint) — the native toggle draws the
  // theme's default hairline tint; reproduce the exact rule so the line reads the same (parity w/ PHP).
  {
    const _bsrc = [_helBorder, _hbar.border, _hsTop.borderBottom].find(_hasBorder) || '';
    const _bcol = _colOf(_bsrc);
    if (restBorder && _bcol && /^(?:#[0-9a-f]{3,8}|rgba?\([^)]*\))$/i.test(_bcol) && (parseFloat(_bsrc) || 1) < 2) {
      miscCssParts.push('\n/* Source header hairline colour */\n.site-header.site-header--border{box-shadow:none !important;border-bottom:1px solid ' + _bcol + ' !important;}');
    }
  }
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

    // Scrolled Header Height — the exact stuck height, not just "it shrinks". Only when the capture
    // measured both states and the change is real (>4px) and sane (>=32px).
    const _th = parseFloat(_hsTop.height), _sh = parseFloat(_hsScr.height);
    if (isFinite(_th) && isFinite(_sh) && _sh >= 32 && Math.abs(_th - _sh) > 4) {
      values.header_layout.scroll_height = _unit(_sh);
      // min-height loses to taller CONTENT, so a target height alone will not shrink the bar unless
      // the logo scales with it — mirror of the PHP twin.
      values.header_layout.scroll_shrink = 'yes';
    }
    // Scrolled Link Color — a header that lands on a solid bar usually darkens its nav text. Map it
    // only when it actually differs from the resting colour.
    const _tlc = _colOf(_hsTop.linkColor), _slc = _colOf(_hsScr.linkColor);
    if (_slc && _tlc && _slc !== _tlc) { values.header_layout.scroll_link_color = hex(_slc); }
  }
  // Glass blur + saturation — the frost RADIUS was previously fixed at 10px whatever the source used.
  // Prefer whichever state actually has a blur (a clear-then-frosted header only blurs when stuck).
  {
    // Pick the first source that actually HAS a blur - a plain `||` chain stops at the string
    // 'none', which every non-frosted element reports, and would never reach the real one.
    const _bsrc = [_hsScr.backdrop, _hbar.backdropFilter, _hel.backdropFilter, _hsTop.backdrop].find(_hasBlur) || '';
    const _b = _blurPx(_bsrc);
    if (_b !== null && _b > 0 && _b !== 10) { values.header_layout.header_glass_blur = _unit(_b); }
    const _sat = _satOf(_bsrc);
    if (_sat !== null && _sat >= 100 && _sat <= 200 && _sat !== 140) { values.header_layout.header_glass_saturate = _sat; }
    // A source that blurs WITHOUT saturating must say so — the theme's frost adds saturate(1.4) by
    // default, which over-saturates against a literal blur-only source. (PHP twin does this too.)
    else if (_sat === null && _b !== null && _b > 0) { values.header_layout.header_glass_saturate = 100; }
  }
  // Shadow depth — the toggles emit one fixed shadow; grade it from the source's blur radius.
  {
    const _shsrc = [_hsScr.shadow, _hsTop.shadow, _hbar.boxShadow, _hel.boxShadow].find(_hasShadow) || '';
    const _d = _shadowDepth(_shsrc);
    if (_d && _d !== 'medium') { values.header_layout.header_shadow_depth = _d; }
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
  } else if ((restBlur || restShadow) && _isClear(_hel.backgroundColor) && !_isClear(_hbar.backgroundColor)) {
    // A FLOATING PILL (transparent header root, blurred/shadowed inner bar with a fill) has NO max-width —
    // it hugs its content and is centered by the header's transform. Cap it to pill scale so it doesn't
    // stretch edge-to-edge in the flow layout. Mirror of detect_header_chrome_styles()'s pill_width fallback.
    values.header_layout.container = 'container';
    values.header_layout.container_width = { value: '1024', unit: 'px' };
  } else if (/^(none|100%|full)$/i.test(String(barMw).trim())) {
    values.header_layout.container = 'container-fluid';
    // A full-width bar keeps the SOURCE's own side inset (the theme's fluid container pads by the site gutter
    // otherwise); the Bottom/Top Bar row already carries its padding, so its inner container goes flush. PHP twin.
    const _padX = (hdrRows && hdrRows.brand_pad_x) || (() => {
      const p = String(_hbar.padding || _hel.padding || '').trim().split(/\s+/).map(parseFloat);
      if (!p.length || isNaN(p[0])) return 0;
      const l = p.length === 1 ? p[0] : (p.length === 4 ? p[3] : p[1]);
      return l > 0 ? Math.round(l) : 0;
    })();
    if (_padX > 0) miscCssParts.push('\n/* Source header side inset (full-width bar) */\n.site-header .header-main .fw-container-fluid{padding-left:' + _padX + 'px;padding-right:' + _padX + 'px;}');
    if (hdrRows) miscCssParts.push('.site-header .header-bottombar .fw-container-fluid,.site-header .header-topbar .fw-container-fluid{padding-left:0;padding-right:0;}');
  }

  /* --- footer colors (background-pro shape for the fill) --- */
  const footerBg = colors.footer_bg || '#141414';
  const footerText = colors.footer_text || '#94a3b8';
  values.footer_background = { color: { value: { predefined: '', custom: footerBg } } };
  values.footer_text_color = hex(footerText);
  values.footer_link_color = hex(footerText);
  // A GRADIENT footer background (PHP parity): one linear layer → the native gradient; a multi-layer stack →
  // the whole value verbatim on .footer (the native field holds one layer).
  {
    const _fbgi = String(((home && home.footer && home.footer.computed) || {}).backgroundImage || '').trim();
    if (_fbgi && /gradient/.test(_fbgi) && !/url\(/.test(_fbgi)) {
      const gv = parseLinearGradient(_fbgi);
      if (gv) values.footer_background.gradient = { data: gv };
      else miscCssParts.push('.footer{background-image:' + _fbgi + ';}');
    }
  }

  /* --- footer numeric refinements (theme 2.5.92). The footer's own captured computed styles carry
     padding; the column gap and link-hover colour come from the footer chrome probe. --- */
  {
    const _f = (home && home.footer) || {};
    const _fc = _f.computed || {};
    // Padding: the Spacing-Scale select tops out at 8rem (128px), so anything larger used to clamp
    // and silently lose up to 112px. Emit the exact override only when the source is off-scale.
    const SCALE_PX = [0, 4, 8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 96, 112, 128];
    const _onScale = (px) => SCALE_PX.some((v) => Math.abs(v - px) <= 1);
    const _sides = String(_fc.padding || '').trim().split(/\s+/).map((v) => parseFloat(v));
    if (_sides.length >= 1 && isFinite(_sides[0])) {
      const top = _sides[0];
      const bottom = isFinite(_sides[2]) ? _sides[2] : top;
      if (top > 0 && !_onScale(top)) { values.footer_padding_top_custom = _unit(top); }
      if (bottom > 0 && !_onScale(bottom)) { values.footer_padding_bottom_custom = _unit(bottom); }
    }
    // Column gap — was a fixed 40px; 80% of real footers differ (48px most common).
    const _gap = parseFloat(_f.colGap);
    if (isFinite(_gap) && _gap >= 0 && Math.abs(_gap - 40) > 2) { values.footer_col_gap = _unit(_gap); }
    // Link hover colour — 90% of footers change it; the theme used to only fade the rest colour.
    const _fh = _colOf(_f.linkHoverColor);
    const _fr = _colOf(_f.linkColor);
    if (_fh && (!_fr || _fh !== _fr)) { values.footer_link_hover_color = hex(_rgbHex(_fh)); }
    // Columns kept on a phone — the footer otherwise stacks unconditionally under 768px.
    if (Number(_f.mobileColumns) >= 2) { values.footer_mobile_columns = '2'; }
  }
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
  // The source container's DECLARED side gutter (capture stamp data-sc-content-gutter, from a
  // `min(1440px, calc(100% - 48px))` shell → 24) → the native Container Gutter, so the flexbox Content Width cap
  // (`min(cap, 100% - 2×gutter)`) keeps the source's exact inset at every viewport. PHP: declared_container_gutter.
  if (home && home.contentGutter > 0) values.general_layout = Object.assign({}, values.general_layout, { layout_container_gutter: { value: String(home.contentGutter), unit: 'px' } });
  // PAGE-WIDE fixed video backdrop → Site Background → video (FIXED): the theme prints it once behind every transparent
  // section (unysonplus_render_site_bg_video). PHP parity: tokens_to_theme_settings_chrome detect_page_fixed_video.
  if (home && typeof home.pageShellCss === 'string' && home.pageShellCss.trim()) miscCssParts.push('\n/* Source page shell (main) */\n' + home.pageShellCss.trim()); // PHP: page_shell_css
  if (home && home.pageFixedPattern && home.pageFixedPattern.image) {
    // the same deterministic id to-presets mints (djb2 of the image) — the pattern preset must exist for the option to resolve
    const id = 'captured-' + (() => { const s = String(home.pageFixedPattern.image).trim(); let h = 5381; for (let j = 0; j < s.length; j++) h = ((h << 5) + h + s.charCodeAt(j)) >>> 0; return h.toString(16).padStart(8, '0').slice(0, 8); })();
    values.general_layout = Object.assign({}, values.general_layout, { site_background_pattern: { pattern: id } });
  }
  if (home && home.pageFixedVideo && (home.pageFixedVideo.mp4 || home.pageFixedVideo.webm)) {
    const pfv = home.pageFixedVideo;
    const video = { enabled: 'yes', position: 'fixed', loop: 'yes', autoplay: 'yes', mute: 'yes', playsinline: 'yes' };
    if (pfv.mp4) video.source_mp4 = { url: pfv.mp4, attachment_id: '' };
    if (pfv.webm) video.source_webm = { url: pfv.webm, attachment_id: '' };
    if (pfv.poster) video.poster = { url: pfv.poster, attachment_id: '' };
    const gl = Object.assign({}, values.general_layout);
    gl.site_background = Object.assign({}, gl.site_background || {}, { video });
    values.general_layout = gl;
    // the layer's own geometry (a right-anchored 60vw layer), mask, filter and glow — the theme prints the video inset:0 (PHP: page_backdrop_css)
    if (typeof pfv.css === 'string' && pfv.css.trim()) miscCssParts.push('\n/* Site background video layer */\n' + pfv.css.trim());
  }
  // The container's PHONE gutter (data-sc-content-gutter-sm): the native Container Gutter is ONE value, so the phone value
  // rides a max-width:767px --container-gutter override in the misc CSS (the flexbox Content Width cap and .fw-container
  // both read the variable). PHP: declared_container_gutter_sm.
  if (home && home.contentGutterSm > 0 && home.contentGutterSm !== home.contentGutter) miscCssParts.push('\n/* Source container gutter on phones */\n@media (max-width:767px){:root{--container-gutter:' + home.contentGutterSm + 'px !important;}}');
  let siteBox = 0;
  for (const cwv of [barMwNum, fMaxNum]) { const n = parseFloat(cwv); if (!isNaN(n)) siteBox = Math.max(siteBox, Math.round(n)); }
  // No header / footer container to read? The capture's stamped site content width (a shell-container site whose
  // masthead is full-width) is ALREADY a content width — emit it directly. PHP twin: detect_site_content_width.
  if (siteBox <= 0 && home && home.contentWidth > 0) {
    // The theme's Container Width is a CONTENT width (its gutter sits outside). A container whose gutter is its own PADDING
    // (`max-w-7xl px-6` — stamped gutter-inside) measures 1280 OUTER, 1232 content: subtract the gutters, or every band renders
    // +2×gutter wider than the source (RECURS x3 in the findings feed). PHP twin: detect_site_content_width.
    let cwPx = home.contentWidth;
    if (home.contentGutterInside && home.contentGutter > 0 && cwPx > 4 * home.contentGutter) cwPx = cwPx - 2 * home.contentGutter;
    values.general_layout = Object.assign({}, values.general_layout, { layout_container_width: { base: { value: '100', unit: '%' }, md: { value: '720', unit: 'px' }, lg: { value: String(cwPx), unit: 'px' } } });
  }
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
        newsletter_title: fn.title,
        newsletter_desc: fn.tagline || '',
        newsletter_email_ph: fn.placeholder || 'Your email address',
        newsletter_button: fn.button || 'Subscribe',
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
  } else if ((home && home.footer) && (home.footer.brand || home.footer.tagline)) {
    const hf = home.footer; // the capture-side footer record (the design-config copy carries only the classic fields)
    // BRAND-ONLY footer (PHP parity): a wordmark / logo beside ONE disclaimer paragraph and no link columns. The paragraph
    // takes its own column when the source lays the two side by side; its type rides the .footer-tagline residual.
    const brandCol = [el('logo')];
    const tg = hf.tagline;
    const tagEl = tg ? { element_type: { element: 'text', text: { text_content: '<p class="footer-tagline">' + String(tg.html || escHtml(tg.text)).replace(/<br\s*\/?>/gi, '<br>') + '</p>' } } } : null;
    const cols = (tagEl && hf.brandRow) ? [brandCol, [tagEl]] : [tagEl ? brandCol.concat([tagEl]) : brandCol];
    const mfc = {}; cols.forEach((c, i) => { mfc['main_footer_col_' + (i + 1)] = c; });
    if (cols.length === 2) mfc.main_footer_split = [{ w: 50, name: '' }, { w: 50, name: '' }];
    values.main_footer_columns = { count: String(cols.length), [String(cols.length)]: mfc };
    if (tg && tg.computed) {
      const c = tg.computed, d = [];
      if (/^[0-9.]+px$/.test(String(c.maxWidth || ''))) d.push('max-width:' + c.maxWidth);
      if (/^[0-9.]+px$/.test(String(c.fontSize || ''))) d.push('font-size:' + c.fontSize);
      if (/^[0-9.]+px$/.test(String(c.lineHeight || ''))) d.push('line-height:' + c.lineHeight);
      if (/^(right|center)$/.test(String(c.textAlign || ''))) d.push('text-align:' + c.textAlign);
      if (/^rgba?\(/.test(String(c.color || ''))) d.push('color:' + c.color);
      if (d.length) miscCssParts.push('.footer-tagline{' + d.map((x) => x + ' !important').join(';') + ';}');
    }
    values._footer_brand_only = true;
  }
  /* --- MEASURED footer column split (PHP footer_measured_split): the main row's grid tracks when their count
     matches the column count and they differ ≥ 5 %. --- */
  {
    const mr = (home && home.footer && home.footer.mainRow) || null;
    const mfcv = values.main_footer_columns;
    if (mr && mfcv && mfcv[mfcv.count] && !mfcv[mfcv.count].main_footer_layout) {
      const tracks = (String(mr.gridTemplateColumns || '').match(/([0-9.]+)px/g) || []).map(parseFloat);
      const n = Object.keys(mfcv[mfcv.count]).filter((k) => /^main_footer_col_\d+$/.test(k)).length;
      const sum = tracks.reduce((a, b) => a + b, 0);
      if (tracks.length === n && n >= 2 && n !== 5 && sum > 0 && (Math.max(...tracks) - Math.min(...tracks)) / sum >= 0.05) {
        const segs = tracks.map((t) => ({ w: Math.round(t / sum * 100), name: '' }));
        segs[0].w += 100 - segs.reduce((a, x) => a + x.w, 0);
        mfcv[mfcv.count].main_footer_split = segs;
      }
    }
  }
  /* --- BOXED BODY (PHP detect_footer_shell / footer_box_values): the footer's content rows in ONE inset panel →
     Footer → Layout → Boxed Body (theme 2.5.96); the bars inside go Full Width; decor strips → pseudo rules. --- */
  const _fsh = (home && home.footer && home.footer.shell) || null;
  const _fcs = (prefix, extra) => { // merge fields into <prefix>_custom_styling.yes
    const key = prefix + '_custom_styling';
    const cur = (values[key] && values[key].yes) ? values[key].yes : {};
    values[key] = { enabled: 'yes', yes: Object.assign(cur, extra) };
  };
  if (_fsh) {
    const f = {};
    const px = (v) => { const m = /^(-?[0-9.]+)px$/.exec(String(v || '').trim()); return m ? parseFloat(m[1]) : null; };
    const mm = String(_fsh.margin || '').trim().split(/\s+/); const ml = px(mm[1] !== undefined ? mm[1] : mm[0]);
    if (_fsh.cappedWidth > 0) f.footer_box_max_width = _unit(Math.round(_fsh.cappedWidth));
    if (ml !== null && ml > 0) f.footer_box_gutter = _unit(Math.round(ml));
    const pp = String(_fsh.padding || '').trim().split(/\s+/); const pt = px(pp[0]); const pr = pp[1] !== undefined ? px(pp[1]) : pt;
    if (pt !== null) f.footer_box_padding_y = _unit(Math.round(pt));
    if (pr !== null) f.footer_box_padding_x = _unit(Math.round(pr));
    const bgv = { color: { value: { predefined: '', custom: '' } } };
    const bgc = String(_fsh.backgroundColor || '');
    if (bgc && bgc !== 'transparent' && !/rgba?\([^)]*[,\/]\s*0\s*\)/.test(bgc)) bgv.color.value.custom = keepAlpha(bgc);
    const bgi = String(_fsh.backgroundImage || '');
    if (bgi && /gradient/.test(bgi) && !/url\(/.test(bgi)) { const gv = parseLinearGradient(bgi); if (gv) bgv.gradient = { data: gv }; else miscCssParts.push('.footer--boxed .footer__body{background-image:' + bgi + ';}'); }
    if (bgv.color.value.custom || bgv.gradient) f.footer_box_background = bgv;
    const edges = Object.values(_fsh.border || {});
    if (edges.length === 4 && new Set(edges).size === 1) {
      const m = /^([0-9.]+)px\s+(\w+)\s+(.+)$/.exec(edges[0]);
      if (m) f.footer_box_border = { width: _unit(Math.max(1, Math.round(parseFloat(m[1])))), style: m[2], color: { predefined: '', custom: keepAlpha(m[3]) } };
    } else if (edges.length) {
      miscCssParts.push('.footer--boxed .footer__body{' + Object.entries(_fsh.border).map(([k, v]) => 'border-' + k + ':' + v).join(';') + ';}');
    }
    const rad = px(_fsh.radius); if (rad !== null && rad > 0) f.footer_box_radius = _unit(Math.round(rad));
    const sh = String(_fsh.boxShadow || '');
    if (sh && sh !== 'none') {
      let first = sh.split(/\),\s*/)[0]; if ((first.match(/\(/g) || []).length > (first.match(/\)/g) || []).length) first += ')';
      let col = ''; const cm = /(rgba?\([^)]*\)|#[0-9a-f]{3,8})/i.exec(first); if (cm) { col = cm[1]; first = first.replace(cm[1], '').trim(); }
      const n = first.replace(/inset/i, '').trim().split(/\s+/).map(px).filter((v) => v !== null);
      if (n.length >= 2) f.footer_box_shadow = { x: Math.round(n[0]), y: Math.round(n[1]), blur: Math.round(n[2] || 0), spread: Math.round(n[3] || 0), color: col, inset: /inset/i.test(first) };
    }
    f.footer_box_copyright_inside = _fsh.copyrightInside ? 'yes' : 'no';
    values.footer_body_box = { enabled: 'yes', yes: f };
    (_fsh.decor || []).slice(0, 2).forEach((k, i) => {
      const d = ['content:""', 'position:absolute', 'pointer-events:none', 'z-index:0'];
      if (k.bottom === '0px' && px(k.height) !== null) d.push('bottom:0'); else if (px(k.top) !== null) d.push('top:' + k.top);
      for (const side of ['left', 'right']) if (px(k[side]) !== null) d.push(side + ':' + k[side]);
      if (px(k.height) !== null) d.push('height:' + k.height);
      if (px(k.width) !== null) d.push('width:' + k.width);
      for (const [prop, key] of [['background-image', 'backgroundImage'], ['background-color', 'backgroundColor'], ['background-size', 'backgroundSize'], ['background-position', 'backgroundPosition'], ['background-repeat', 'backgroundRepeat'], ['opacity', 'opacity'], ['clip-path', 'clipPath'], ['border-radius', 'borderRadius'], ['filter', 'filter'], ['mix-blend-mode', 'mixBlendMode']]) {
        const v = String(k[key] || ''); if (!v || v === 'none' || v === 'normal' || (prop === 'opacity' && v === '1') || (prop === 'border-radius' && v === '0px')) continue; d.push(prop + ':' + v);
      }
      miscCssParts.push('.footer--boxed .footer__body' + (i === 0 ? '::before' : '::after') + '{' + d.join(';') + ';}');
    });
    for (const bp of ['pre_footer', 'main_footer', 'post_footer', 'copyright']) _fcs(bp, { [bp + '_container']: 'container-fluid' });
    // Inside a panel the theme's default 1rem bar padding is replaced by the rows' own measured box.
    if (_fsh.mainRowPadding) { const q = String(_fsh.mainRowPadding).split(/\s+/); const a = /^[0-9.]+px$/.test(q[0]) ? q[0] : '0', b = q[2] !== undefined ? (/^[0-9.]+px$/.test(q[2]) ? q[2] : '0') : a; miscCssParts.push('.footer--boxed .footer__body > .footer-section--main-footer{padding-top:' + a + ';padding-bottom:' + b + ';}'); }
    if (_fsh.copyrightInside) { const mq = String(_fsh.lastRowMargin || '0px').split(/\s+/), pq = String(_fsh.lastRowPadding || '0px').split(/\s+/); const v = (x) => /^[0-9.]+px$/.test(x || '') ? x : '0'; miscCssParts.push('.footer--boxed .footer__body > .footer-section--copyright{margin-top:' + v(mq[0]) + ';padding-top:' + v(pq[0]) + ';padding-bottom:' + v(pq[2] !== undefined ? pq[2] : pq[0]) + ';}'); }
  }
  /* --- COLUMN ALIGNMENT (PHP footer_row_valign): the main row's align-items → Main Footer → Custom Styling. --- */
  {
    const mr = (home && home.footer && home.footer.mainRow) || null;
    const ai = String((mr && mr.alignItems) || '').toLowerCase();
    const va = (ai === 'end' || ai === 'flex-end' || ai === 'last baseline') ? 'end' : (ai === 'center' ? 'center' : '');
    if (va) _fcs('main_footer', { main_footer_valign: va });
  }

  /* --- copyright bar --- */
  let copy = (home && home.footer && String(home.footer.copyright || '').trim()) || '';
  const _lbar = (home && home.footer && home.footer.labelBar) || null;
  if (!copy && values._footer_brand_only) {
    // A brand-only footer with NO © line in the source: the disclaimer paragraph IS its bottom text — no © bar invented.
    delete values._footer_brand_only;
    values.copyright_settings = { enabled: 'no' };
  } else if (!copy && _lbar && Array.isArray(_lbar.cells) && _lbar.cells.length >= 2) {
    // A LABEL BAR (the last row: ≥ 2 short small labels, no © line) IS the source's bottom bar → the Copyright
    // bar's columns as-is, with its typography / hairline; a flex space-between row → Auto Width + Between.
    // PHP parity: the label-bar branch of the copyright composer.
    const n = Math.min(3, _lbar.cells.length);
    const cols = {};
    for (let i = 0; i < n; i++) cols['copyright_col_' + (i + 1)] = [{ element_type: { element: 'text', text: { text_content: '<p>' + escHtml(_lbar.cells[i]) + '</p>' } } }];
    if (_lbar.display === 'flex' && /space-(between|around)|flex-start|flex-end|center/.test(String(_lbar.justifyContent || ''))) { cols.copyright_auto = 'yes'; cols.copyright_justify = String(_lbar.justifyContent).replace(/^space-|^flex-/, ''); }
    const cf = {};
    if (parseFloat(_lbar.borderTopWidth) > 0 && _lbar.borderTopStyle !== 'none' && _lbar.borderTopColor && !/rgba?\([^)]*[,\/]\s*0\s*\)/.test(_lbar.borderTopColor)) {
      cf.copyright_border = { width: _unit(Math.max(1, Math.round(parseFloat(_lbar.borderTopWidth)))), style: _lbar.borderTopStyle, color: { predefined: '', custom: keepAlpha(_lbar.borderTopColor) } };
      cf.copyright_border_sides = ['top']; cf.copyright_border_extent = { mode: 'full' };
    }
    const typo = {};
    const fam = String(_lbar.fontFamily || '').split(',')[0].replace(/["']/g, '').trim(); if (fam) typo.family = fam;
    const fsz = parseFloat(_lbar.fontSize); if (isFinite(fsz)) typo.size = _unit(Math.round(fsz));
    if (/^\d{3}$/.test(String(_lbar.fontWeight || ''))) typo.weight = String(_lbar.fontWeight);
    if (_lbar.color && !/rgba?\([^)]*[,\/]\s*0\s*\)/.test(_lbar.color)) typo.color = keepAlpha(_lbar.color);
    const lsp = parseFloat(_lbar.letterSpacing); if (isFinite(lsp) && lsp !== 0) typo['letter-spacing'] = lsp;
    if (Object.keys(typo).length) cf.copyright_typography = typo;
    _fcs('copyright', cf);
    values.copyright_settings = { enabled: 'yes', yes: { copyright_columns: { count: String(n), [String(n)]: cols }, copyright_custom_styling: values.copyright_custom_styling } };
    delete values.copyright_custom_styling;
    const lb = [];
    if (/^(uppercase|lowercase|capitalize)$/.test(String(_lbar.textTransform || ''))) lb.push('text-transform:' + _lbar.textTransform);
    if (/^-?[0-9.]+px$/.test(String(_lbar.letterSpacing || ''))) lb.push('letter-spacing:' + _lbar.letterSpacing);
    if (/^[0-9.]+px$/.test(String(_lbar.lineHeight || ''))) lb.push('line-height:' + _lbar.lineHeight);
    if (lb.length) miscCssParts.push('.footer .footer-section--copyright{' + lb.join(';') + ';}');
    miscCssParts.push('.footer .footer-section--copyright .builder-text-element p{margin:0;}');
  } else {
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
  }

  /* --- button_colors / button_sizes: presets derived from the source's real button skin (built up front,
     beside header_main, so the header CTAs could resolve against them). --- */
  delete values._footer_brand_only;
  if (btnPresets) Object.assign(values, btnPresets);

  /* --- TWO-ROW MASTHEAD → the nav row becomes the native Bottom Bar (below the brand row) or Top Bar (above
     it): the primary menu in the column matching the source's alignment, the row's rule line as the bar's
     Custom Styling border on the edge facing the brand row, its fill as the bar background, and its exact
     padding / link gap (no native field) as a scoped rule. Always emitted (empty) so a prior conversion's
     bar never persists through the overlay-only importer. Parity with PHP. --- */
  values.header_bottombar = { bottombar_left: [], bottombar_center: [], bottombar_right: [] };
  if (hdrRows) {
    const bar = (hdrRows.nav_pos === 'top' && !(values.header_topbar && (values.header_topbar.topbar_left || []).length)) ? 'topbar' : 'bottombar';
    const barK = 'header_' + bar;
    if (!values[barK] || typeof values[barK] !== 'object') values[barK] = {};
    values[barK][bar + '_' + (hdrRows.align || 'center')] = [el('menu_area', { menu_location: 'primary' })];
    const bcs = {};
    if (hdrRows.border) {
      const bcol = String(hdrRows.border.color);
      // A translucent hairline stays translucent — hex() would drop its alpha into a solid line.
      bcs[bar + '_border'] = { width: { value: String(hdrRows.border.width), unit: 'px' }, style: String(hdrRows.border.style), color: { predefined: '', custom: /^rgba\(/i.test(bcol) ? bcol : _rgbHex(bcol) } };
      bcs[bar + '_border_sides'] = [String(hdrRows.border.side)];
      bcs[bar + '_border_extent'] = { mode: 'full' };
    }
    if (hdrRows.bg) bcs[bar + '_background'] = { color: { value: { predefined: '', custom: _rgbHex(hdrRows.bg) } } };
    if (values.header_layout && values.header_layout.container) bcs[bar + '_container'] = values.header_layout.container;
    if (Object.keys(bcs).length) values[barK][bar + '_custom_styling'] = { enabled: 'yes', yes: bcs };
    const decl = [];
    if (hdrRows.padding) decl.push('padding:' + hdrRows.padding);
    if (hdrRows.nav_height) decl.push('min-height:' + hdrRows.nav_height + 'px');
    // line-height on the BAR: the theme's 30px menu line box is inherited by the inline-block nav wrapper too.
    if (hdrRows.link_lh) decl.push('line-height:' + hdrRows.link_lh + 'px');
    let css = '';
    if (decl.length) css += '\n/* Source nav row (two-row masthead) */\n.site-header .header-' + bar + '{' + decl.join(';') + ';}';
    // The bar's height is the source padding + the links' line box: drop the theme row minimum and pin the
    // menu's line-height to the source links' so the row measures like the source (parity with PHP).
    css += '.site-header .header-' + bar + ' .header-row{min-height:0;}';
    if (hdrRows.link_lh) css += '.site-header .header-' + bar + ' .primary-menu,.site-header .header-' + bar + ' .primary-menu a{line-height:' + hdrRows.link_lh + 'px;}';
    if (hdrRows.gap) css += '.site-header .header-' + bar + ' .primary-menu{gap:' + hdrRows.gap + 'px;}';
    if (css) miscCssParts.push(css);
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
