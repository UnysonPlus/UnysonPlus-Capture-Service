// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// WCAG contrast review for the Site Converter (capture service, JS side).
//
// This is the JS mirror of the PHP FW_Site_Converter_Theme_Generator contrast helpers
// (keep the two in sync — the deterministic-converter sync rule). It DETECTS low-contrast
// text/background pairs in the extracted brand palette and SUGGESTS a nearest-AA shade.
// It NEVER changes the user's colors — a converted site's palette is their brand; we flag
// and propose, the human decides.

const hexRgb = (hex) => {
  let h = String(hex || '').trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgbHex = ([r, g, b]) =>
  '#' + [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
const relLum = (rgb) => {
  const c = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
export function contrast(a, b) {
  const x = hexRgb(a), y = hexRgb(b);
  if (!x || !y) return 0;
  const la = relLum(x) + 0.05, lb = relLum(y) + 0.05;
  return la > lb ? la / lb : lb / la;
}
const rgbHsl = ([r, g, b]) => {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let h = 0, s = 0; const l = (mx + mn) / 2;
  if (mx !== mn) { const d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6; }
  return [h, s, l];
};
const hslRgb = ([h, s, l]) => {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
};
// Suggest the nearest AA-passing shade (keep hue+sat, nudge lightness). Adjusts the fg
// unless it's a greyscale extreme, then adjusts the bg. Returns "text #xxxxxx" / "background #xxxxxx".
export function suggestShade(fg, bg, target = 4.5) {
  const fgr = hexRgb(fg), bgr = hexRgb(bg);
  if (!fgr || !bgr) return '';
  const fh = rgbHsl(fgr), bh = rgbHsl(bgr);
  const fgExtreme = fh[1] < 0.08 && (fh[2] > 0.9 || fh[2] < 0.1);
  const move = fgExtreme ? 'bg' : 'fg';
  const hsl = move === 'fg' ? [...fh] : [...bh];
  const down = relLum(hexRgb(move === 'fg' ? bg : fg)) > 0.18;
  for (let i = 0; i < 100; i++) {
    hsl[2] = Math.max(0, Math.min(1, hsl[2] + (down ? -0.01 : 0.01)));
    const cand = rgbHex(hslRgb(hsl));
    const nf = move === 'fg' ? cand : fg, nb = move === 'fg' ? bg : cand;
    if (contrast(nf, nb) >= target) return (move === 'fg' ? 'text ' : 'background ') + cand;
  }
  return move === 'fg' ? 'dark text (#1a1a1a)' : '';
}

// Check the key text/bg pairs in a design config; return findings below AA (4.5:1).
// Optionally pass the generated presets ({values:{theme_colors:[{name,color}]}}): any
// palette preset whose NAME implies text use (Muted/Text/Ink/Body) is checked against
// the site background too — a 2:1 "Muted" preset silently fails every meta/byline that
// consumes it (the newbingosite #adb5bd incident).
export function contrastReview(config, presets) {
  const col = (config && config.colors) || {};
  const cta = (config && config.header && config.header.cta && config.header.cta.style) || {};
  const btnBg = cta.bg || col.accent || '';
  const pairs = [
    ['Primary button', cta.color || '#ffffff', btnBg],
    ['Heading text', col.heading || '', col.bg || ''],
    ['Body text', col.ink || '', col.bg || ''],
    ['Accent on background (links/badges)', col.accent || '', col.bg || ''],
    ['Footer text', col.footer_text || '', col.footer_bg || ''],
  ];
  const themeColors = (presets && presets.values && presets.values.theme_colors) || [];
  for (const p of themeColors) {
    if (p && typeof p.name === 'string' && typeof p.color === 'string'
        && /muted|text|ink|body/i.test(p.name)) {
      pairs.push([`Palette preset "${p.name}" (text use)`, p.color, col.bg || '#ffffff']);
    }
  }
  const findings = [];
  for (const [label, fg, bg] of pairs) {
    if (!fg || !bg) continue;
    const r = contrast(fg, bg);
    if (r <= 0 || r >= 4.5) continue;
    findings.push({ label, fg, bg, ratio: +r.toFixed(2), suggestion: suggestShade(fg, bg) });
  }
  return findings;
}

// A CSV blob for contrast-review.csv (empty-safe).
export function contrastReviewCsv(findings) {
  const head = 'pair,foreground,background,ratio,below_AA,suggestion';
  const rows = (findings || []).map((f) =>
    [f.label, f.fg, f.bg, f.ratio.toFixed(2), 'yes', f.suggestion].map((v) => {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(','));
  return [head, ...rows].join('\r\n') + '\r\n';
}
