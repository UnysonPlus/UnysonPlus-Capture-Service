/**
 * motion-record.mjs — record a page's motion frame by frame on a virtual clock (roadmap 10a).
 *
 * A virtual clock inside the page (installed before any page script) holds performance.now, Date.now, timers and
 * requestAnimationFrame, and every CSS animation, CSS transition and Web Animation is paused and set to that clock at
 * each step. The clock starts at the page's load event and moves only when the recorder advances it, so a 0.8 s
 * entrance is sampled at its real 0.8 s however slow the capture is. (Chrome's own virtual time was tried first: CSS
 * animations ignore it, and freezing their timeline also stops the frames that run in-view callbacks.)
 *
 * Phases: LOAD (from navigation) and VIEW (the page scrolled down in steps; each step's newly visible elements play
 * their in-view motion). For every element whose OWN opacity / transform / blur changes and then comes to rest, it
 * returns the delay from the phase start, the duration, the start state relative to the rest state (opacity, x, y in
 * px, scale, rotate in degrees, blur in px), the closest Animation Engine easing (engine-easings.json) and, for CSS /
 * Web Animations, the exact timing the browser reported. What cannot be expressed (never comes to rest, moves only with
 * the scroll, clip-path) is listed in `unmatched`.
 *
 *   import { recordMotion, stampMotionHtml } from './motion-record.mjs'
 *   node motion-record.mjs <url> [out.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let _eases = null;
function engineEases() {
  if (!_eases) {
    const j = JSON.parse(readFileSync(join(HERE, 'engine-easings.json'), 'utf8'));
    _eases = Object.entries(j.easings).map(([key, v]) => ({ key, label: v.label, fn: curve(v.css) })).filter((e) => e.fn);
  }
  return _eases;
}

/* ---- curves ------------------------------------------------------------- */

/** A CSS easing string → f(p) (p in 0..1), or null when not understood. */
export function curve(css) {
  const s = String(css || '').trim().toLowerCase();
  const kw = { linear: [0, 0, 1, 1], ease: [0.25, 0.1, 0.25, 1], 'ease-in': [0.42, 0, 1, 1], 'ease-out': [0, 0, 0.58, 1], 'ease-in-out': [0.42, 0, 0.58, 1] };
  if (kw[s]) { return s === 'linear' ? (p) => p : bezier(...kw[s]); }
  let m = s.match(/^cubic-bezier\(([^)]+)\)$/);
  if (m) { const n = m[1].split(',').map(Number); return n.length === 4 && n.every(isFinite) ? bezier(...n) : null; }
  m = s.match(/^linear\((.+)\)$/);
  if (m) {
    // Points, optionally with percentages ("0.5 40%"); missing positions are spread evenly.
    const pts = m[1].split(',').map((x) => x.trim().split(/\s+/)).map(([v, at]) => ({ v: Number(v), at: at ? parseFloat(at) / 100 : null }));
    if (!pts.length || pts.some((q) => !isFinite(q.v))) { return null; }
    pts[0].at = pts[0].at == null ? 0 : pts[0].at; pts[pts.length - 1].at = pts[pts.length - 1].at == null ? 1 : pts[pts.length - 1].at;
    for (let i = 1; i < pts.length - 1; i++) {
      if (pts[i].at == null) { let j = i; while (pts[j].at == null) { j++; } const a = pts[i - 1].at, b = pts[j].at; for (let k = i; k < j; k++) { pts[k].at = a + (b - a) * (k - i + 1) / (j - i + 1); } }
    }
    return (p) => {
      if (p <= pts[0].at) { return pts[0].v; }
      for (let i = 1; i < pts.length; i++) { if (p <= pts[i].at) { const a = pts[i - 1], b = pts[i]; return b.at === a.at ? b.v : a.v + (b.v - a.v) * (p - a.at) / (b.at - a.at); } }
      return pts[pts.length - 1].v;
    };
  }
  m = s.match(/^steps\((\d+)/);
  if (m) { const n = +m[1]; return (p) => Math.min(1, Math.floor(p * n) / n); }
  return null;
}
function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = (t) => ((ax * t + bx) * t + cx) * t, Y = (t) => ((ay * t + by) * t + cy) * t, dX = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (p) => {
    let t = p;
    for (let i = 0; i < 8; i++) { const e = X(t) - p, d = dX(t); if (Math.abs(e) < 1e-6 || Math.abs(d) < 1e-6) { break; } t -= e / d; }
    t = Math.max(0, Math.min(1, t));
    return Y(t);
  };
}
/** Root-mean-square distance between two curves over 0..1. */
function rms(f, g, n = 60) { let s = 0; for (let i = 0; i <= n; i++) { const p = i / n, d = f(p) - g(p); s += d * d; } return Math.sqrt(s / (n + 1)); }
/** Root-mean-square distance between a curve and measured (u, progress) points. */
function rmsPts(f, pts) { let s = 0; for (const [u, v] of pts) { const d = f(u) - v; s += d * d; } return Math.sqrt(s / Math.max(1, pts.length)); }

