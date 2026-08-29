// Scroll-animation capture — scrolls a page in steps and records (a) a filmstrip of screenshots and
// (b) per-element transform/opacity KEYFRAMES across the scroll, then flags the elements that actually
// animate on scroll (transform / opacity varies beyond plain document scroll). Emits a machine-readable
// timeline the Site Converter can map to Scroll Motion / Scrollytelling, plus an HTML report.
//
// Honest scope: this reads the DOM. It captures DOM-driven scroll animations (GSAP ScrollTrigger, CSS
// scroll-timeline, transform-on-scroll, reveal-on-scroll) well. A scene rendered INSIDE a <canvas>
// (WebGL) has no DOM to read — the filmstrip still shows it, but there are no per-element keyframes.
//
// Usage:  node scroll-capture.mjs <url> [outDir] [--steps N] [--width W] [--height H]
// Programmatic:  import { captureScroll } from './scroll-capture.mjs'; await captureScroll({ url, outDir });

import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';

const STEP_WAIT_MS = 420;      // let scroll-linked animations settle at each stop
const MAX_TRACKED = 400;       // cap tracked elements (perf)
const EPS = 0.04;              // opacity change threshold to count as "animated"

/** Tag candidate elements once (things that plausibly animate on scroll) and return how many. Runs in-page. */
const TAG_FN = `(${((max) => {
  const cands = [];
  const reveal = /(reveal|fade|slide|aos|animate|wow|rv-|mask|word|parallax|sticky|pin|scrollytelling|inview|data-scroll)/i;
  const all = document.body.querySelectorAll('*');
  for (let i = 0; i < all.length && cands.length < max; i++) {
    const el = all[i];
    if (!(el instanceof HTMLElement)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 24 || r.height < 12) continue;               // skip tiny
    const cs = getComputedStyle(el);
    const hasTransform = cs.transform && cs.transform !== 'none';
    const trans = (cs.transition || '') + ' ' + (cs.animationName || '');
    const opacityish = parseFloat(cs.opacity) < 0.999;
    const cls = (el.className && el.className.baseVal !== undefined) ? el.className.baseVal : String(el.className || '');
    const marked = reveal.test(cls) || reveal.test(el.getAttributeNames().join(' '));
    if (hasTransform || opacityish || /transform|opacity/.test(trans) || marked) {
      const idx = cands.length;
      el.setAttribute('data-scap', String(idx));
      // Stable signature so the converter can match this element to the source node it processes.
      const kept = cls.split(/\s+/).filter((c) => c && !/^(m[xytrbl]?-|p[xytrbl]?-|col|row|d-|w-|h-|order-|offset-|text-(start|end|center|left|right)|flex|grid|items-|justify-|gap-|g[xy]?-)/.test(c)).slice(0, 4).join(' ');
      cands.push({ i: idx, tag: el.tagName.toLowerCase(), cls: kept, text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 44) });
    }
  }
  return cands;
}).toString()})(${MAX_TRACKED})`;

/** Read the tracked elements' state at the current scroll. Runs in-page. */
const READ_FN = `(() => {
  const out = [];
  document.querySelectorAll('[data-scap]').forEach((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    out.push({ i: +el.getAttribute('data-scap'), t: cs.transform, o: +parseFloat(cs.opacity).toFixed(3),
      top: Math.round(r.top + window.scrollY), vis: (r.bottom > 0 && r.top < innerHeight) ? 1 : 0 });
  });
  return { y: window.scrollY, max: Math.max(1, document.documentElement.scrollHeight - innerHeight), els: out };
})()`;

/** Classify an element's scroll keyframes into a Scroll-Motion-shaped suggestion the converter can map:
 *  reveal (fade-in on scroll, with direction + trigger %), parallax (continuous transform), or motion. */
function classifyScroll(kfs, transformVaries, oFrom, oTo) {
  // REVEAL — opacity rises from ~hidden to ~shown across a band.
  if ((oTo - oFrom) > 0.3 && oFrom < 0.2) {
    let trigger = 1;
    for (const k of kfs) { if (k.o >= 0.5) { trigger = k.p; break; } }
    let direction = 'up';
    const hidden = kfs.find((k) => k.o < 0.5);
    const m = hidden && /matrix\(([^)]+)\)/.exec(hidden.t || '');
    if (m) { const a = m[1].split(',').map(parseFloat); const tx = a[4] || 0, ty = a[5] || 0;
      if (Math.abs(ty) >= Math.abs(tx) && Math.abs(ty) > 2) direction = ty > 0 ? 'up' : 'down';
      else if (Math.abs(tx) > 2) direction = tx > 0 ? 'left' : 'right'; }
    return { effect: 'reveal', direction, trigger: +trigger.toFixed(2) };
  }
  // PARALLAX — transform varies continuously while opacity stays put.
  if (transformVaries && (oTo - oFrom) <= 0.3) {
    const distinct = new Set(kfs.map((k) => k.t)).size;
    return { effect: distinct >= Math.min(4, kfs.length - 1) ? 'parallax' : 'motion', trigger: 0 };
  }
  return { effect: 'reveal', direction: 'up', trigger: 0 };
}

