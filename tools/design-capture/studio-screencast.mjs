// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// A screencast recording (studio-record.mjs: video.mp4 + actions.json) as a ready Kinetic Scenes scene: the camera
// zooms to each action where it happens and pulls back between them, numbered step captions stay on screen, with an
// optional title, end card and music. 9:16 for Reels and TikTok, or 16:9.
//
//   node studio-cli.mjs screencast <recording folder> [--format 9x16|16x9] [--title "…"] [--end "…"] [--music file]

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r2 = (v) => Math.round(v * 100) / 100;

export function screencastScene(dir, opts = {}) {
  const rec = JSON.parse(readFileSync(join(dir, 'actions.json'), 'utf8'));
  const vertical = (opts.format || '9x16') !== '16x9';
  const SW = vertical ? 1080 : 1920, SH = vertical ? 1920 : 1080;
  const intro = opts.title ? Math.max(1.5, Number(opts.intro) || 2.6) : 0, outro = opts.end ? 3 : 0;
  const DUR = r2(intro + rec.seconds + outro);
  const accent = opts.accent || '#6B4CF6', ink = '#0f0d1a';
  // Where the video sits on the stage (% of the stage), and video pixels → stage %.
  const vh = (rec.height / rec.width) * SW / SH * 100; // video height in % of the stage
  const top = 50 - vh / 2;
  const toStage = (x, y) => ({ x: (x / rec.width) * 100, y: top + (y / rec.height) * vh });
  const zMin = vertical ? 2.2 : 1.2, zMax = vertical ? 4 : 2.6, overview = vertical ? 1.6 : 1;

  // One camera stop per place: a click and the typing that follows it are one stop.
  const stops = [];
  for (const a of rec.actions) {
    if (!a.rect) { stops.push({ t: a.t, end: a.end, label: a.label, wide: true }); continue; }
    const last = stops[stops.length - 1];
    const same = last && !last.wide && Math.abs(last.rect.x - a.rect.x) < 40 && Math.abs(last.rect.y - a.rect.y) < 40;
    if (same) { last.end = a.end; continue; }
    stops.push({ t: a.t, end: a.end, label: a.label, rect: a.rect });
  }
  const view = (s) => {
    if (s.wide) return { x: 0, y: 0, zoom: 1 };
    const c = toStage(s.rect.x + s.rect.w / 2, s.rect.y + s.rect.h / 2);
    const wPct = (s.rect.w / rec.width) * 100, hPct = (s.rect.h / rec.height) * vh;
    let z = Math.min(88 / Math.max(wPct * 1.15, 1), 60 / Math.max(hPct * 1.3, 1));
    z = clamp(z, zMin, zMax);
    // Keep the view inside the video.
    const halfW = 50 / z, halfH = 50 / z;
    // A target wider than the view (a long text field): look at its left part, where the typing is.
    const left = (s.rect.x / rec.width) * 100;
    const fx = wPct > 2 * halfW * 0.9 ? left + halfW * 0.85 : c.x;
    const cx = clamp(fx, halfW, 100 - halfW);
    const cy = vh >= 2 * halfH ? clamp(c.y, top + halfH, top + vh - halfH) : 50;
    return { x: r2(cx - 50), y: r2(cy - 50), zoom: r2(z) };
  };
  const keys = [];
  let k = 0;
  const key = (t, v, ease = 'inOut') => keys.push({ id: `k${k++}`, t: r2(Math.max(0, t)), x: v.x, y: v.y, zoom: v.zoom, ease });
  const wide = { x: 0, y: 0, zoom: overview };
  const start = { x: 0, y: 0, zoom: 1 };
  // Opens on the whole screen, then works close.
  key(0, start);
  if (intro) key(intro, start);
  let prevEnd = intro;
  stops.forEach((s, i) => {
    const t = intro + s.t, end = intro + s.end, v = view(s);
    const arrive = Math.max(prevEnd + 0.05, t - 0.35);
    key(Math.max(prevEnd + 0.05, arrive - 0.55), keys[keys.length - 1]); // hold, then move
    key(arrive, v);
    const next = stops[i + 1];
    const hold = end + 0.45;
    key(hold, v);
    if (!next || (intro + next.t) - hold > 2.2) { key(hold + 0.7, wide); prevEnd = hold + 0.7; } else prevEnd = hold;
  });
  keys.sort((a, b) => a.t - b.t);
  const dedup = keys.filter((x, i) => i === 0 || x.t > keys[i - 1].t + 0.01);

  let n = 0;
  const c = (preset, start, duration, params, extra = {}) => ({ id: `c${++n}`, preset, start: r2(start), duration, ...(params ? { params } : {}), ...extra });
  const out = (t, d = 0.25) => c('fade', t - d, d, { direction: 'out' });
  const layers = [];
  // Not pinned (pinned layers sit on top of everything): big enough that the camera never reaches its edges.
  // An image is looked for where it was given, then in the recording's folder; missing is an error (a missing
  // background once fell back to a plain shape without a word).
  const fileRef = (p) => {
    if (!p) return null;
    const f = [resolve(p), resolve(dir, p)].find((x) => existsSync(x));
    if (!f) throw new Error(`File not found: ${p}`);
    return relative(resolve(dir), f).split('\\').join('/');
  };
  const bgImg = fileRef(opts.bg), endImg = fileRef(opts.endBg) || bgImg;
  if (bgImg) layers.push({ id: 'bg', name: 'Background', type: 'image', src: bgImg, alt: '', fit: 'cover', box: { x: 50, y: 50, w: 400, h: 400 }, start: 0, end: DUR, clips: [] });
  else layers.push({ id: 'bg', name: 'Background', type: 'shape', shape: 'rect', box: { x: 50, y: 50, w: 400, h: 400 }, radius: 0, start: 0, end: DUR,
    fill: `radial-gradient(circle at 50% 30%, ${opts.glow || '#2a1f6b'} 0%, ${ink} 65%)`, clips: [] });
  layers.push({ id: 'screen', name: 'Screencast', type: 'video', src: rec.video, offset: 0, fit: 'cover', box: { x: 50, y: 50, w: 100, h: r2(vh) },
    sound: 0, start: intro, end: r2(intro + rec.seconds), alt: opts.alt || 'A screen recording', clips: [c('fade', intro, 0.3)] });
  const text = (id, t, y, size, o = {}) => layers.push({ id, name: id, type: 'text', text: t, pin: 'stage', box: { x: 50, y, w: vertical ? 70 : 86 }, start: r2(o.start), end: r2(o.end),
    style: { fontFamily: o.font || 'Space Grotesk', fontSize: size, fontWeight: 700, color: o.color || '#fff', align: 'center', lineHeight: 1.05 },
    ...(o.pill ? { pill: o.pill } : {}), clips: o.clips || [] });

  // Step captions: each new label, numbered, until the next one.
  const steps = [];
  const skip = /^(Save|Saved|Published|Open its settings|Desktop|Tablet|Mobile|Content Elements|Components|Layout Elements|Media Elements|Interactive Elements)$/i;
  const seen = new Set();
  for (const s of stops) {
    if (!s.label || skip.test(s.label) || seen.has(s.label)) continue; // each step once, in order
    seen.add(s.label); steps.push({ t: intro + s.t, label: s.label });
  }
  const capY = vertical ? 16 : 10;
  steps.forEach((s, i) => {
    const e = steps[i + 1]?.t ?? (intro + rec.seconds);
    text(`step${i + 1}`, `${i + 1}  ·  ${s.label}`, capY, vertical ? 5.4 : 2.6, { start: s.t, end: e, pill: { fill: accent, padX: 1, padY: 0.5, radius: 99 },
      clips: [c('pop', s.t, 0.35, null, { sound: { name: 'pop', volume: 0.25 } }), out(e)] });
  });
  const openImg = fileRef(opts.titleBg);
  if (opts.title && openImg) layers.push({ id: 'title-bg', name: 'Title card', type: 'image', src: openImg, alt: '', fit: 'cover', pin: 'stage', box: { x: 50, y: 50, w: 100, h: 100 }, start: 0, end: r2(intro + 0.3), clips: [c('fade', intro - 0.05, 0.35, { direction: 'out' })] });
  if (opts.title) {
    text('title', opts.title, vertical ? 40 : 42, vertical ? 10 : 5.5, { start: 0, end: intro, clips: [c('text-slam', 0.1, 0.45, null, { sound: { name: 'impact', volume: 0.3, at: 'end' } }), out(intro)] });
  }
  if (opts.end) {
    const s = intro + rec.seconds;
    if (endImg) layers.push({ id: 'end-bg', name: 'End card', type: 'image', src: endImg, alt: '', fit: 'cover', pin: 'stage', box: { x: 50, y: 50, w: 100, h: 100 }, start: r2(s), end: DUR, clips: [c('fade', s, 0.4)] });
    else layers.push({ id: 'end-bg', name: 'End card', type: 'shape', shape: 'rect', pin: 'stage', box: { x: 50, y: 50, w: 100, h: 100 }, radius: 0, start: r2(s), end: DUR,
      fill: `radial-gradient(circle at 50% 40%, ${opts.glow || '#3a2a9a'} 0%, ${ink} 70%)`, clips: [c('fade', s, 0.4)] });
    text('end', opts.end, vertical ? 44 : 45, vertical ? 9 : 5, { start: s, end: DUR, clips: [c('text-rise', s + 0.2, 0.6, null, { sound: { name: 'shimmer', volume: 0.3 } })] });
    if (opts.cta) text('cta', opts.cta, vertical ? 56 : 58, vertical ? 4.4 : 2.2, { start: s, end: DUR, pill: { fill: accent, padX: 1.1, padY: 0.5, radius: 99 }, clips: [c('pop', s + 0.9, 0.35)] });
  }

  const audio = [];
  // Voice-over: [{ at (seconds in the recording, or 'intro'), file, text }]. Each line plays at its moment; its subtitle
  // goes at the bottom, or at the top when the action on screen at that moment is in the lower part of the view.
  const lines = opts.voice ? JSON.parse(readFileSync(resolve(opts.voice), 'utf8')) : [];
  const voiceDir = opts.voice ? dirname(resolve(opts.voice)) : resolve(dir);
  const camAt = (t) => { let k0 = dedup[0]; for (const q of dedup) if (q.t <= t) k0 = q; return k0; };
  const actionAt = (t) => stops.filter((st) => st.rect && intro + st.t <= t + 0.6).pop();
  lines.forEach((ln, i) => {
    const at = ln.at === 'intro' ? 0.3 : r2(intro + Number(ln.at));
    const dur = Number(ln.seconds) || 3;
    // Voice files are named relative to the voice list; a missing one stops here rather than being left out.
    const src = ln.file ? fileRef(resolve(voiceDir, ln.file)) : null;
    if (ln.file && !src) throw new Error(`Voice file not found: ${resolve(voiceDir, ln.file)}`);
    if (src) audio.push({ id: `vo${i + 1}`, name: `Voice ${i + 1}`, role: 'voice', start: at, volume: 1, src });
    if (!ln.text) return;
    let y = vertical ? 72 : 86;
    const st = actionAt(at + 0.5), cam = camAt(at + 0.5);
    if (st && cam) {
      const ys = top + ((st.rect.y + st.rect.h / 2) / rec.height) * vh; // the action, in stage %
      const onScreen = 50 + (ys - (50 + (cam.y || 0))) * (cam.zoom || 1);
      if (onScreen > 52) y = vertical ? 25 : 16; // keep clear of it
    }
    const e = r2(at + dur + 0.3);
    layers.push({ id: `sub${i + 1}`, name: `Subtitle ${i + 1}`, type: 'text', text: ln.text, pin: 'stage', box: { x: 50, y, w: vertical ? 72 : 70 }, start: at, end: e,
      style: { fontFamily: 'Inter', fontSize: vertical ? 4.4 : 2.2, fontWeight: 700, color: '#ffffff', align: 'center', lineHeight: 1.2 },
      pill: { fill: 'rgba(15,20,22,.8)', padX: 0.9, padY: 0.45, radius: 1.4 }, clips: [c('fade', at, 0.2, { y: 15 }), out(e, 0.2)] });
  });
  if (opts.music && existsSync(resolve(opts.music))) audio.push({ id: 'music', name: 'Music', role: 'music', start: 0, duration: DUR, volume: 0.8, fadeOut: 1.5, src: relative(resolve(dir), resolve(opts.music)).split('\\').join('/') });
  return {
    format: 'unysonplus-scene', version: 1, title: opts.title || 'Screencast', duration: DUR, mode: 'video',
    video: { formats: [vertical ? '9x16' : '16x9'], fps: 30, platform: vertical ? 'reels' : 'youtube' },
    stage: { breakpoints: [{ id: vertical ? '9x16' : '16x9', label: vertical ? '9:16' : '16:9', minWidth: 0, aspect: vertical ? [9, 16] : [16, 9] }], heightMode: 'fill', background: ink, safeArea: 0.05,
      fonts: [{ family: 'Space Grotesk', href: 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700&display=swap' }, { family: 'Inter', href: 'https://fonts.googleapis.com/css2?family=Inter:wght@700&display=swap' }] },
    playback: { trigger: 'load', loop: false, posterTime: r2(intro + rec.seconds * 0.6) },
    layers, audio, markers: [], camera: { keys: dedup },
  };
}

/** Writes the scene next to the recording (it refers to video.mp4 there) and returns its path. */
export function writeScreencastScene(dir, opts = {}) {
  const scene = screencastScene(dir, opts);
  const file = join(dir, opts.name || `screencast-${(opts.format || '9x16')}.json`);
  writeFileSync(file, JSON.stringify(scene, null, 1));
  return { file, seconds: scene.duration, stops: scene.camera.keys.length, steps: scene.layers.filter((l) => l.id.startsWith('step')).length, name: basename(file) };
}
