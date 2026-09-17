// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Style Guide generator — turns a capture into a single, reviewable "Style Guide" page
// (built from page-builder atoms) that VISUALIZES the extracted design system: Colors,
// Typography, Buttons, Spacing + a sample Table. This is the reliable half of a conversion
// (design tokens are captured exactly), so it's generated first as a review artifact before
// the lossy page rebuild. Self-contained: inline styles, so it renders regardless of theme.

import { readFileSync } from 'fs';

const atoms = JSON.parse(readFileSync(new URL('./atom-templates.json', import.meta.url), 'utf8'));

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const uid = () => {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};

export function toStyleGuide(capture, designConfig) {
  const clone = (k) => structuredClone(atoms[k]);
  const stamp = (n) => { if (n.atts) { n.atts.unique_id = uid(); n.atts.css_id = ''; } return n; };

  const textBlock = (html) => {
    const n = stamp(clone('text_block'));
    n.atts.text = html;
    n.atts.css_class = '';
    return n;
  };
  const column = (items) => {
    const c = stamp(clone('column'));
    c.width = '1_1';
    c.atts.css_class = '';
    c._items = items;
    return c;
  };
  const section = (cls, items) => {
    const s = stamp(clone('section'));
    if (s.atts) s.atts.css_class = cls;
    s._items = [column(items)];
    return s;
  };
  // A section = a heading text-block + a body text-block (keeps each topic one editable row).
  const topic = (cls, title, sub, bodyHtml) => section(cls, [
    textBlock(
      `<h2 class="sg-h" style="font-size:1.9rem;font-weight:700;margin:0 0 .15em;">${esc(title)}</h2>` +
      (sub ? `<p class="sg-sub" style="margin:0 0 1.2em;color:#6c757d;">${esc(sub)}</p>` : '')
    ),
    textBlock(bodyHtml),
  ]);

  const cap = capture || {};
  const cfg = designConfig || {};
  const vars = (cap.tokens && cap.tokens.vars) || {};
  const colors = cfg.colors || {};
  const fonts = cfg.fonts || {};
  const cta = (cfg.header && cfg.header.cta && cfg.header.cta.style) || {};
  const sourceName = (cfg.theme && cfg.theme.name) || cap.title || 'Captured Site';

  // hsl token like "217 91% 53%" → a usable hsl() string; pass-through hex/rgb.
  const col = (v) => {
    v = String(v || '').trim();
    if (v === '') return '';
    if (/^(#|rgb|hsl)/i.test(v)) return v;
    if (/^\d+\s+[\d.]+%\s+[\d.]+%$/.test(v)) return `hsl(${v})`;
    return v;
  };

  const builder = [];

  /* ---- intro ---- */
  builder.push(section('sg-intro', [textBlock(
    `<p style="text-transform:uppercase;letter-spacing:.12em;font-size:.8rem;color:#6c757d;margin:0;">Style Guide</p>` +
    `<h1 style="font-size:2.6rem;font-weight:800;margin:.1em 0 .2em;">${esc(sourceName)}</h1>` +
    `<p style="color:#6c757d;margin:0;">Design system extracted from the source — colors, typography, buttons and spacing. Review this before converting the pages.</p>`
  )]));

  /* ---- Colors ---- */
  const swatch = (label, value) => {
    const c = col(value);
    if (!c) return '';
    return `<div style="text-align:center;width:96px;">` +
      `<div style="height:72px;border-radius:10px;background:${esc(c)};border:1px solid rgba(0,0,0,.08);"></div>` +
      `<div style="font-size:12px;font-weight:600;margin-top:7px;">${esc(label)}</div>` +
      `<div style="font-size:11px;color:#888;word-break:break-all;">${esc(c)}</div></div>`;
  };
  // Primary = the detected brand accent FIRST (to-design-config already corrects for sites that
  // bundle Bootstrap's default `--primary` but brand via the CTA), falling back to the raw var.
  const roleColors = [
    ['Primary', colors.accent || vars['--primary']], ['Secondary', vars['--secondary']],
    ['Success', vars['--success']], ['Danger', vars['--danger']],
    ['Warning', vars['--warning']], ['Info', vars['--info']],
    ['Dark', vars['--dark'] || colors.ink], ['Light', vars['--light']],
  ].filter(([, v]) => v);
  const grayKeys = Object.keys(vars).filter((k) => /gray|grey/i.test(k));
  const grays = grayKeys.map((k) => [k.replace(/^--/, ''), vars[k]]);
  if (roleColors.length || colors.accent) {
    builder.push(topic('sg-colors', 'Colors', 'Captured palette (Bootstrap roles + accent).',
      `<div style="display:flex;flex-wrap:wrap;gap:16px;">${roleColors.map(([l, v]) => swatch(l, v)).join('')}</div>` +
      (grays.length ? `<div style="display:flex;flex-wrap:wrap;gap:16px;margin-top:22px;">${grays.map(([l, v]) => swatch(l, v)).join('')}</div>` : '')
    ));
  }

  /* ---- Typography ---- */
  const head = fonts.heading || '';
  const body = fonts.body || '';
  const hf = head ? `font-family:'${head}',serif;` : '';
  const bf = body ? `font-family:'${body}',sans-serif;` : '';
  const heads = [1, 2, 3, 4, 5, 6].map((n) => {
    const size = [2.5, 2, 1.75, 1.5, 1.25, 1][n - 1];
    return `<div style="${hf}font-size:${size}rem;font-weight:700;margin:.15em 0;">H${n} — Irrelevant reason and fallacy.</div>`;
  }).join('');
  const displays = [1, 2, 3].map((n) => {
    const size = [5, 4.5, 4][n - 1];
    return `<div style="${hf}font-size:${size}rem;font-weight:300;line-height:1.1;">Display ${n}</div>`;
  }).join('');
  builder.push(topic('sg-type', 'Typography',
    (head || body) ? `Heading: ${head || '—'}  ·  Body: ${body || '—'}` : '',
    `<div style="margin-bottom:1.4em;">${heads}</div>` +
    `<div style="margin-bottom:1.4em;">${displays}</div>` +
    `<p style="${bf}font-size:1.15rem;color:#333;margin:0 0 .6em;">Lead paragraph — a slightly larger intro line set in the body font.</p>` +
    `<p style="${bf}color:#444;max-width:60ch;margin:0;">Body text. The quick brown fox jumps over the lazy dog. Literally species of nothing. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.</p>`
  ));

  /* ---- Buttons ---- */
  const bbg = col(cta.bg) || col(colors.accent) || '#007bff';
  const bfg = col(cta.color) || '#fff';
  const brad = cta.radius || '6px';
  const bpad = cta.padding || '10px 24px';
  const bwt = cta.font_weight || '600';
  // The captured button shown in its DEFAULT and HOVER states (the outline look is the hover,
  // not a separate button). Inline styles only — the style guide can't carry a <style> block for
  // a real :hover, so the two states are shown side by side and labeled.
  const filled = `display:inline-block;text-decoration:none;background:${esc(bbg)};color:${esc(bfg)};border:2px solid ${esc(bbg)};border-radius:${esc(brad)};padding:${esc(bpad)};font-weight:${esc(bwt)};`;
  const hover = `display:inline-block;text-decoration:none;background:transparent;color:${esc(bbg)};border:2px solid ${esc(bbg)};border-radius:${esc(brad)};padding:${esc(bpad)};font-weight:${esc(bwt)};`;
  const btnState = (label, style) =>
    `<div style="text-align:center;">` +
    `<a href="#" style="${style}">Primary Button</a>` +
    `<div style="font-size:11px;color:#888;margin-top:7px;">${label}</div></div>`;
  builder.push(topic('sg-buttons', 'Buttons', 'Button style captured from the source CTA, shown in its default and hover states.',
    `<div style="display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start;">` +
    btnState('Default', filled) +
    btnState('Hover', hover) +
    `</div>`
  ));

  /* ---- Spacing + Table ---- */
  const scale = [['0', '0'], ['1', '.25rem'], ['2', '.5rem'], ['3', '1rem'], ['4', '1.5rem'], ['5', '3rem']];
  const bars = scale.map(([n, s]) =>
    `<div style="display:flex;align-items:center;gap:12px;margin:6px 0;font-size:13px;">` +
    `<span style="width:18px;color:#6c757d;">${n}</span>` +
    `<span style="height:14px;width:${s === '0' ? '2px' : s};background:${esc(bbg)};border-radius:3px;"></span>` +
    `<span style="color:#888;">${s}</span></div>`).join('');
  const cell = 'padding:8px 12px;border:1px solid #e3e6ea;text-align:left;';
  const table =
    `<table style="border-collapse:collapse;width:100%;max-width:560px;font-size:14px;">` +
    `<thead><tr>${['Name', 'Role', 'Status'].map((h) => `<th style="${cell}background:#f6f7f9;font-weight:700;">${h}</th>`).join('')}</tr></thead>` +
    `<tbody>${[['Item one', 'Primary', 'Active'], ['Item two', 'Secondary', 'Pending']].map((r) =>
      `<tr>${r.map((d) => `<td style="${cell}">${d}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  builder.push(topic('sg-spacing', 'Spacing & Table', 'Spacing scale (0–5) and a sample table.',
    `<div style="margin-bottom:1.6em;">${bars}</div>${table}`
  ));

  return { title: 'Style Guide', slug: 'style-guide', status: 'publish', front_page: false, builder };
}