/** The engine easing closest to a CSS easing string, or to measured points. */
export function nearestEase(cssOrPoints) {
  const list = engineEases();
  let best = null;
  if (typeof cssOrPoints === 'string') {
    const f = curve(cssOrPoints);
    if (!f) { return null; }
    for (const e of list) { const r = rms(f, e.fn); if (!best || r < best.rms) { best = { key: e.key, rms: r }; } }
  } else {
    for (const e of list) { const r = rmsPts(e.fn, cssOrPoints); if (!best || r < best.rms) { best = { key: e.key, rms: r }; } }
  }
  return best && { key: best.key, rms: Math.round(best.rms * 1000) / 1000 };
}

/** The value the Interactions ease field should store for a CSS easing: an engine key when one matches closely, else the curve itself as cubic-bezier. */
function easeValue(css) {
  const kw = { ease: 'cubic-bezier(.25,.1,.25,1)', 'ease-in': 'cubic-bezier(.42,0,1,1)', 'ease-out': 'cubic-bezier(0,0,.58,1)', 'ease-in-out': 'cubic-bezier(.42,0,.58,1)' };
  const near = nearestEase(css);
  if (near && near.rms <= 0.015) { return { ease: near.key, rms: near.rms, exact: css }; }
  const s = String(css || '').trim().toLowerCase();
  if (/^cubic-bezier\(/.test(s)) { return { ease: s.replace(/\s+/g, ''), rms: 0, exact: css }; }
  if (kw[s]) { return { ease: kw[s], rms: 0, exact: css }; }
  return near ? { ease: near.key, rms: near.rms, exact: css } : { ease: 'soft_land', rms: 1, exact: css };
}

/* ---- the in-page part ----------------------------------------------------- */

// Runs in the page. Keeps the candidate elements and their samples; drives animations to the virtual clock.
export const INPAGE = `(() => {
  if (window.__upwMR) { return; }
  const SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, LINK: 1, TEMPLATE: 1, META: 1, HEAD: 1, BR: 1, SOURCE: 1, TRACK: 1 };
  const M = window.__upwMR = { els: new Map(), anims: new Map(), birth: new WeakMap(), order: 0, now: 0 };
  // A virtual clock for the page's own code: time, timers and animation frames move only when advance() says.
  const T0 = Date.now(), realDateNow = Date.now.bind(Date);
  let tid = 1, timers = new Map(), rafs = [], nextFrame = 0;
  try { performance.now = () => M.now; } catch (e) {}
  Date.now = () => T0 + M.now;
  window.setTimeout = function (fn, ms) { const a = Array.prototype.slice.call(arguments, 2), id = tid++; timers.set(id, { t: M.now + Math.max(0, +ms || 0), fn: fn, a: a }); return id; };
  window.setInterval = function (fn, ms) { const a = Array.prototype.slice.call(arguments, 2), id = tid++, ev = Math.max(4, +ms || 0); timers.set(id, { t: M.now + ev, fn: fn, a: a, every: ev }); return id; };
  window.clearTimeout = window.clearInterval = function (id) { timers.delete(id); };
  window.requestAnimationFrame = function (cb) { const id = tid++; rafs.push({ id: id, cb: cb }); return id; };
  window.cancelAnimationFrame = function (id) { rafs = rafs.filter((r) => r.id !== id); };
  const run = (fn, a) => { try { if (typeof fn === 'function') { fn.apply(window, a || []); } else if (typeof fn === 'string') { (0, eval)(fn); } } catch (e) {} };
  const due = (upto) => {
    for (let guard = 0; guard < 5000; guard++) {
      let pick = null;
      timers.forEach((v, id) => { if (v.t <= upto && (!pick || v.t < pick[1].t)) { pick = [id, v]; } });
      if (!pick) { return; }
      const [id, v] = pick;
      M.now = Math.max(M.now, v.t);
      if (v.every) { v.t += v.every; } else { timers.delete(id); }
      run(v.fn, v.a);
    }
  };
  M.advance = (dt) => {
    const target = M.now + dt;
    while (nextFrame <= target) {
      due(nextFrame);
      M.now = Math.max(M.now, nextFrame);
      const batch = rafs; rafs = [];
      batch.forEach((r) => { try { r.cb(M.now); } catch (e) {} });
      nextFrame += 1000 / 60;
    }
    due(target);
    M.now = target;
  };
  M.path = (el) => {
    const out = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      let i = 0; for (let s = n.parentElement && n.parentElement.firstElementChild; s && s !== n; s = s.nextElementSibling) { if (!SKIP[s.tagName]) { i++; } }
      out.push(n.tagName.toLowerCase() + ':' + i);
    }
    return out.reverse().join('/');
  };
  const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  M.read = (el) => {
    const cs = getComputedStyle(el);
    let tx = 0, ty = 0, sc = 1, rot = 0;
    const t = cs.transform;
    if (t && t !== 'none') {
      const m = new DOMMatrixReadOnly(t);
      tx = m.m41; ty = m.m42; sc = Math.hypot(m.a, m.b); rot = Math.atan2(m.b, m.a) * 180 / Math.PI;
    }
    if (cs.translate && cs.translate !== 'none') { const p = cs.translate.split(/\\s+/); tx += num(p[0]); ty += num(p[1]); }
    if (cs.scale && cs.scale !== 'none') { sc *= num(cs.scale.split(/\\s+/)[0]) || 1; }
    if (cs.rotate && cs.rotate !== 'none') { const r = cs.rotate.match(/(-?[\\d.]+)deg/); if (r) { rot += +r[1]; } }
    const b = (cs.filter || '').match(/blur\\((-?[\\d.]+)px\\)/);
    return [ +num(cs.opacity).toFixed(3), +tx.toFixed(1), +ty.toFixed(1), +sc.toFixed(3), +rot.toFixed(1), b ? +(+b[1]).toFixed(1) : 0, (cs.clipPath && cs.clipPath !== 'none') ? 1 : 0 ];
  };
  M.add = (el) => {
    if (!el || el.nodeType !== 1 || SKIP[el.tagName] || M.els.has(el) || M.els.size >= 700) { return; }
    if (!document.body || !document.body.contains(el)) { return; }
    M.els.set(el, { id: M.order++, series: [], last: null });
  };
  M.scan = () => {
    document.getAnimations().forEach((a) => { const t = a.effect && a.effect.target; if (t && t.nodeType === 1) { M.add(t); } });
    const all = document.body ? document.body.getElementsByTagName('*') : [];
    for (let i = 0; i < all.length && M.els.size < 700; i++) {
      const el = all[i];
      if (SKIP[el.tagName] || M.els.has(el)) { continue; }
      const cs = getComputedStyle(el);
      if ((+cs.opacity < 0.99) || (cs.transform !== 'none') || (cs.translate !== 'none') || (cs.scale !== 'none') || (cs.rotate !== 'none') || /blur/.test(cs.filter) || cs.visibility === 'hidden') { M.add(el); }
    }
  };
  // Class / style changes start most motion: watch them, and pick up the changed element and its animated children.
  new MutationObserver((list) => {
    list.forEach((r) => {
      const el = r.target; if (!el || el.nodeType !== 1) { return; }
      M.add(el);
      if (r.attributeName === 'class') {
        const kids = el.getElementsByTagName('*');
        for (let i = 0; i < kids.length && i < 400; i++) { const cs = getComputedStyle(kids[i]); if (cs.transitionDuration !== '0s' || cs.animationName !== 'none') { M.add(kids[i]); } }
      }
    });
  }).observe(document, { attributes: true, attributeFilter: ['class', 'style'], subtree: true });
  // Every animation follows the virtual clock: born at its first sight, its time = now - birth.
  // Every animation follows the virtual clock, but only while the PAGE has it playing: a library that builds its
  // animation paused and plays it on a trigger (the Animation Engine does) must not be played by the recorder. The page's
  // own play / pause / reverse / finish / cancel / currentTime calls are tracked; the recorder holds the animation paused
  // underneath and sets its time from the clock; at its end it calls the real finish(), so chained steps still run.
  const AP = window.Animation && Animation.prototype;
  const CT = AP && Object.getOwnPropertyDescriptor(AP, 'currentTime');
  const real = AP ? { play: AP.play, pause: AP.pause, finish: AP.finish, cancel: AP.cancel, reverse: AP.reverse } : null;
  const ctl = new Map();
  const cur = (c) => c.run ? c.base + c.rate * (M.now - c.birth) : c.base;
  const recOf = new WeakMap();
  if (AP && CT) {
    AP.play = function () { const c = ctl.get(this); if (!c) { return real.play.apply(this, arguments); } if (!c.run) { c.base = cur(c); c.birth = M.now; c.run = true; const r = recOf.get(this); if (r && r.born == null) { r.born = M.now - c.base; } } };
    AP.pause = function () { const c = ctl.get(this); if (!c) { return real.pause.apply(this, arguments); } c.base = cur(c); c.run = false; };
    AP.reverse = function () { const c = ctl.get(this); if (!c) { return real.reverse.apply(this, arguments); } c.base = cur(c); c.birth = M.now; c.rate = -c.rate; c.run = true; };
    AP.finish = function () { ctl.delete(this); return real.finish.apply(this, arguments); };
    AP.cancel = function () { ctl.delete(this); return real.cancel.apply(this, arguments); };
    Object.defineProperty(AP, 'currentTime', { configurable: true, get: CT.get, set: function (v) { const c = ctl.get(this); if (c) { c.base = +v || 0; c.birth = M.now; } CT.set.call(this, v); } });
  }
  M.tick = (now, dt) => {
    document.getAnimations().forEach((a) => {
      let c = ctl.get(a);
      if (!c) {
        if (M.birth.has(a)) { return; } // finished or cancelled: no longer ours
        const running = a.playState !== 'paused';
        c = { run: running, base: running ? 0 : (CT ? (CT.get.call(a) || 0) : 0), birth: now, rate: (a.playbackRate || 1) < 0 ? -1 : 1 };
        ctl.set(a, c); M.birth.set(a, now);
        const t = a.effect && a.effect.target;
        if (t && t.nodeType === 1) {
          M.add(t);
          const tm = a.effect.getTiming ? a.effect.getTiming() : {};
          let kfe = '';
          try { const k = a.effect.getKeyframes(); if (k && k[0] && k[0].easing && k[0].easing !== 'linear') { kfe = k[0].easing; } } catch (e) {}
          const rec = M.anims.get(t) || [];
          const r = { kind: a.constructor && a.constructor.name, name: a.animationName || a.transitionProperty || a.id || '', born: running ? now : null,
            delay: tm.delay || 0, duration: typeof tm.duration === 'number' ? tm.duration : 0, iterations: tm.iterations, easing: (tm.easing && tm.easing !== 'linear') ? tm.easing : (kfe || tm.easing || 'linear') };
          rec.push(r); recOf.set(a, r);
          M.anims.set(t, rec);
        }
      }
      try {
        if (a.playState !== 'paused' && real) { real.pause.call(a); }
        const v = Math.max(0, cur(c));
        if (CT) { CT.set.call(a, v); } else { a.currentTime = v; }
        let end = Infinity;
        try { end = a.effect.getComputedTiming().endTime; } catch (e) {}
        if (c.run && c.rate > 0 && isFinite(end) && v >= end && real) { ctl.delete(a); real.finish.call(a); }
      } catch (e) {}
    });
  };
  M.sample = (now) => {
    let changed = 0;
    M.els.forEach((r, el) => {
      if (!el.isConnected) { return; }
      const v = M.read(el), k = v.join(',');
      if (k !== r.last) { r.series.push([Math.round(now)].concat(v)); r.last = k; changed++; }
    });
    return changed;
  };
  M.dump = () => {
    const out = [];
    M.els.forEach((r, el) => {
      if (r.series.length < 2 || !el.isConnected) { return; }
      const rect = el.getBoundingClientRect();
      out.push({ id: r.id, path: M.path(el), tag: el.tagName.toLowerCase(), cls: String(el.className && el.className.baseVal != null ? el.className.baseVal : el.className || '').slice(0, 80),
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60), full: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300), w: Math.round(rect.width), h: Math.round(rect.height),
        series: r.series, anims: M.anims.get(el) || [] });
    });
    return out;
  };
})()`;

/* ---- the recorder ----------------------------------------------------------- */

/**
 * @param {object} o { browser, url, viewport?, step? (ms), log? }
 * @returns {Promise<object>} { version, url, viewport, step, phases, elements, unmatched }
 */
export async function recordMotion(o) {
  const step = o.step || 25;
  const viewport = o.viewport || { width: 1440, height: 900 };
  const log = o.log || (() => {});
  const ctx = await o.browser.newContext({ viewport, reducedMotion: 'no-preference' });
  const page = await ctx.newPage();
  let vnow = 0;
  const ev = (fn, arg) => Promise.race([page.evaluate(fn, arg), new Promise((r) => setTimeout(() => r(null), 8000))]).catch(() => null);
  try {
    await page.addInitScript({ content: INPAGE });
    // The clock starts at the page's load event: that is when on-load motion starts, and until then the page's
    // timers and frames are held, so nothing has played before the first sample.
    await page.goto(o.url, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(300);
    const phases = [{ kind: 'load', t0: 0, scrollY: 0 }];
    // One evaluate per step: optional scroll, advance the page clock, drive the animations, sample.
    const tick = (sy) => ev(([dt, sy]) => {
      const M = window.__upwMR; if (!M) { return -1; }
      if (sy != null) { window.scrollTo(0, sy); }
      M.advance(dt); M.tick(M.now, dt); return M.sample(M.now);
    }, [step, sy == null ? null : sy]).then((c) => { vnow += step; return c; });
    // The state at the start of the clock (time 0), before anything has moved.
    await ev(() => { const M = window.__upwMR; if (M) { M.scan(); M.tick(0, 0); M.sample(0); } });
    // Where each tracked element sits when the clock starts (page y): an "in view" motion that plays at load is
    // explained by the element being on screen then.
    const layout0 = (await ev(() => { const M = window.__upwMR; const o = {}; if (!M) { return o; } M.els.forEach((r, el) => { if (el.isConnected) { o[M.path(el)] = Math.round(el.getBoundingClientRect().top + window.scrollY); } }); return o; })) || {};
    // Frames for the side-by-side sheets (motion-verify): at chosen virtual times of the load phase, and a few after each scroll.
    const shots = [];
    const shotAt = new Set((o.shots || []).map((x) => Math.round(x / step) * step));
    const viewShotAt = new Set((o.viewShots || []).map((x) => Math.round(x / step) * step));
    const shoot = async (phase, t, scrollY) => { try { shots.push({ phase, t, scrollY, png: await page.screenshot({ type: 'jpeg', quality: 70 }) }); } catch (e) {} };
    if (shotAt.has(0)) { await shoot('load', 0, 0); }
    let quiet = 0, n = 1;
    for (let t = 0; t < 4500; t += step) {
      if (n % 12 === 0) { await ev(() => window.__upwMR && window.__upwMR.scan()); }
      const c = await tick(); n++;
      if (shotAt.has(t + step)) { await shoot('load', t + step, 0); }
      quiet = c > 0 ? 0 : quiet + step;
      if (t >= 1500 && quiet >= 700) { break; }
    }
    log(`motion: load phase ${vnow} ms`);
    // VIEW: scroll down in steps of 70% of the screen; at each, let in-view motion play.
    const docH = (await ev(() => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0))) || viewport.height;
    const stepY = Math.round(viewport.height * 0.7);
    for (let y = stepY; y < docH - 10 && phases.length < 40; y += stepY) {
      const yy = Math.min(y, Math.max(0, docH - viewport.height));
      phases.push({ kind: 'view', t0: vnow, scrollY: yy });
      quiet = 0;
      for (let t = 0; t < 3000; t += step) {
        const c = await tick(t === 0 ? yy : null);
        if (viewShotAt.has(t + step)) { await shoot('view', t + step, yy); }
        // In-view callbacks run on the next real frame: give the page a moment between steps.
        if (t < 100) { await page.waitForTimeout(20); }
        if (t === 50 || t === 150) { await ev(() => window.__upwMR && window.__upwMR.scan()); }
        quiet = c > 0 ? 0 : quiet + step;
        if (t >= 600 && quiet >= 400 && !(o.viewShots && o.viewShots.some((x) => x > t))) { break; }
      }
      if (yy >= docH - viewport.height) { break; }
    }
    log(`motion: ${phases.length - 1} scroll step(s), ${vnow} ms in all`);
    const raw = (await ev(() => window.__upwMR ? window.__upwMR.dump() : [])) || [];
    if (process.env.MR_DEBUG) { writeFileSync(process.env.MR_DEBUG, JSON.stringify({ raw, phases, end: vnow }, null, 1)); }
    const out = analyse(raw, phases, { url: o.url, viewport, step, end: vnow });
    // Where each element sits at the end (page coordinates), to tell "already on screen at load" from a real trigger change.
    out.layout = (await ev(() => { const M = window.__upwMR; const o = {}; if (!M) { return o; } M.els.forEach((r, el) => { if (el.isConnected) { const b = el.getBoundingClientRect(); o[M.path(el)] = Math.round(b.top + window.scrollY); } }); return o; })) || {};
    out.layout0 = layout0;
    if (shots.length) { out.shots = shots; }
    return out;
  } finally {
    await ctx.close().catch(() => {});
  }
}

/* ---- analysis --------------------------------------------------------------- */

const TOL = [0.02, 1, 1, 0.01, 0.5, 0.3]; // opacity, x, y, scale, rotate, blur
const differs = (a, b) => a.some((v, i) => i < 6 && Math.abs(v - b[i]) > TOL[i]);

export function analyse(raw, phases, meta) {
  const elements = [], unmatched = [];
  const phaseAt = (t) => { let p = phases[0]; for (const q of phases) { if (q.t0 <= t) { p = q; } } return p; };
  for (const r of raw) {
    // series rows: [t, o, x, y, s, r, b, clip]; a row is written only when something changed.
    const S = r.series.map((row) => ({ t: row[0], v: row.slice(1, 7), clip: row[7] }));
    const rest = S[S.length - 1];
    if (meta.end - rest.t < 120) {
      // Still changing at the very end: a loop, or motion that never settles.
      if (S.length > 6) { unmatched.push({ path: r.path, tag: r.tag, text: r.text, kind: 'loop', note: 'still moving at the end of the recording' }); }
      continue;
    }
    // The last stretch before rest: walk back over the rows that differ from the rest state. Rows are written only on
    // change, so the first of them (S[j]) is the start state, held until the next row, when the movement shows.
    // First skip the settling tail (rows already within tolerance of rest): its first row is when it arrived.
    let j = S.length - 1;
    while (j > 0 && !differs(S[j - 1].v, rest.v)) { j--; }
    // Then the continuous run of changes that ends there (rows one step apart); the row before it is the held start.
    let k = j;
    while (k > 0 && S[k].t - S[k - 1].t <= meta.step * 4) { k--; } // a slow stretch (an overshoot peak) can skip a few rows
    if (k >= j && !(k === 0 && j > 0)) { continue; } // never moved, or only appeared at rest
    const startRow = k > 0 ? S[k - 1] : S[0], firstMove = k > 0 ? S[k] : S[1];
    if (!firstMove || !differs(startRow.v, rest.v)) { continue; }
    const tStart = Math.max(startRow.t, firstMove.t - meta.step);
    const tEnd = rest.t;
    const ph = phaseAt(tStart);
    const from = startRow.v, to = rest.v;
    // Only motion that STARTS from a moved state (an entrance) is mapped; motion that only follows the scroll
    // (parallax) shows no time-based start and is reported.
    const sc = from[3] && to[3] ? from[3] / to[3] : 1;
    const delta = { opacity: +from[0].toFixed(2), x: Math.round(from[1] - to[1]), y: Math.round(from[2] - to[2]), scale: +(sc).toFixed(3), rotate: Math.round(from[4] - to[4]), blur: +(from[5] - to[5]).toFixed(1) };
    if (to[0] < 0.05) { unmatched.push({ path: r.path, tag: r.tag, text: r.text, kind: 'exit', note: 'ends hidden (an exit or a hidden state), not an entrance' }); continue; }
    if (S.some((q) => q.clip) && !Object.entries(delta).some(([k, v]) => (k === 'opacity' ? v < 0.98 : k === 'scale' ? Math.abs(v - 1) > 0.01 : Math.abs(v) > 1))) {
      unmatched.push({ path: r.path, tag: r.tag, text: r.text, kind: 'clip-path', note: 'reveals with a clip-path, which an Interaction step cannot animate' });
      continue;
    }
    // Exact timing from the browser when one finite animation / transition explains it.
    const anims = (r.anims || []).filter((a) => a.born != null && isFinite(a.iterations) && a.iterations >= 1 && a.duration > 0);
    let src = 'script', duration = (tEnd - tStart) / 1000, delay = (tStart - ph.t0) / 1000, ease;
    if (anims.length) {
      const a = anims.slice().sort((p, q) => (q.delay + q.duration) - (p.delay + p.duration))[0];
      src = /Transition/.test(a.kind) ? 'css-transition' : /CSSAnimation/.test(a.kind) ? 'css-animation' : 'web-animation';
      duration = a.duration / 1000;
      delay = Math.max(0, (a.born + a.delay - ph.t0) / 1000);
      ease = easeValue(a.easing);
    } else {
      // Fit the dominant property's progress curve against the engine's curves.
      const amp = [Math.abs(from[0] - to[0]), Math.hypot(from[1] - to[1], from[2] - to[2]) / 50, Math.abs(from[3] - to[3]) / 0.2, Math.abs(from[4] - to[4]) / 20, Math.abs(from[5] - to[5]) / 10];
      const k = amp.indexOf(Math.max(...amp));
      const val = (v) => k === 0 ? v[0] : k === 1 ? Math.hypot(v[1] - to[1], v[2] - to[2]) : v[k + 1];
      const v0 = val(from), v1 = val(to);
      const pts = [];
      let hold = from;
      for (let t = tStart; t <= tEnd; t += meta.step) {
        for (const q of S) { if (q.t <= t) { hold = q.v; } }
        const p = v1 === v0 ? 1 : (val(hold) - v0) / (v1 - v0);
        pts.push([(t - tStart) / Math.max(1, tEnd - tStart), p]);
      }
      const near = nearestEase(pts);
      ease = near ? { ease: near.key, rms: near.rms, exact: '' } : { ease: 'soft_land', rms: 1, exact: '' };
    }
    const frames = S.filter((q) => q.t >= tStart - meta.step && q.t <= tEnd).map((q) => [q.t - ph.t0].concat(q.v));
    elements.push({
      path: r.path, tag: r.tag, cls: r.cls, text: r.text, full: r.full || r.text, w: r.w, h: r.h,
      phase: ph.kind, scrollY: ph.scrollY, delay: Math.round(delay * 1000) / 1000, duration: Math.round(duration * 1000) / 1000,
      from: delta, ease: ease.ease, easeRms: ease.rms, easeSource: ease.exact || '', source: src, frames
    });
  }
  // Staggers: siblings in the same phase with the same motion and evenly spaced delays.
  const groups = {};
  elements.forEach((e) => { const parent = e.path.split('/').slice(0, -1).join('/'); const k = parent + '|' + e.phase + '|' + e.scrollY + '|' + e.duration + '|' + JSON.stringify(e.from); (groups[k] = groups[k] || []).push(e); });
  const staggers = Object.values(groups).filter((g) => g.length >= 3).map((g) => {
    const d = g.map((e) => e.delay).sort((a, b) => a - b), gaps = d.slice(1).map((v, i) => +(v - d[i]).toFixed(3));
    return { parent: g[0].path.split('/').slice(0, -1).join('/'), count: g.length, gap: gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length * 1000) / 1000 : 0, even: gaps.every((x) => Math.abs(x - gaps[0]) < 0.03) };
  });
  return { version: 1, url: meta.url, viewport: meta.viewport, step: meta.step, recordedMs: meta.end, phases, elements, staggers, unmatched };
}

