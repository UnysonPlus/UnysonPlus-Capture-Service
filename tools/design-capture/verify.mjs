// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// verify.mjs — self-verification for the converter (roadmap item: "measure your own output").
//
// Renders two pages in real Chrome, screenshots them full-page at the same width, and pixel-diffs the
// overlapping region with pixelmatch. Returns an overall drift % plus a per-band breakdown (the page
// split into horizontal strips), so a caller can flag which section drifted. This is the MEASUREMENT
// the eventual auto-fallback-to-verbatim relies on: convert, then check the result against the source.
//
// It intentionally lives in the capture service (it already owns headless Chrome). The WordPress side
// calls POST /verify { source_url, converted_url } after a conversion and surfaces the drift.

import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const CHROME = process.env.CHROME || process.env.CHROME_PATH ||
  'C:/Program Files/Google/Chrome/Application/chrome.exe';

async function shoot(browser, url, width) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
    // let SPA / lazy content settle, then scroll to trigger lazy assets, then back to top
    await page.waitForTimeout(1500);
    await page.evaluate(async () => {
      await new Promise((r) => { let y = 0; const i = setInterval(() => { window.scrollTo(0, y); y += window.innerHeight; if (y > document.body.scrollHeight) { clearInterval(i); r(); } }, 60); });
    }).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await page.waitForTimeout(400);
    const buf = await page.screenshot({ fullPage: true });
    return PNG.sync.read(buf);
  } finally { await page.close(); }
}

// Crop a PNG down to w×h (top-left origin) into a fresh RGBA buffer pixelmatch can read.
function crop(png, w, h) {
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (png.width * y + x) << 2;
      const di = (w * y + x) << 2;
      out.data[di] = png.data[si]; out.data[di + 1] = png.data[si + 1];
      out.data[di + 2] = png.data[si + 2]; out.data[di + 3] = png.data[si + 3];
    }
  }
  return out;
}

// Count mismatched pixels inside a horizontal band [y0, y1) of two equal-width buffers.
function bandDrift(aData, bData, w, y0, y1, threshold) {
  const h = y1 - y0;
  if (h <= 0) return { pct: 0, mismatched: 0, pixels: 0 };
  const a = Buffer.alloc(w * h * 4), b = Buffer.alloc(w * h * 4);
  aData.copy(a, 0, y0 * w * 4, y1 * w * 4);
  bData.copy(b, 0, y0 * w * 4, y1 * w * 4);
  const mismatched = pixelmatch(a, b, null, w, h, { threshold });
  return { pct: Math.round((mismatched / (w * h)) * 1000) / 10, mismatched, pixels: w * h };
}

/**
 * Compare two live URLs. Returns overall drift % + per-band drift.
 * @param {{ sourceUrl:string, convertedUrl:string, width?:number, bands?:number, threshold?:number }} o
 */
export async function verifyUrls({ sourceUrl, convertedUrl, width = 1440, bands = 8, threshold = 0.1 }) {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const [src, conv] = await Promise.all([shoot(browser, sourceUrl, width), shoot(browser, convertedUrl, width)]);
    const w = Math.min(src.width, conv.width);
    const h = Math.min(src.height, conv.height);
    const a = crop(src, w, h), b = crop(conv, w, h);
    const overallMismatched = pixelmatch(a.data, b.data, null, w, h, { threshold });
    const overall = Math.round((overallMismatched / (w * h)) * 1000) / 10;
    const bandRows = [];
    const step = Math.ceil(h / bands);
    for (let i = 0; i < bands; i++) {
      const y0 = i * step, y1 = Math.min((i + 1) * step, h);
      if (y0 >= h) break;
      const d = bandDrift(a.data, b.data, w, y0, y1, threshold);
      bandRows.push({ band: i + 1, y0, y1, drift_pct: d.pct });
    }
    return {
      ok: true,
      overall_drift_pct: overall,
      compared: { width: w, height: h },
      source: { width: src.width, height: src.height },
      converted: { width: conv.width, height: conv.height },
      height_delta_pct: src.height ? Math.round((Math.abs(src.height - conv.height) / src.height) * 1000) / 10 : 0,
      bands: bandRows,
    };
  } finally { await browser.close(); }
}

