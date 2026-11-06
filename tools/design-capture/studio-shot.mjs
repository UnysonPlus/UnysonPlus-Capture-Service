// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Sharp screenshots for explainers, thumbnails and the docs: whole pages or one element (with padding), at 2x, with
// optional annotations drawn on the page itself (a highlight ring, an arrow, blur over private details, a callout).
//
//   node studio-cli.mjs shot shots.json [--out folder]
//
// shots.json: { site, login?, viewport?, scale?, hide?, shots: [{ name, path?, steps?, element?, full?, pad?,
//   highlight?, arrow?: { to, from? }, blur?: [targets], callout?: { target, text, side? }, rows? }] }
// Targets are the same as the recorder's (a selector string, { text }, { role, name }, { label }).
//
// rows (a selector matching every row, e.g. ".fw-backend-option"): beside the picture, <name>.rows.json measures
// where each matching element sits in it, { width, height, empty, rows: [{ x, y, w, h, label, file }] } in % of the
// picture, for Kinetic Scenes' Animate this screenshot (each row becomes its own layer and animates). Each row is also
// saved as its own picture (<name>.row-N.png), and the screen with the rows hidden as <name>.empty.png, so a scene can
// build the rows onto the real empty screen.

import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HIDE = '.notice,.update-nag,#wpfooter,#screen-meta-links,.primary-menu-notice{display:none!important}';