/* ---- stamping ---------------------------------------------------------------- */

/** The compact attribute the converter reads: ph=load;d=0.2;du=0.8;e=soft_land;o=0;x=0;y=40;s=1;r=0;b=0;src=css-animation */
export function motionAttr(e) {
  const f = e.from;
  return ['ph=' + e.phase, 'd=' + e.delay, 'du=' + e.duration, 'e=' + e.ease, 'o=' + f.opacity, 'x=' + f.x, 'y=' + f.y, 's=' + f.scale, 'r=' + f.rotate, 'b=' + f.blur, 'src=' + e.source].join(';');
}

/** In the page: put each item's data-sc-motion on the element its path (checked by tag and text) points to. */
export function stampInPage(list) {
  const SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, LINK: 1, TEMPLATE: 1, META: 1, HEAD: 1, BR: 1, SOURCE: 1, TRACK: 1 };
  const kids = (n) => Array.prototype.filter.call(n.children, (c) => !SKIP[c.tagName]);
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const find = (path) => {
    let n = document.body;
    for (const part of path.split('/')) {
      const [tag, i] = part.split(':');
      const c = n && kids(n)[+i];
      if (!c || c.tagName.toLowerCase() !== tag) { return null; }
      n = c;
    }
    return n;
  };
  let stamped = 0, missed = 0;
  for (const it of list) {
    let el = find(it.path);
    if (el && it.text && norm(el.textContent) !== it.text) { el = null; }
    if (!el && it.text) {
      // The tree moved a little: take the one element of that tag with exactly that text.
      const c = Array.prototype.filter.call(document.body.getElementsByTagName(it.tag), (x) => norm(x.textContent) === it.text);
      if (c.length === 1) { el = c[0]; }
    }
    if (el) { el.setAttribute('data-sc-motion', it.attr); stamped++; } else { missed++; }
  }
  return { stamped, missed };
}