/**
 * ELEMENT-LEVEL geometry diff — what the band drift cannot see.
 *
 * `verifyUrls()` returns ONE number per horizontal band, so a handful of small text controls in the wrong place
 * reads as a rounding error (a header band scored 8.4 % while its utility links sat on the wrong row, centred
 * instead of edge-aligned). `conversion-parity.json` only asks whether a header EXISTS. Neither can answer
 * "is this element where the source puts it?".
 *
 * This matches elements between the two pages BY THEIR TEXT and compares the boxes: x, y, the vertical centre
 * (which row it sits on) and the width. Anything past the tolerances comes back as a finding, ordered worst
 * first, plus the source elements that have no counterpart at all (dropped) and vice versa (invented).
 *
 * @param {object}  o
 * @param {string}  o.sourceUrl
 * @param {string}  o.convertedUrl
 * @param {string} [o.scope='header']   'header' | 'footer' | 'page' — which region to compare.
 * @param {number} [o.width=1440]
 * @param {number} [o.dx=24]            px tolerance on x / width.
 * @param {number} [o.dy=12]            px tolerance on the vertical centre (the row).
 * @param {number} [o.maxLen=40]        ignore leaves longer than this (body copy, not chrome).
 */
export async function verifyChrome({ sourceUrl, convertedUrl, scope = 'header', width = 1440, dx = 24, dy = 12, maxLen = 40 }) {
  const browser = await chromium.launch({ channel: 'chrome' }); // (playwright-core, like the band diff above)
  const read = async (url) => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    const els = await page.evaluate(({ scope, maxLen }) => {
      const roots = scope === 'header' ? ['header', '.site-header'] : scope === 'footer' ? ['footer', '.site-footer'] : ['body'];
      let root = null;
      for (const sel of roots) { root = document.querySelector(sel); if (root) break; }
      if (!root) return [];
      const out = [];
      for (const e of root.querySelectorAll('*')) {
        if (e.children.length) continue;                       // leaves only
        const t = (e.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t || t.length > maxLen) continue;
        const r = e.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const cs = getComputedStyle(e);
        if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) continue;
        out.push({ t, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), cy: Math.round(r.top + r.height / 2), fs: cs.fontSize, ls: cs.letterSpacing });
      }
      return out;
    }, { scope, maxLen });
    await page.close();
    return els;
  };
  const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const [src, conv] = [await read(sourceUrl), await read(convertedUrl)];
  await browser.close();

  const used = new Set();
  const findings = [];
  for (const a of src) {
    const key = norm(a.t);
    if (!key) continue;
    // exact text first, then a converted leaf that CONTAINS it (the converter often joins controls into one node)
    let i = conv.findIndex((b, j) => !used.has(j) && norm(b.t) === key);
    let joined = false;
    if (i < 0) { i = conv.findIndex((b, j) => !used.has(j) && norm(b.t).includes(key) && norm(b.t) !== key); joined = i >= 0; }
    if (i < 0) { findings.push({ kind: 'missing', text: a.t, source: { x: a.x, cy: a.cy } }); continue; }
    used.add(i);
    const b = conv[i];
    const d = { dx: b.x - a.x, dy: b.cy - a.cy, dw: b.w - a.w };
    const off = Math.abs(d.dx) > dx || Math.abs(d.dy) > dy;
    if (joined) findings.push({ kind: 'joined', text: a.t, into: b.t, ...d });
    else if (off) findings.push({ kind: 'moved', text: a.t, ...d, source: { x: a.x, cy: a.cy }, converted: { x: b.x, cy: b.cy } });
    else if (a.fs !== b.fs) findings.push({ kind: 'type', text: a.t, source: a.fs, converted: b.fs });
  }
  for (let j = 0; j < conv.length; j++) {
    if (used.has(j)) continue;
    const b = conv[j];
    if (!norm(b.t)) continue;
    findings.push({ kind: 'extra', text: b.t, converted: { x: b.x, cy: b.cy } });
  }
  const rank = { missing: 0, joined: 1, moved: 2, type: 3, extra: 4 };
  findings.sort((a, b) => (rank[a.kind] - rank[b.kind]) || (Math.abs(b.dy || 0) - Math.abs(a.dy || 0)));
  return {
    ok: findings.length === 0,
    scope,
    counted: { source: src.length, converted: conv.length },
    findings,
  };
}

