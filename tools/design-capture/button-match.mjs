// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// button-match.mjs — the ONE button-preset resolver shared by the theme-settings mapper (header CTAs) and
// the pages mapper (body buttons). Given the built `{button_colors, button_sizes}` presets, it resolves a
// captured button (its classes + computed skin) to the colour preset + size preset matching its OWN skin:
//   style = 'btn-{slug}' / '' · size = 'btn-{slug}' / ''
// Parity with the PHP FW_Site_Converter_Mapper::set_button_presets() / button_preset_for() pair — keep the
// two in step (fixtures: button-presets-parity.test.mjs ↔ tests/golden-fixture-1-test.php [B2]).
//
// Colours are compared as RGBA quads. A glass / translucent skin (`rgba(255,255,255,.2)` fill on a
// `rgba(95,73,42,.08)` hairline) is as real a button as an opaque one; comparing opaque triplets only made
// every such button unmatchable (the alpha was dropped as "no fill" on both sides) — it fell to the bare
// `.btn`. Alpha is weighted so a 0.1 alpha step counts like the 40-unit colour tolerance.
import { parseLinearGradient } from './box-presets.mjs';

/** Any CSS colour → [r, g, b, a] (a defaults to 1), or null for empty / transparent / a gradient. */
export function rgbaQuad(c) {
  c = String(c == null ? '' : c).trim().toLowerCase();
  if (!c || c === 'transparent' || c.includes('gradient')) return null;
  let m = c.match(/rgba?\(\s*(\d{1,3})[,\s]+(\d{1,3})[,\s]+(\d{1,3})(?:[,\s/]+([\d.]+%?))?/);
  if (m) {
    let a = 1;
    if (m[4] != null && m[4] !== '') { a = parseFloat(m[4]); if (m[4].endsWith('%')) a /= 100; }
    if (!(a > 0.02)) return null;
    return [+m[1], +m[2], +m[3], Math.min(1, a)];
  }
  m = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (m) { let h = m[1]; if (h.length === 3) h = h.split('').map((x) => x + x).join(''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1]; }
  // oklch() / oklab() / hsl() with a slash alpha (a glass stone button on an oklch hairline) — PHP rgba_quad parity
  if (/^(?:oklch|oklab|hsla?)\(/.test(c)) { const r = cssToRgbBM(c); if (r) { const a2 = r.length > 3 ? r[3] : 1; if (!(a2 > 0.02)) return null; return [r[0], r[1], r[2], Math.min(1, a2)]; } }
  return null;
}
function cssToRgbBM(c) {
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

/** Opaque-only triplet (alpha ≥ .85) — for gradient stops and text, where translucency is noise. */
export function rgbTriplet(c) { const q = rgbaQuad(c); return q && q[3] >= 0.85 ? [q[0], q[1], q[2]] : null; }

const pxNum = (v) => { const m = String(v == null ? '' : v).trim().match(/^(-?[0-9.]+)\s*px?$/i); return m ? parseFloat(m[1]) : null; };

/**
 * Build the resolver from the built presets (`buildButtonPresets()` output, or the stored theme-settings
 * values). Returns { presets:{colors,sizes}, matchColor(bg,fg,bd), presetFor(button) }.
 * `button` = { cls, bs:{bg,fg,bw,bds,bd,grad}, fontSize|fs, pad } — the capture's per-button skin.
 */
export function makeButtonResolver(bp) {
  const colors = []; const sizes = [];
  const seen = {};
  for (const c of ((bp && bp.button_colors) || [])) {
    let slug = String(c.color_name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) slug = String(c.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!slug) continue;
    const base = slug; let n = 1; while (seen[slug]) { n++; slug = base + '-' + n; } seen[slug] = true;
    const def = (c.states && c.states.default) || {};
    const pick = (f) => (def[f] && (def[f].custom || def[f].predefined)) || '';
    const bgq = rgbaQuad(pick('bg_color')); const fgq = rgbaQuad(pick('text_color')); const bdq = rgbaQuad(pick('border_color'));
    // A GRADIENT-filled preset has no solid bg — keep its first stop so a gradient source button matches it (parity w/ PHP).
    const grad = (def.gradient && def.gradient.stops && def.gradient.stops[0]) ? rgbTriplet(def.gradient.stops[0].color) : null;
    colors.push({ slug, role: String(c.color_name || '').toLowerCase(), bgq, fgq, bdq, grad,
      // opaque triplets kept for callers that still read them
      bg: rgbTriplet(pick('bg_color')), fg: rgbTriplet(pick('text_color')), bd: rgbTriplet(pick('border_color')) });
  }
  for (const s of ((bp && bp.button_sizes) || [])) {
    if (!s || !s.slug) continue;
    const num = (f) => (s[f] && s[f].value !== '' && s[f].value != null ? parseFloat(s[f].value) : null);
    sizes.push({ slug: String(s.slug).toLowerCase().replace(/[^a-z0-9_-]/g, ''), fs: num('font_size'), py: num('padding_y'), px: num('padding_x') });
  }
  const presets = { colors, sizes };

  // RGBA distance: colour channels + alpha (× 400, so a .1 alpha step ≈ the 40-unit colour tolerance).
  const dist = (a, b) => {
    if (!a || !b) return null;
    const aa = a.length > 3 ? a[3] : 1, ba = b.length > 3 ? b[3] : 1;
    return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) + Math.round(Math.abs(aa - ba) * 400);
  };
  const matchColor = (bg, fg, bd) => {
    if (!colors.length) return '';
    let best = '', bestd = Infinity;
    for (const p of colors) {
      let d;
      if (bg && p.bgq) { d = dist(bg, p.bgq); const dt = dist(fg, p.fgq); if (dt != null) d += Math.round(dt / 3); }
      // both borderless/outline — match on the BORDER colour (a real outline button); a button with no border
      // is a plain text link, never matched on text alone.
      else if (!bg && !p.bgq) { if (!bd) continue; d = dist(bd, p.bdq); if (d == null) continue; }
      else continue; // one filled, one not — not comparable
      if (d < bestd) { bestd = d; best = p.slug; }
    }
    return bestd <= 40 ? best : '';
  };

  const presetFor = (b) => {
    const out = { style: '', size: '' };
    if (!colors.length && !sizes.length) return out;
    const lc = ' ' + String(b.cls || '').toLowerCase() + ' ';
    const bs = b.bs || {};
    // COLOR — semantic fill class → the role's preset; else match computed colours.
    let role = '';
    // The source's OWN semantic button name (`btn-primary`, `button-secondary`, `cta-accent`, BEM `btn--outline`, a bare
    // `primary`) resolves to the preset carrying that role — the SAME regex the capture uses to NAME the preset.
    const semM = lc.match(/\s(?:(?:btn|button|cta)[-_]{1,2})?(primary|secondary|accent|outline|ghost|tertiary)(?:[-_][a-z0-9]+)?\s/);
    const sem = semM ? semM[1] : '';
    const hasRole = (r) => colors.some((x) => x.role === r);
    if (sem === 'primary' || /\s(?:bg-primary|bg-brand)\b/.test(lc)) role = 'primary';
    else if ((sem === 'accent' || /\s(?:bg-accent|bg-cta)(?![a-z])/.test(lc)) && hasRole('accent')) role = 'accent';
    else if (sem === 'secondary' || sem === 'accent' || /\s(?:bg-secondary|bg-accent|bg-cta)\b/.test(lc)) role = 'secondary';
    else if (sem) role = 'outline'; // outline / ghost / tertiary
    else if ((/\sbg-white\b/.test(lc) || /\sbg-surface\b/.test(lc)) && /\sborder\b/.test(lc)) role = 'outline';
    let style = '';
    if (role) { const p = colors.find((x) => x.role === role); if (p) style = 'btn-' + p.slug; }
    // A GRADIENT-filled button (transparent bg-color) matches the preset whose gradient starts with the same colour.
    if (!style && !rgbaQuad(bs.bg) && bs.grad) {
      const gv = parseLinearGradient(bs.grad); const g0 = gv && gv.stops[0] ? rgbTriplet(gv.stops[0].color) : null;
      if (g0) {
        let best = '', bestD = Infinity;
        for (const p of colors) { if (!p.grad) continue; const d = Math.abs(g0[0] - p.grad[0]) + Math.abs(g0[1] - p.grad[1]) + Math.abs(g0[2] - p.grad[2]); if (d < bestD) { bestD = d; best = p.slug; } }
        if (best && bestD <= 40) style = 'btn-' + best;
      }
    }
    if (!style) {
      const bg = rgbaQuad(bs.bg); const fg = rgbaQuad(bs.fg);
      // a border only counts with a real width
      const bd = (bs.bw && bs.bw !== '0px' && bs.bw !== '0' && bs.bds && bs.bds !== 'none') ? rgbaQuad(bs.bd) : null;
      if (bg || bd) { const slug = matchColor(bg, fg, bd); if (slug) style = 'btn-' + slug; }
    }
    out.style = style;
    // SIZE — explicit btn-lg/md/sm, else match computed font-size + padding.
    let size = '';
    const m = lc.match(/\sbtn-(lg|md|sm|xl|xs)\b/);
    if (m && sizes.some((s) => s.slug === m[1])) size = m[1];
    if (!size) {
      const fs = pxNum(b.fontSize || b.fs);
      let py = null, px = null;
      const pp = String(b.pad || '').trim().split(/\s+/).map(pxNum);
      if (pp.length) { py = pp[0]; px = pp.length >= 2 ? pp[1] : pp[0]; }
      if (fs != null) {
        for (const s of sizes) {
          if (s.fs == null || Math.abs(s.fs - fs) > 1) continue;
          if (py != null && s.py != null && Math.abs(s.py - py) > 3) continue;
          if (px != null && s.px != null && Math.abs(s.px - px) > 4) continue;
          size = s.slug; break;
        }
        // CLOSEST-MATCH FALLBACK — never leave a real button unassigned (→ thin `.btn` base). Pick the preset
        // nearest in font-size (weighted), then padding, so the button still gets a size class. Parity w/ PHP.
        if (!size) {
          let best = '', bestD = Infinity;
          for (const s of sizes) {
            if (s.fs == null) continue;
            let d = Math.abs(s.fs - fs) * 4;
            if (px != null && s.px != null) d += Math.abs(s.px - px);
            if (py != null && s.py != null) d += Math.abs(s.py - py);
            if (d < bestD) { bestD = d; best = s.slug; }
          }
          size = best;
        }
      }
    }
    out.size = size ? 'btn-' + size : '';
    return out;
  };

  return { presets, matchColor, presetFor };
}