/** The items stampInPage takes, from a recording. */
export function stampItems(motion) {
  return (motion && motion.elements ? motion.elements : []).map((e) => ({ path: e.path, tag: e.tag, text: e.text, attr: motionAttr(e) }));
}

/**
 * Put data-sc-motion on the elements of a captured page's HTML (rendered.html), located by the recorder's element
 * path and checked by tag and text. Uses a page with scripts off, so the HTML is only parsed, never run.
 * @returns {Promise<{html: string, stamped: number, missed: number}>}
 */
export async function stampMotionHtml(browser, html, motion) {
  if (!html || !motion || !motion.elements || !motion.elements.length) { return { html, stamped: 0, missed: 0 }; }
  const ctx = await browser.newContext({ javaScriptEnabled: false });
  const page = await ctx.newPage();
  try {
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    const items = stampItems(motion);
    const r = await page.evaluate(stampInPage, items);
    const out = await page.content();
    return { html: out, stamped: r.stamped, missed: r.missed };
  } finally {
    await ctx.close().catch(() => {});
  }
}

/* ---- CLI ------------------------------------------------------------------------- */

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [url, out] = process.argv.slice(2);
  if (!url) { console.log('node motion-record.mjs <url> [out.json]'); process.exit(1); }
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const t0 = Date.now();
    const m = await recordMotion({ browser, url, log: (s) => console.log(s) });
    if (out) { writeFileSync(out, JSON.stringify(m, null, 1)); }
    console.log(`${m.elements.length} moving element(s), ${m.unmatched.length} unmatched, ${m.staggers.length} stagger group(s) — ${Math.round((Date.now() - t0) / 1000)} s`);
    for (const e of m.elements) { console.log(`  ${e.phase.padEnd(4)} ${e.tag.padEnd(4)} d=${e.delay}s du=${e.duration}s ${e.ease}${e.easeRms ? ' (rms ' + e.easeRms + ')' : ''} from ${JSON.stringify(e.from)} [${e.source}] "${e.text.slice(0, 30)}"`); }
    for (const u of m.unmatched) { console.log(`  unmatched ${u.kind}: ${u.tag} "${(u.text || '').slice(0, 30)}"`); }
  } finally { await browser.close(); }
}