/**
 * SECTION-ALIGNED element diff — the band score's two blind spots, fixed.
 *
 * `verifyUrls()` slices both pages into fixed horizontal bands. The moment one section's height differs, every
 * band below it compares unrelated content, so a single tall hero smears drift across the whole page and nothing
 * can be attributed to a section. And a band is only ever ONE number: it cannot say a price lost its right
 * alignment or a jar is cropped.
 *
 * This aligns the pages by SECTION first (matching `<section>` / `<header>` / `<footer>` / `.fw-section` by id,
 * else in order), then inside each matched pair compares the ELEMENTS: text leaves matched by their text, images
 * matched by their file name. Positions are measured RELATIVE to the section's own top, so a section that starts
 * 50px lower does not report every child as moved. Each finding names the section, so the output reads as a
 * per-section bug list.
 *
 * @param {object}  o
 * @param {string}  o.sourceUrl
 * @param {string}  o.convertedUrl
 * @param {number} [o.width=1440]
 * @param {number} [o.dx=24]      px tolerance on x
 * @param {number} [o.dy=16]      px tolerance on y within the section
 * @param {number} [o.dsize=24]   px tolerance on width / height (media + controls)
 * @param {number} [o.maxLen=60]  ignore leaves longer than this (body copy, not layout)
 */