export async function captureScroll({ url, outDir, steps = 12, width = 1440, height = 900, headless = true } = {}) {
  if (!url) throw new Error('captureScroll: url required');
  outDir = outDir || path.join(process.cwd(), 'scroll-out');
  const framesDir = path.join(outDir, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });

  const browser = await chromium.launch({ headless, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader'] });
  const page = await browser.newPage({ viewport: { width, height } });
  const frames = [];
  const timeline = [];   // per step: { p, y, els:[{i,t,o,top,vis}] }
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const sigs = await page.evaluate(TAG_FN);
    const sigByIdx = new Map((Array.isArray(sigs) ? sigs : []).map((s) => [s.i, s]));
    const tracked = sigByIdx.size;

    for (let s = 0; s < steps; s++) {
      const p = s / (steps - 1);                       // 0 .. 1
      await page.evaluate((pp) => window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * pp), p);
      await page.waitForTimeout(STEP_WAIT_MS);
      const file = `frame-${String(Math.round(p * 100)).padStart(3, '0')}.png`;
      await page.screenshot({ path: path.join(framesDir, file) });
      frames.push(file);
      const state = await page.evaluate(READ_FN);
      timeline.push({ p: +p.toFixed(3), y: state.y, els: state.els });
    }

    // Which tracked elements ACTUALLY animate on scroll? transform or opacity varies across steps.
    const byEl = new Map();
    for (const step of timeline) for (const e of step.els) {
      if (!byEl.has(e.i)) byEl.set(e.i, []);
      byEl.get(e.i).push({ p: step.p, t: e.t, o: e.o, top: e.top });
    }
    const animated = [];
    for (const [i, kfs] of byEl) {
      const transforms = new Set(kfs.map(k => k.t));
      const oMin = Math.min(...kfs.map(k => k.o)), oMax = Math.max(...kfs.map(k => k.o));
      const transformVaries = transforms.size > 1;
      const opacityVaries = (oMax - oMin) > EPS;
      if (transformVaries || opacityVaries) {
        animated.push({ i, sig: sigByIdx.get(i) || null, opacityFrom: oMin, opacityTo: oMax, transformVaries,
          suggest: classifyScroll(kfs, transformVaries, oMin, oMax), keyframes: kfs });
      }
    }
    animated.sort((a, b) => (b.transformVaries + (b.opacityTo - b.opacityFrom)) - (a.transformVaries + (a.opacityTo - a.opacityFrom)));

    const result = { url, viewport: { width, height }, steps, tracked, animatedCount: animated.length, frames, animated, timeline };
    fs.writeFileSync(path.join(outDir, 'scroll-animation.json'), JSON.stringify(result, null, 1));
    fs.writeFileSync(path.join(outDir, 'scroll-report.html'), report(result));
    return { outDir, tracked, animatedCount: animated.length, frames: frames.length };
  } finally {
    await browser.close();
  }
}

function report(r) {
  const strip = r.frames.map((f, i) => `<figure><img src="frames/${f}" loading="lazy"><figcaption>${Math.round((i / (r.frames.length - 1)) * 100)}%</figcaption></figure>`).join('');
  const rows = r.animated.slice(0, 60).map(a => {
    const s = a.suggest || {};
    const eff = s.effect === 'reveal' ? `reveal ${s.direction || ''} @${Math.round((s.trigger || 0) * 100)}%` : (s.effect || '');
    const sig = a.sig ? `${a.sig.tag}${a.sig.cls ? '.' + a.sig.cls.split(' ').join('.') : ''}${a.sig.text ? ' — “' + a.sig.text + '”' : ''}` : '#' + a.i;
    const spark = a.keyframes.map(k => k.o.toFixed(2)).join(' → ');
    return `<tr><td class="mono">${sig}</td><td><b>${eff}</b></td><td>${a.opacityFrom.toFixed(2)}–${a.opacityTo.toFixed(2)}</td><td class="mono">${spark}</td></tr>`;
  }).join('');
  return `<!doctype html><meta charset=utf-8><title>Scroll animation — ${r.url}</title>
<style>body{font:14px system-ui;margin:24px;color:#111;background:#fafafa}h1{font-size:18px}.meta{color:#666}
.strip{display:flex;gap:8px;overflow-x:auto;padding:12px 0}.strip figure{margin:0;flex:0 0 auto;text-align:center}
.strip img{width:220px;border:1px solid #ddd;border-radius:6px;display:block}.strip figcaption{font-size:12px;color:#666;margin-top:4px}
table{border-collapse:collapse;width:100%;margin-top:14px;background:#fff}td,th{border:1px solid #e3e3e3;padding:6px 10px;text-align:left;font-size:13px}
th{background:#eef3fb;color:#2f74e6}.mono{font-family:ui-monospace,monospace;font-size:12px;color:#444}</style>
<h1>Scroll-animation capture</h1>
<p class="meta">${r.url} · ${r.viewport.width}×${r.viewport.height} · ${r.steps} steps · tracked ${r.tracked} elements · <b>${r.animatedCount} animate on scroll</b></p>
<div class="strip">${strip}</div>
<h2>Scroll-animated elements (top ${Math.min(60, r.animated.length)})</h2>
<table><tr><th>element (signature)</th><th>→ suggested effect</th><th>opacity range</th><th>opacity over scroll (0→100%)</th></tr>${rows || '<tr><td colspan=4>None detected — likely a canvas/WebGL scene (see filmstrip) or a static page.</td></tr>'}</table>`;
}

// CLI
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('scroll-capture.mjs')) {
  const args = process.argv.slice(2);
  const url = args.find(a => /^https?:\/\//.test(a));
  const outDir = args.find(a => !a.startsWith('--') && a !== url);
  const num = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? parseInt(args[i + 1], 10) : def; };
  if (!url) { console.error('usage: node scroll-capture.mjs <url> [outDir] [--steps N] [--width W] [--height H]'); process.exit(1); }
  captureScroll({ url, outDir, steps: num('--steps', 12), width: num('--width', 1440), height: num('--height', 900) })
    .then(r => console.log('scroll-capture done:', JSON.stringify(r)))
    .catch(e => { console.error('scroll-capture failed:', e.message); process.exit(1); });
}