/* ---- the catch-all pass on a built page (10b) ------------------------------------------------ */

const WRAPPER_TAGS = new Set(['div', 'section', 'article', 'li', 'figure', 'aside', 'header', 'footer', 'main', 'nav', 'ul', 'ol', 'form']);
const TEXT_ATT = /^(title|subtitle|text|content|label|desc|description|caption|button_label|quote)$/; // not `heading` (a level: h3)
const OWN_ATT = /^(title|subtitle|text|content|label|caption|button_label|quote)$/;
const mkey = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#039;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, '').slice(0, 80);

/** The Interaction value for a recording element (same as the converter's motion_interaction / motionInteraction). */
export function motionValue(e) {
  const f = e.from || {}, c = (v, lo, hi) => Math.max(lo, Math.min(hi, +v)), r = (v, n) => Math.round(v * 10 ** n) / 10 ** n;
  const mode = e.phase === 'view' ? 'view' : 'load';
  const step = { target: 'self', selector: '', action: 'animate', direction: 'from',
    x: Math.round(c(f.x ?? 0, -600, 600)), y: Math.round(c(f.y ?? 0, -600, 600)), scale: r(c(f.scale ?? 1, 0, 3), 3), rotate: Math.round(c(f.rotate ?? 0, -360, 360)),
    opacity: r(c(f.opacity ?? 1, 0, 1), 2), blur: r(c(f.blur ?? 0, 0, 30), 1), duration: r(c(e.duration ?? 0.6, 0.05, 4), 3), delay: r(c(e.delay ?? 0, 0, 4), 3),
    ease: String(e.ease || 'soft_land'), stagger: 0, start: 'after' };
  const val = { steps: { s1: step, s2: { target: 'none' }, s3: { target: 'none' } } };
  if (mode === 'view') val.leave = 'keep';
  return { mode, [mode]: val };
}