export async function verifySections({ sourceUrl, convertedUrl, width = 1440, dx = 24, dy = 16, dsize = 24, maxLen = 60, skin = true, rhythm = true, dgap = 12 }) {
  const browser = await chromium.launch({ channel: 'chrome' });
  const read = async (url) => {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    await page.goto(url, { waitUntil: 'networkidle' });
    for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, 900); await page.waitForTimeout(200); }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(900);
    const data = await page.evaluate((maxLen) => {
      const all = [...document.querySelectorAll('header, section, footer, .fw-section')]
        .filter((e) => { const r = e.getBoundingClientRect(); return r.height > 60 && r.width > 600; });
      const secs = all.filter((e) => !all.some((o) => o !== e && o.contains(e)));
      const file = (u) => { try { return (new URL(u, location.href).pathname.split('/').pop() || '').split('?')[0].toLowerCase(); } catch { return ''; } };
      const paints = (cs) => {
        const bg = cs.backgroundColor || '';
        if (bg && !/rgba\([^)]*,\s*0\s*\)|transparent/i.test(bg)) return true;
        if (parseFloat(cs.borderTopWidth) >= 1 || parseFloat(cs.borderBottomWidth) >= 1) return true;
        if (cs.boxShadow && cs.boxShadow !== 'none') return true;
        return false;
      };
      // the visual SKIN of a control: what makes a bare row look different from a bordered button
      const skinOf = (e, cs) => ({
        bg: cs.backgroundColor, bw: `${cs.borderTopWidth} ${cs.borderRightWidth} ${cs.borderBottomWidth} ${cs.borderLeftWidth}`,
        bc: cs.borderTopColor, br: cs.borderRadius, sh: cs.boxShadow === 'none' ? '' : cs.boxShadow,
        ta: cs.textAlign, fw: cs.fontWeight, ls: cs.letterSpacing, tt: cs.textTransform, col: cs.color,
        pos: /^(absolute|fixed|sticky)$/.test(cs.position) ? cs.position : 'flow',
      });
      // an icon's identity without its markup: the glyph library class, else the shape of its path data
      const iconKey = (e) => {
        const cls = (e.getAttribute('class') || '').toString();
        const m = cls.match(/(?:lucide|fa|bi|ti|material-icons)[-\w]*\s*[-\w]*/);
        if (m && m[0].length > 4) return m[0].trim().toLowerCase();
        const d = [...e.querySelectorAll('path')].map((p) => (p.getAttribute('d') || '').slice(0, 24)).join('|');
        return d ? 'path:' + d.slice(0, 48) : 'svg';
      };
      return secs.map((sec, i) => {
        const sr = sec.getBoundingClientRect();
        const top = sr.top + scrollY;
        const items = [];
        for (const e of sec.querySelectorAll('*')) {
          const r = e.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          const cs = getComputedStyle(e);
          if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) continue;
          // …and the element's OWN opacity says nothing about a hover-revealed layer, which is faded out by an
          // ANCESTOR. Those leaves were reported as dropped by the converter while no reader ever sees them
          // (a product tile's "Quick View" overlay, four times over).
          if (e.checkVisibility && !e.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) continue;
          const rel = { x: Math.round(r.left), y: Math.round(r.top + scrollY - top), w: Math.round(r.width), h: Math.round(r.height) };
          const tag = e.tagName.toLowerCase();
          // TEXT PAINTED BY A PSEUDO-ELEMENT is real to the reader and invisible to a DOM walk. A pinned label
          // over a photo is reproduced as `::after{content:"…"}` — with no node to match, the lens called the
          // label DROPPED while it was rendering correctly on screen. Its own box cannot be measured, so it is
          // recorded as present-but-unmeasurable and matching skips the geometry test.
          for (const pe of ['::before', '::after']) {
            const pc = getComputedStyle(e, pe).content;
            if (!pc || pc === 'none' || pc === 'normal') continue;
            const pcs = getComputedStyle(e, pe);
            // …and a pseudo-element can also PAINT A GLYPH: a control whose native shortcode has no icon slot
            // gets its source svg back as a currentColor MASK. That is a real icon on screen with no element
            // behind it, so the lens called the glyph dropped while it was rendering.
            const mask = pcs.maskImage || pcs.webkitMaskImage || '';
            // …a glyph can equally be painted as a BACKGROUND IMAGE (a play control whose circle is the
            // pseudo's fill and whose glyph rides on top of it), which is just as real and just as invisible.
            const bgi = pcs.backgroundImage || '';
            const bgGlyph = /^url\("?data:image\/svg/.test(bgi);
            if ((mask && mask !== 'none') || bgGlyph) { items.push({ kind: 'icon', key: 'mask', ...rel, pseudo: pe }); continue; }
            let pt = '';
            try { if (pc[0] === '"') pt = String(JSON.parse(pc)).replace(/\s+/g, ' ').trim(); } catch { pt = ''; }
            if (!pt || pt.length > maxLen) continue;
            items.push({ kind: 'text', key: pt, ...rel, pseudo: pe, fs: getComputedStyle(e, pe).fontSize, ta: 'start' });
          }
          if (tag === 'img') {
            const key = file(e.currentSrc || e.src || '');
            if (key) items.push({ kind: 'img', key, ...rel, fit: cs.objectFit, skin: skinOf(e, cs) });
            continue;
          }
          // an SVG / icon glyph is an ELEMENT of the design: the source's seal badge and the converter's
          // invented social glyphs are both invisible to a text-keyed matcher.
          if (tag === 'svg' || (tag === 'i' && !e.children.length && !(e.textContent || '').trim())) {
            if (r.width <= 96 && r.height <= 96) items.push({ kind: 'icon', key: iconKey(e), ...rel, skin: skinOf(e, cs) });
            continue;
          }
          if (e.children.length) {
            // a painted, text-free box (a rule, a swatch, a media overlay scrim) still shapes the design
            continue;
          }
          const t = (e.textContent || '').replace(/\s+/g, ' ').trim();
          if (!t) {
            if (paints(cs) && r.width >= 8 && r.height >= 8 && r.width * r.height < 400000) {
              items.push({ kind: 'box', key: `box:${Math.round(r.width)}x${Math.round(r.height)}`, ...rel, skin: skinOf(e, cs) });
            }
            continue;
          }
          if (t.length > maxLen) continue;
          // the skin that matters for a text control is its own, else its nearest painted ancestor (the
          // `<a>`/`<button>` wrapper that carries the fill + border)
          let sk = skinOf(e, cs);
          if (!paints(cs)) {
            for (let p = e.parentElement, n = 0; p && n < 3 && p !== sec; p = p.parentElement, n++) {
              const pcs = getComputedStyle(p);
              if (paints(pcs)) { sk = skinOf(p, pcs); break; }
            }
          }
          items.push({ kind: 'text', key: t, ...rel, fs: cs.fontSize, ta: cs.textAlign, skin: sk });
        }
        return { i, id: sec.id || (sec.className || '').toString().split(' ')[0].slice(0, 24) || sec.tagName.toLowerCase(), tag: sec.tagName.toLowerCase(), y: Math.round(top), h: Math.round(sr.height), items };
      });
    }, maxLen);
    await page.close();
    return data;
  };
  const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '');
  // WordPress renames uploads (`-scaled`, `-1024x768`, a numeric de-dupe suffix), so an identical photo
  // carries a different file name on the converted side. Compare the STEM, longest-prefix style.
  const stem = (k) => String(k).toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/-scaled$/, '').replace(/-\d+x\d+$/, '').replace(/-\d{1,2}$/, '').replace(/[^a-z0-9]+/g, '');
  const sameImg = (a, b) => { const p = stem(a), q = stem(b); if (!p || !q) return false; return p === q || (p.length >= 12 && q.length >= 12 && (p.startsWith(q.slice(0, 12)) || q.startsWith(p.slice(0, 12)))); };
  const [src, conv] = [await read(sourceUrl), await read(convertedUrl)];
  await browser.close();

  // pair sections: by id when both sides carry one, else by order
  const pairs = [];
  const usedConv = new Set();
  for (const a of src) {
    let j = conv.findIndex((b, k) => !usedConv.has(k) && a.id && b.id && norm(a.id) === norm(b.id));
    if (j < 0) j = conv.findIndex((b, k) => !usedConv.has(k) && b.i === a.i);
    if (j < 0) { pairs.push({ a, b: null }); continue; }
    usedConv.add(j); pairs.push({ a, b: conv[j] });
  }

  // what a difference in skin is worth saying out loud (a bare row that became a bordered button, a
  // left-aligned headline that became centred) — cosmetic noise like a 1px colour drift is not.
  const skinDiff = (a, b, sameCase = true) => {
    if (!a || !b) return null;
    const out = [];
    const px = (v) => Math.round(parseFloat(v) || 0);
    if (a.ta !== b.ta) out.push(`align ${a.ta}->${b.ta}`);
    if ((a.bg || '') !== (b.bg || '') && !(/,\s*0\s*\)/.test(a.bg || '') && /,\s*0\s*\)/.test(b.bg || ''))) out.push(`bg ${a.bg}->${b.bg}`);
    if (px(a.bw) !== px(b.bw) || px(a.bw.split(' ')[2]) !== px(b.bw.split(' ')[2])) out.push(`border ${a.bw}->${b.bw}`);
    if (px(a.br) !== px(b.br)) out.push(`radius ${a.br}->${b.br}`);
    if ((a.sh ? 1 : 0) !== (b.sh ? 1 : 0)) out.push(`shadow ${a.sh ? 'yes' : 'no'}->${b.sh ? 'yes' : 'no'}`);
    if (String(a.fw) !== String(b.fw)) out.push(`weight ${a.fw}->${b.fw}`);
    if (px(a.ls) !== px(b.ls)) out.push(`tracking ${a.ls}->${b.ls}`);
    // …`text-transform` only matters when it CHANGES the rendered text. A source that writes its nav labels
    // in literal capitals with `text-transform:none` reads identically to a converter that title-cases them
    // and applies `uppercase` — reporting that was five findings about nothing.
    if (a.tt !== b.tt && !sameCase) out.push(`transform ${a.tt}->${b.tt}`);
    if (a.col !== b.col) out.push(`color ${a.col}->${b.col}`);
    return out.length ? out : null;
  };

  const sections = pairs.map(({ a, b }) => {
    if (!b) return { id: a.id, missing: true, findings: [{ kind: 'section-missing', text: a.id }] };
    const findings = [];
    const used = new Set();
    const matched = [];
    for (const x of a.items) {
      const key = norm(x.key);
      if (!key) continue;
      let i = b.items.findIndex((y, k) => !used.has(k) && y.kind === x.kind && norm(y.key) === key);
      if (i < 0 && x.kind === 'img') i = b.items.findIndex((y, k) => !used.has(k) && y.kind === 'img' && sameImg(y.key, x.key));
      let joined = false;
      if (i < 0 && x.kind === 'text') { i = b.items.findIndex((y, k) => !used.has(k) && y.kind === 'text' && norm(y.key).includes(key) && norm(y.key) !== key); joined = i >= 0; }
      if (i < 0) { findings.push({ kind: x.kind === 'img' ? 'img-missing' : x.kind === 'icon' ? 'icon-missing' : x.kind === 'box' ? 'box-missing' : 'missing', text: String(x.key).slice(0, 40), source: { x: x.x, y: x.y, w: x.w, h: x.h }, sec: a.id }); continue; }
      used.add(i);
      const y = b.items[i];
      matched.push({ x, y });
      const d = { dx: y.x - x.x, dy: y.y - x.y, dw: y.w - x.w, dh: y.h - x.h };
      if (joined) { findings.push({ kind: 'joined', text: String(x.key).slice(0, 30), into: String(y.key).slice(0, 40), ...d }); continue; }
      // an overlay that lost its pinning reads as a huge dy; naming the position change says WHY
      if (x.skin && y.skin && x.skin.pos !== 'flow' && y.skin.pos === 'flow') {
        findings.push({ kind: 'unpinned', text: String(x.key).slice(0, 34), source: x.skin.pos, ...d });
        continue;
      }
      if (x.kind === 'img' || x.kind === 'icon' || x.kind === 'box') {
        if (Math.abs(d.dw) > dsize || Math.abs(d.dh) > dsize) { findings.push({ kind: x.kind + '-box', text: x.key, src: { w: x.w, h: x.h }, conv: { w: y.w, h: y.h }, ...d }); continue; }
        if (x.kind === 'img' && x.fit !== y.fit) { findings.push({ kind: 'img-fit', text: x.key, source: x.fit, converted: y.fit }); continue; }
        if (Math.abs(d.dx) > dx || Math.abs(d.dy) > dy) findings.push({ kind: 'moved', text: x.key, ...d });
        continue;
      }
      if (y.pseudo) { continue; }   // rendered as a pseudo-element: present, but its own box is unmeasurable
      if (Math.abs(d.dx) > dx || Math.abs(d.dy) > dy) { findings.push({ kind: 'moved', text: String(x.key).slice(0, 34), ...d }); continue; }
      if (x.fs !== y.fs) { findings.push({ kind: 'type', text: String(x.key).slice(0, 34), source: x.fs, converted: y.fs }); continue; }
      if (skin) {
        const sd = skinDiff(x.skin, y.skin, String(x.key) === String(y.key));
        if (sd) findings.push({ kind: 'skin', text: String(x.key).slice(0, 34), diff: sd });
      }
    }
    for (let k = 0; k < b.items.length; k++) {
      if (used.has(k)) continue;
      const y = b.items[k];
      if (!norm(y.key)) continue;
      if (y.kind === 'box') continue;                     // an extra painted box is usually a wrapper, not a defect
      if (y.pseudo && y.kind === 'text') { findings.push({ kind: 'extra-pseudo', text: String(y.key).slice(0, 40), sec: a.id }); continue; }
      findings.push({ kind: y.kind === 'text' ? 'extra' : 'extra-' + y.kind, text: String(y.key).slice(0, 40), converted: { x: y.x, y: y.y, w: y.w, h: y.h }, pseudo: y.pseudo || '', sec: a.id });
    }
    // ── VERTICAL RHYTHM ─────────────────────────────────────────────────────────────────────────
    // Positions alone cannot see spacing, because two spacing errors CANCEL: a button row 32px too tall
    // followed by a gap 48px too small put the next block within 4px of where the source has it, and every
    // position test passed while the design's breathing room was gone (a real-site audit — the reader saw it
    // immediately). Comparing the GAP between consecutive matched elements sees each error on its own.
    if (rhythm) {
      const seq = matched.filter((m) => m.x.kind === 'text' && !m.y.pseudo).sort((p, q) => p.x.y - q.x.y);
      for (let k = 1; k < seq.length; k++) {
        const p = seq[k - 1], q = seq[k];
        const sGap = q.x.y - (p.x.y + p.x.h);
        const cGap = q.y.y - (p.y.y + p.y.h);
        if (sGap < 16 && cGap < 16) continue;               // within one block's line rhythm — not spacing
        if (Math.abs(sGap - cGap) <= dgap) continue;
        findings.push({ kind: 'gap', after: String(p.x.key).slice(0, 28), before: String(q.x.key).slice(0, 28),
          source: Math.round(sGap), converted: Math.round(cGap), delta: Math.round(cGap - sGap) });
      }
      // (A per-leaf BOX-HEIGHT comparison was tried here and removed: a source `<span>` inside a button
      // matches a converted `<a>` that IS the button, so every finding measured the NESTING rather than the
      // spacing — 7 findings, 0 real. The gap between consecutive leaves is nesting-independent, so it is the
      // one that earns its place.)
    }

    // …an icon-missing that coincides in POSITION with an extra icon is one swap, not two findings
    for (const f of findings.filter((z) => z.kind === 'icon-missing')) {
      const near = (z) => Math.abs(z.converted.x - f.source.x) <= dx && Math.abs(z.converted.y - f.source.y) <= dy;
      // a MASK glyph has no box of its own — it is measured on its host control, so the source glyph
      // sitting anywhere inside that control is the same glyph
      const inside = (z) => z.pseudo && f.source.x >= z.converted.x - dx && f.source.x <= z.converted.x + z.converted.w + dx
        && f.source.y >= z.converted.y - dy && f.source.y <= z.converted.y + z.converted.h + dy;
      const j = findings.findIndex((z) => z.kind === 'extra-icon' && z.converted && (near(z) || inside(z)));
      if (j < 0) continue;
      f.kind = 'icon-swapped'; f.converted = findings[j].text;
      findings.splice(j, 1);
    }
    const rank = { 'section-missing': 0, 'img-missing': 1, 'icon-missing': 2, 'icon-swapped': 2.5, missing: 3, 'box-missing': 4, unpinned: 5, 'img-box': 6, 'icon-box': 7, 'box-box': 8, joined: 9, gap: 9.3, 'box-height': 9.6, moved: 10, 'img-fit': 11, type: 12, skin: 13, extra: 14, 'extra-pseudo': 14.5, 'extra-icon': 15, 'extra-img': 16 };
    findings.sort((p, q) => (rank[p.kind] ?? 99) - (rank[q.kind] ?? 99));
    return { id: a.id, srcH: a.h, convH: b.h, dh: b.h - a.h, findings };
  });

  // ── cross-section reconciliation ────────────────────────────────────────────────────────────────
  // An element the converter placed in the WRONG section is reported twice and understood once: `missing`
  // here, `extra` there, with nothing linking them (a video's play button and its caption escaped their
  // section entirely and read as four unrelated findings). Pair the leftovers page-wide and say `relocated`.
  const leftMissing = [];
  const leftExtra = [];
  for (const s2 of sections) {
    for (const f of s2.findings) {
      if (/^(missing|icon-missing|img-missing)$/.test(f.kind)) leftMissing.push({ s: s2, f });
      else if (/^extra/.test(f.kind)) leftExtra.push({ s: s2, f });
    }
  }
  let relocated = 0;
  for (const m of leftMissing) {
    const j = leftExtra.findIndex((e) => !e.done && norm(e.f.text) === norm(m.f.text));
    if (j < 0) continue;
    const e = leftExtra[j]; e.done = true;
    if (e.s === m.s) { m.s.findings.splice(m.s.findings.indexOf(m.f), 1); e.s.findings.splice(e.s.findings.indexOf(e.f), 1); continue; }
    m.f.kind = 'relocated';
    m.f.to = e.s.id;
    m.f.convertedIn = e.s.id;
    e.s.findings.splice(e.s.findings.indexOf(e.f), 1);
    relocated++;
  }

  const total = sections.reduce((n, s2) => n + s2.findings.length, 0);
  const byKind = {};
  for (const s2 of sections) for (const f of s2.findings) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
  return { ok: total === 0, total, relocated, byKind, sections };
}

