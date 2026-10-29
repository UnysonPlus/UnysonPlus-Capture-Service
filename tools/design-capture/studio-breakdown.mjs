// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// "How this reel was made": a finished reel playing on one side and its storyboard on the other, in sync. Each beat is a
// card (number, kind, what it says, when it starts); a highlight moves to the card that is on screen and a progress bar
// runs under them. Useful for a pitch ("here is how we built your reel"), for teaching, and for Kinetic Scenes' own
// marketing. The result is an ordinary 16:9 scene: preview it in the Studio and export it like any other.
//
// The steps come from, in order of preference: a beats document (studio-beats.mjs: kind and words per beat), the
// scene's markers (b1… from beats, r1… from a reference rhythm, or any named markers), or a reference map's sections.
// When steps come from a scene, each card's words are the first text that appears during that step.

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const r2 = (x) => Math.round(x * 100) / 100;
const FFPROBE = () => process.env.FFPROBE || 'ffprobe';

function probe(file) {
  return new Promise((ok, bad) => {
    const p = spawn(FFPROBE(), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', bad);
    p.on('exit', (c) => { if (c) return bad(new Error(`Can't read ${file}`)); const j = JSON.parse(out); ok({ duration: Number(j.format?.duration) || 0, width: j.streams?.[0]?.width || 9, height: j.streams?.[0]?.height || 16 }); });
  });
}

const clipWords = (s, n = 60) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

/** The storyboard steps: [{ t, kind, words }]. */
export function breakdownSteps({ beats, scene, reference, duration }) {
  if (beats?.beats?.length && scene?.markers?.some((m) => /^b\d+$/.test(m.id))) {
    const at = scene.markers.filter((m) => /^b\d+$/.test(m.id)).sort((a, b) => a.t - b.t);
    return beats.beats.map((b, i) => ({ t: at[i]?.t ?? 0, kind: b.kind, words: [b.text, b.sub].filter(Boolean).join(' · ') || (b.items || []).join(', ') || (b.lines || []).join(' · ') }));
  }
  if (scene?.markers?.length) {
    const ms = [...scene.markers].sort((a, b) => a.t - b.t);
    const list = ms[0].t > 0.3 ? [{ id: 'start', t: 0, label: 'opening' }, ...ms] : ms;
    return list.map((m, i) => {
      const end = list[i + 1]?.t ?? duration;
      const text = (scene.layers || []).filter((l) => l.type === 'text' && (l.start ?? 0) >= m.t - 0.05 && (l.start ?? 0) < end && l.name !== 'Credit').sort((a, b) => (a.start ?? 0) - (b.start ?? 0))[0];
      return { t: m.t, kind: (m.label || `part ${i + 1}`).replace(/^\d+\s+/, ''), words: text ? text.text.replace(/\n/g, ' ') : '' };
    });
  }
  if (reference?.sections?.length) {
    const k = duration / reference.duration;
    return reference.sections.map((s) => ({ t: r2(s.from * k), kind: s.name, words: `${s.cuts} cut(s)` }));
  }
  throw new Error('Nothing to break down: give a beats document, a scene with markers, or a reference map.');
}

/**
 * Build the breakdown scene. video: the finished reel (path). Optional: scene (its scene object), beats (its beats
 * document), reference (a reference map), title, accent.
 */
export async function breakdownScene({ video, scene = null, beats = null, reference = null, title = 'How this reel was made', accent = '#00B295' }) {
  const info = await probe(video);
  const duration = r2(info.duration || scene?.duration || 0);
  if (!duration) throw new Error(`No length found for ${video}`);
  let steps = breakdownSteps({ beats, scene, reference, duration }).filter((s) => s.t < duration - 0.2);
  if (steps.length > 8) steps = steps.filter((_, i) => i % Math.ceil(steps.length / 8) === 0);
  steps[0].t = 0;

  const tall = info.height > info.width;
  const layers = [];
  let n = 0;
  const id = (p) => `${p}-${++n}`;
  const font = { fontFamily: 'Inter' };
  const add = (l) => { layers.push({ start: 0, end: duration, clips: [], ...l, id: id(l.type) }); return layers[layers.length - 1]; };

  // The reel.
  add({ type: 'video', name: 'The reel', src: resolve(video), fit: 'contain', box: tall ? { x: 25, y: 50, w: r2((88 * (info.width / info.height) * 9) / 16), ratio: info.width / info.height } : { x: 27, y: 50, w: 46, ratio: info.width / info.height },
    frame: tall ? 'phone' : 'browser', sound: 1, clips: [{ id: id('c'), preset: 'fade', start: 0, duration: 0.6 }] });

  // The storyboard column.
  const colX = tall ? 70 : 76, colW = tall ? 46 : 40;
  add({ type: 'text', name: 'Title', text: title, box: { x: colX - colW / 2, y: 8, w: colW * 0.42, anchor: 'left' }, style: { ...font, fontSize: 2.3, fontWeight: 800, color: '#ffffff', align: 'left' }, clips: [{ id: id('c'), preset: 'text-rise', start: 0.1, duration: 0.7, params: { direction: 'in', by: 'words', stagger: 0.06 } }] });
  const top = 17, room = 68, gapY = 1.6;
  const h = Math.min(13, (room - gapY * (steps.length - 1)) / steps.length);
  const step = h + gapY;
  steps.forEach((s, i) => {
    const y = top + h / 2 + i * step;
    const enter = 0.25 + i * 0.08;
    add({ type: 'shape', name: `Card ${i + 1}`, shape: 'rect', fill: '#171b21', stroke: '#2a3038', strokeWidth: 0.12, radius: 1, box: { x: colX, y, w: colW, h }, clips: [{ id: id('c'), preset: 'slide', start: enter, duration: 0.45, params: { direction: 'in', from: 'right', distance: 20 } }] });
    add({ type: 'text', name: `Step ${i + 1}`, text: `${String(i + 1).padStart(2, '0')}  ${s.kind.toUpperCase()}`, box: { x: colX - colW / 2 + 2.6, y: y - h * 0.22, w: colW * 0.6, anchor: 'left' }, style: { ...font, fontSize: 1.9, fontWeight: 700, letterSpacing: 0.08, color: accent, align: 'left' }, clips: [{ id: id('c'), preset: 'fade', start: enter + 0.1, duration: 0.4 }] });
    add({ type: 'text', name: `Time ${i + 1}`, text: mmss(s.t), box: { x: colX + colW / 2 - 2.6, y: y - h * 0.22, w: 8, anchor: 'right' }, style: { ...font, fontSize: 1.9, fontWeight: 500, color: '#8a93a0', align: 'right' }, clips: [{ id: id('c'), preset: 'fade', start: enter + 0.1, duration: 0.4 }] });
    if (s.words) add({ type: 'text', name: `Words ${i + 1}`, text: clipWords(s.words, 30), box: { x: colX - colW / 2 + 2.6, y: y + h * 0.22, w: colW - 5.2, anchor: 'left' }, style: { ...font, fontSize: 2.2, fontWeight: 500, lineHeight: 1.2, color: '#e8ebef', align: 'left' }, clips: [{ id: id('c'), preset: 'soft-wipe', start: enter + 0.15, duration: 0.5 }] });
  });

  // The highlight follows the reel: it steps to each card a moment before that beat starts and holds there.
  const frames = [{ t: 0, y: 0, opacity: 0 }, { t: 0.6, opacity: 1 }];
  steps.forEach((s, i) => { if (i) { frames.push({ t: r2(Math.max(frames[frames.length - 1].t + 0.01, s.t - 0.2)), y: r2((i - 1) * (step / (h + 0.6)) * 100) }); frames.push({ t: r2(s.t), y: r2(i * (step / (h + 0.6)) * 100), ease: 'power3.inOut' }); } });
  add({ type: 'shape', name: 'Now playing', shape: 'rect', fill: 'transparent', stroke: accent, strokeWidth: 0.3, radius: 1, box: { x: colX, y: top + h / 2, w: colW + 0.6, h: h + 0.6 },
    clips: [{ id: id('c'), preset: 'keyframes', start: 0, duration, ease: 'none', params: { frames } }] });

  // Progress under the cards.
  const barY = top + room + 2.2;
  add({ type: 'shape', name: 'Progress track', shape: 'rect', fill: '#2a3038', radius: 0.3, box: { x: colX, y: barY, w: colW, h: 0.5 } });
  add({ type: 'shape', name: 'Progress', shape: 'rect', fill: accent, radius: 0.3, box: { x: colX, y: barY, w: colW, h: 0.5 }, clips: [{ id: id('c'), preset: 'wipe', start: 0, duration, ease: 'none', params: { direction: 'in', from: 'left' } }] });
  add({ type: 'text', name: 'Credit', text: 'Made with\nkinetic-scenes.unysonplus.com', box: { x: colX + colW * 0.19, y: 8, w: colW * 0.62 }, style: { ...font, fontSize: 1.9, lineHeight: 1.3, fontWeight: 500, color: '#8a93a0', align: 'right' } });

  return {
    format: 'unysonplus-scene', version: 1, title: `${title}${scene?.title ? `: ${scene.title}` : ''}`, duration, mode: 'video',
    video: { formats: ['16x9'], fps: 30, platform: 'youtube' },
    stage: { breakpoints: [{ id: '16x9', label: '16:9', minWidth: 0, aspect: [16, 9] }], heightMode: 'fill', background: '#0d0f12',
      fonts: [{ family: 'Inter', href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap' }] },
    playback: { trigger: 'load', loop: false },
    layers,
    markers: steps.map((s, i) => ({ id: `s${i + 1}`, t: s.t, label: `${i + 1} ${s.kind}` })),
    audio: [],
  };
}