/**
 * Put each recorded motion the build did not carry on the builder node with the same text (whitespace ignored): a
 * wrapper element on the outermost layout node, a text element on the innermost element node. PHP twin:
 * FW_Site_Converter_Motion::apply. Returns { applied, already, unplaced: [ { tag, text, why } ] }.
 */
export function applyRecordedMotion(tree, motion) {
  const rep = { applied: 0, already: 0, unplaced: [] };
  if (!Array.isArray(tree) || !motion || !motion.elements || !motion.elements.length) return rep;
  const index = [];
  const text = (n) => { let t = ''; for (const [k, v] of Object.entries(n.atts || {})) if (typeof v === 'string' && TEXT_ATT.test(k)) t += v; for (const c of n._items || []) if (c && typeof c === 'object') t += text(c); return t; };
  const walk = (items, depth) => { for (const n of items) { if (!n || typeof n !== 'object') continue;
    const own = []; for (const [k, v] of Object.entries(n.atts || {})) if (typeof v === 'string' && OWN_ATT.test(k)) { const kk = mkey(v); if (kk) own.push(kk); }
    index.push({ node: n, own, depth, key: mkey(text(n)), layout: n.type !== 'simple', section: n.type === 'section' || (n.type === 'flexbox' && n.atts && n.atts.html_tag === 'section') });
    if (Array.isArray(n._items)) walk(n._items, depth + 1); } };
  walk(tree, 0);
  const hasMotion = (n) => { const ix = n.atts && n.atts.upw_interactions; return !!(ix && (ix.mode === 'load' || ix.mode === 'view')); };
  const same = (n, e) => { const ix = n.atts && n.atts.upw_interactions; if (!ix || !ix.mode || !ix[ix.mode]) return false; const s = (ix[ix.mode].steps || {}).s1 || {};
    return ix.mode === (e.phase === 'view' ? 'view' : 'load') && Math.abs((+s.delay) - e.delay) < 0.002 && Math.abs((+s.duration) - e.duration) < 0.002; };
  for (const e of motion.elements) {
    const k = mkey(e.full || e.text);
    if (!k) { rep.unplaced.push({ tag: e.tag, text: e.text, why: 'no text to match it by' }); continue; }
    let cands = index.filter((x) => !x.section && (x.key === k || (!x.layout && x.own.includes(k))));
    if (!cands.length) {
      const merged = index.some((x) => !x.section && x.key && x.key.includes(k));
      rep.unplaced.push({ tag: e.tag, text: e.text, why: merged ? 'its text became part of a larger element (merged), so it has no element of its own to move' : 'its text is not one element on the page (it was merged into another element)' });
      continue;
    }
    if (cands.some((x) => same(x.node, e))) { rep.already++; continue; }
    const wrapper = WRAPPER_TAGS.has(e.tag);
    cands.sort((a, b) => wrapper ? a.depth - b.depth : b.depth - a.depth);
    const pick = cands.find((x) => !(wrapper && !x.layout && cands.length > 1) && !hasMotion(x.node));
    if (!pick) { rep.unplaced.push({ tag: e.tag, text: e.text, why: 'the element it matches already moves with its own recorded motion (its text was merged into that element)' }); continue; }
    pick.node.atts = pick.node.atts || {};
    pick.node.atts.upw_interactions = motionValue(e);
    rep.applied++;
  }
  return rep;
}