/**
 * PER-SECTION PIXEL HEAT — the catch-all for a defect no model covers.
 *
 * Every other lens here reports only what it was built to express: text leaves, images, icons, skin, gaps.
 * A defect outside those categories — a gradient that lost its angle, a shadow, a mask, a font that fell
 * back — is invisible to all of them, and the band score in `verifyUrls()` cannot say WHERE inside a band
 * it sits (nor survive a section whose height differs, which shifts every band below it).
 *
 * This aligns the two pages by SECTION (same rule as `verifySections`), crops each pair to their common
 * height, and diffs them on a CELL grid. Each section comes back with its own drift and the worst cells as
 * rectangles, in the section's own coordinates — so "something is wrong here, 240px down the collection
 * band" is answerable even when nothing else reports a thing. It classifies nothing: it points.
 *
 * @param {object}  o
 * @param {string}  o.sourceUrl
 * @param {string}  o.convertedUrl
 * @param {number} [o.width=1440]
 * @param {number} [o.cell=48]       grid cell size in px
 * @param {number} [o.minPct=45]     a cell must differ by this much to be HOT. Kept high on purpose: at a low
 *                                  bar every cell qualifies (sub-pixel text shifts), the clusters merge into
 *                                  one section-sized blob, and the lens points at everything, i.e. nothing.
 * @param {number} [o.top=6]         how many worst cells to return per section
 * @param {number} [o.threshold=0.15] pixelmatch colour tolerance (anti-aliased pixels are excluded by default)
 */