export async function shots(spec, outDir, onStep = () => {}) {
  const out = resolve(outDir);
  mkdirSync(out, { recursive: true });
  const [vw, vh] = spec.viewport || [1600, 900];
  const scale = spec.scale || 2;
  const site = String(spec.site || '').replace(/\/$/, '');
  const browser = await chromium.launch({ channel: process.env.CAPTURE_CHANNEL || 'chrome', headless: true });
  const made = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: scale });
    const p = await ctx.newPage();
    p.setDefaultTimeout(20000);
    if (spec.login) {
      await p.goto(`${site}/wp-login.php`);
      await p.fill('#user_login', spec.login.user); await p.fill('#user_pass', spec.login.pass);
      await Promise.all([p.waitForNavigation({ waitUntil: 'load' }).catch(() => {}), p.click('#wp-submit')]);
    }
    const target = (t) => (typeof t === 'string' ? p.locator(t).first() : t.text ? p.getByText(t.text, { exact: t.exact ?? true }).first()
      : t.role ? p.getByRole(t.role, { name: t.name }).first() : t.label ? p.getByLabel(t.label).first() : null);
    const rect = async (t) => { const l = target(t); await l.scrollIntoViewIfNeeded().catch(() => {}); const r = await l.boundingBox(); if (!r) throw new Error(`Not on screen: ${JSON.stringify(t)}`); return r; };

    for (const [i, s] of spec.shots.entries()) {
      onStep(`Shot ${i + 1} of ${spec.shots.length}: ${s.name}`);
      if (s.path) await p.goto(site + s.path, { waitUntil: 'load', timeout: 90000 });
      await p.addStyleTag({ content: HIDE + (spec.hide || '') + (s.hide || '') }).catch(() => {});
      for (const st of s.steps || []) {
        if (st.do === 'click') await target(st.target).click();
        else if (st.do === 'type') { if (st.target) await target(st.target).click(); await p.keyboard.type(st.text); }
        else if (st.do === 'wait') await p.waitForTimeout(st.ms || 500);
        else if (st.do === 'hover') await target(st.target).hover();
      }
      await p.waitForTimeout(s.settle ?? 600);

      // Annotations, as page elements (they scale with the page, so they stay crisp at 2x).
      const marks = [];
      if (s.highlight) marks.push({ kind: 'ring', r: await rect(s.highlight) });
      for (const b of s.blur || []) marks.push({ kind: 'blur', r: await rect(b) });
      if (s.arrow) marks.push({ kind: 'arrow', r: await rect(s.arrow.to), from: s.arrow.from || 'top-left' });
      if (s.callout) marks.push({ kind: 'callout', r: await rect(s.callout.target), text: s.callout.text, side: s.callout.side || 'right' });
      const accent = spec.accent || '#6B4CF6';
      await p.evaluate(({ marks, accent }) => {
        document.querySelectorAll('.__ann').forEach((e) => e.remove());
        const add = (html, css) => { const d = document.createElement('div'); d.className = '__ann'; d.innerHTML = html; Object.assign(d.style, { position: 'fixed', zIndex: 2147483647, pointerEvents: 'none' }, css); document.body.appendChild(d); return d; };
        for (const m of marks) {
          const { x, y, width: w, height: h } = m.r;
          if (m.kind === 'ring') add('', { left: `${x - 6}px`, top: `${y - 6}px`, width: `${w + 12}px`, height: `${h + 12}px`, border: `3px solid ${accent}`, borderRadius: '10px', boxShadow: `0 0 0 6px ${accent}33` });
          if (m.kind === 'blur') add('', { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`, backdropFilter: 'blur(9px)', background: 'rgba(255,255,255,.25)', borderRadius: '6px' });
          if (m.kind === 'arrow') {
            const cx = x + w / 2, cy = y + h / 2;
            const off = { 'top-left': [-150, -110], 'top-right': [150, -110], 'bottom-left': [-150, 110], 'bottom-right': [150, 110], left: [-190, 0], right: [190, 0], top: [0, -140], bottom: [0, 140] }[m.from] || [-150, -110];
            const sx = cx + off[0], sy = cy + off[1];
            // End just outside the target's nearest edge.
            const ex = Math.max(x - 8, Math.min(x + w + 8, sx)), ey = Math.max(y - 8, Math.min(y + h + 8, sy));
            const L = Math.min(sx, ex) - 30, T = Math.min(sy, ey) - 40, W = Math.abs(ex - sx) + 60, H = Math.abs(ey - sy) + 80;
            const qx = (sx + ex) / 2 - L, qy = Math.min(sy, ey) - T - 26;
            add(`<svg width="${W}" height="${H}" style="overflow:visible"><defs><marker id="__ah" markerUnits="userSpaceOnUse" markerWidth="16" markerHeight="16" refX="12" refY="8" orient="auto"><path d="M0,1 L14,8 L0,15 Z" fill="${accent}"/></marker></defs>`
              + `<path d="M${sx - L},${sy - T} Q${qx},${qy} ${ex - L},${ey - T}" stroke="${accent}" stroke-width="4" fill="none" stroke-linecap="round" marker-end="url(#__ah)"/></svg>`, { left: `${L}px`, top: `${T}px` });
          }
          if (m.kind === 'callout') {
            const right = m.side !== 'left';
            add(m.text, { left: right ? `${x + w + 14}px` : 'auto', right: right ? 'auto' : `${innerWidth - x + 14}px`, top: `${y + h / 2}px`, transform: 'translateY(-50%)',
              background: accent, color: '#fff', font: '600 15px/1.3 Inter, system-ui, sans-serif', padding: '8px 12px', borderRadius: '8px', maxWidth: '260px', boxShadow: '0 6px 18px rgba(0,0,0,.18)' });
          }
        }
      }, { marks: marks.map((m) => ({ ...m, r: { x: m.r.x, y: m.r.y, width: m.r.width, height: m.r.height } })), accent });

      const file = join(out, `${s.name}.png`);
      let rows = null;
      if (s.element) {
        // The element plus padding, widened to take in every annotation.
        const r = await rect(s.element);
        const pad = s.pad ?? 20;
        const ann = await p.evaluate(() => [...document.querySelectorAll('.__ann, .__ann svg')].map((e) => { const b = e.getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom]; }));
        let [x0, y0, x1, y1] = [r.x, r.y, r.x + r.width, r.y + r.height];
        for (const [a, b, c2, d] of ann) { x0 = Math.min(x0, a); y0 = Math.min(y0, b); x1 = Math.max(x1, c2); y1 = Math.max(y1, d); }
        const clip = { x: Math.max(0, x0 - pad), y: Math.max(0, y0 - pad) };
        clip.width = Math.min(vw, x1 + pad) - clip.x; clip.height = Math.min(vh, y1 + pad) - clip.y;
        await p.screenshot({ path: file, clip });
        if (s.rows) rows = await measureRows(p, s.rows, file, clip, scale);
      } else {
        await p.screenshot({ path: file, fullPage: !!s.full });
        if (s.rows) {
          const size = await p.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight, sx: scrollX, sy: scrollY }));
          // A whole-page picture starts at the top of the page; a screen-sized one at what is on screen.
          const clip = s.full ? { x: -size.sx, y: -size.sy, width: size.w, height: size.h } : { x: 0, y: 0, width: vw, height: vh };
          rows = await measureRows(p, s.rows, file, clip, scale);
        }
      }
      made.push({ name: s.name, file, ...(rows ? { rows } : {}) });
    }
    return made;
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Where every element matching `selector` sits in the picture (clip, in page pixels): written beside it as <name>.rows.json. */
async function measureRows(p, selector, file, clip, scale) {
  // A row that holds other rows (a group of options) is left out: its rows are measured instead.
  const boxes = await p.locator(selector).evaluateAll((els) => els.filter((e) => !els.some((o) => o !== e && e.contains(o))).map((e) => {
    const b = e.getBoundingClientRect();
    const label = (e.querySelector('label, .fw-backend-option-label, h2, h3, th') || e).textContent.replace(/\s+/g, ' ').trim().slice(0, 60);
    return { x: b.left, y: b.top, w: b.width, h: b.height, label, shown: b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden' };
  }));
  const pc = (v, of) => Math.round((v / of) * 10000) / 100;
  const rows = [];
  for (const b of boxes) {
    if (!b.shown) continue;
    // Only the part inside the picture.
    const x0 = Math.max(b.x, clip.x), y0 = Math.max(b.y, clip.y), x1 = Math.min(b.x + b.w, clip.x + clip.width), y1 = Math.min(b.y + b.h, clip.y + clip.height);
    // A row mostly outside the picture is left out (a sliver at the edge would only be a stray strip).
    if (x1 - x0 < 4 || y1 - y0 < 4 || (x1 - x0) * (y1 - y0) < 0.5 * b.w * b.h) continue;
    rows.push({ x: pc(x0 - clip.x, clip.width), y: pc(y0 - clip.y, clip.height), w: pc(x1 - x0, clip.width), h: pc(y1 - y0, clip.height), ...(b.label ? { label: b.label } : {}) });
  }
  // Each row as its own picture, and the screen with the rows hidden (the empty screen they build onto).
  const pageClip = { x: clip.x + (await p.evaluate(() => scrollX)), y: clip.y + (await p.evaluate(() => scrollY)), width: clip.width, height: clip.height };
  const base = file.replace(/\.png$/, '');
  for (const [i, r] of rows.entries()) {
    const c = { x: pageClip.x + (r.x / 100) * clip.width, y: pageClip.y + (r.y / 100) * clip.height, width: (r.w / 100) * clip.width, height: (r.h / 100) * clip.height };
    r.file = `${base}.row-${i + 1}.png`;
    await p.screenshot({ path: r.file, clip: c, fullPage: true });
  }
  await p.locator(selector).evaluateAll((els) => els.forEach((e) => { e.dataset.upwWas = e.style.visibility; e.style.visibility = 'hidden'; }));
  const empty = `${base}.empty.png`;
  await p.screenshot({ path: empty, clip: pageClip, fullPage: true });
  await p.locator(selector).evaluateAll((els) => els.forEach((e) => { e.style.visibility = e.dataset.upwWas || ''; delete e.dataset.upwWas; }));
  const out = `${base}.rows.json`;
  writeFileSync(out, JSON.stringify({ width: Math.round(clip.width * scale), height: Math.round(clip.height * scale), empty, rows }, null, 2));
  return out;
}