export async function verifyPixels({ sourceUrl, convertedUrl, width = 1440, cell = 48, minPct = 45, top = 6, threshold = 0.15 }) {
  const browser = await chromium.launch({ channel: 'chrome' });
  const read = async (url) => {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    await page.goto(url, { waitUntil: 'networkidle' });
    for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, 900); await page.waitForTimeout(160); }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(800);
    const secs = await page.evaluate(() => {
      const all = [...document.querySelectorAll('header, section, footer, .fw-section')]
        .filter((e) => { const r = e.getBoundingClientRect(); return r.height > 60 && r.width > 600; });
      return all.filter((e) => !all.some((o) => o !== e && o.contains(e))).map((sec, i) => {
        const r = sec.getBoundingClientRect();
        return { i, id: sec.id || (sec.className || '').toString().split(' ')[0].slice(0, 24) || sec.tagName.toLowerCase(),
          y: Math.round(r.top + scrollY), h: Math.round(r.height) };
      });
    });
    const png = PNG.sync.read(await page.screenshot({ fullPage: true }));
    await page.close();
    return { secs, png };
  };
  const [A, B] = [await read(sourceUrl), await read(convertedUrl)];
  await browser.close();

  const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const usedB = new Set();
  const pairs = [];
  for (const a of A.secs) {
    let j = B.secs.findIndex((b, k) => !usedB.has(k) && a.id && b.id && norm(a.id) === norm(b.id));
    if (j < 0) j = B.secs.findIndex((b, k) => !usedB.has(k) && b.i === a.i);
    if (j < 0) continue;
    usedB.add(j); pairs.push([a, B.secs[j]]);
  }

  // one section's band, cropped out of a full-page PNG into a fresh RGBA buffer
  const band = (png, y, h, w) => {
    const out = new PNG({ width: w, height: h });
    for (let row = 0; row < h; row++) {
      const sy = y + row;
      if (sy < 0 || sy >= png.height) continue;
      for (let x = 0; x < w; x++) {
        const si = (png.width * sy + x) << 2, di = (w * row + x) << 2;
        out.data[di] = png.data[si]; out.data[di + 1] = png.data[si + 1];
        out.data[di + 2] = png.data[si + 2]; out.data[di + 3] = png.data[si + 3];
      }
    }
    return out;
  };

  const sections = [];
  for (const [a, b] of pairs) {
    const w = Math.min(A.png.width, B.png.width, width);
    const h = Math.min(a.h, b.h);
    if (h < 8 || w < 8) continue;
    const pa = band(A.png, a.y, h, w), pb = band(B.png, b.y, h, w);
    const diff = new PNG({ width: w, height: h });
    // `diffMask` paints ONLY the differing pixels on a transparent ground. Without it pixelmatch draws the
    // diff over a dimmed copy of the image, so every pixel is non-zero and every cell reads as 100 % hot.
    const mismatched = pixelmatch(pa.data, pb.data, diff.data, w, h, { threshold, diffMask: true });
    // …then WHERE: count differing pixels per grid cell, worst first
    const cells = [];
    for (let cy = 0; cy < h; cy += cell) {
      for (let cx = 0; cx < w; cx += cell) {
        const ch = Math.min(cell, h - cy), cw = Math.min(cell, w - cx);
        let n = 0;
        for (let y2 = cy; y2 < cy + ch; y2++) {
          for (let x2 = cx; x2 < cx + cw; x2++) {
            if (diff.data[((w * y2 + x2) << 2) + 3]) n++;   // alpha > 0 = a real difference
          }
        }
        const pct = Math.round((n / (cw * ch)) * 1000) / 10;
        if (pct >= minPct) cells.push({ x: cx, y: cy, w: cw, h: ch, pct });
      }
    }
    // …merged into CLUSTERS. Ranking cells alone returns a row of neighbours all tied at 100 %, which names
    // one place six times; flood-filling adjacent hot cells into rectangles names six different places.
    const key = (cx, cy) => `${cx},${cy}`;
    const map = new Map(cells.map((c) => [key(c.x, c.y), c]));
    const seen = new Set();
    const clusters = [];
    for (const c of cells) {
      const k0 = key(c.x, c.y);
      if (seen.has(k0)) continue;
      const queue = [c]; seen.add(k0);
      let x0 = c.x, y0 = c.y, x1 = c.x + c.w, y1 = c.y + c.h, sum = 0, n = 0;
      while (queue.length) {
        const q = queue.pop();
        sum += q.pct; n++;
        x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y);
        x1 = Math.max(x1, q.x + q.w); y1 = Math.max(y1, q.y + q.h);
        for (const [dx2, dy2] of [[cell, 0], [-cell, 0], [0, cell], [0, -cell]]) {
          const kk = key(q.x + dx2, q.y + dy2);
          if (seen.has(kk) || !map.has(kk)) continue;
          seen.add(kk); queue.push(map.get(kk));
        }
      }
      clusters.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, cells: n, pct: Math.round((sum / n) * 10) / 10, area: (x1 - x0) * (y1 - y0) });
    }
    clusters.sort((p, q) => (q.area * q.pct) - (p.area * p.pct));
    sections.push({
      id: a.id, srcH: a.h, convH: b.h,
      drift_pct: Math.round((mismatched / (w * h)) * 1000) / 10,
      hotspots: clusters.slice(0, top),
    });
  }
  const worst = sections.slice().sort((p, q) => q.drift_pct - p.drift_pct)[0] || null;
  return { ok: sections.every((s) => s.drift_pct < minPct), sections, worst };
}
