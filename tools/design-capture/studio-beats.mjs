// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Beats: a reel described in a few lines, built into a full Kinetic Scenes scene in the client's brand.
//
//   { "brand": { "bg": "#000", "fg": "#fff", "accent": "#B08968", "font": "Jost", "logo": "logo.png" },
//     "format": "9x16",
//     "beats": [
//       { "kind": "headline", "text": "Fresh every morning." },
//       { "kind": "photo", "image": "coffee.jpg", "text": "Coffee", "sub": "Roasted down the road" },
//       { "kind": "split", "images": ["a.jpg", "b.jpg"], "text": "Pastry & food" },
//       { "kind": "list", "text": "On the menu", "items": ["Coffee", "Pastry", "Lunch"] },
//       { "kind": "proof", "text": "★ 4.8", "sub": "300+ reviews" },
//       { "kind": "close", "text": "Your Café", "lines": ["12 Main St", "@yourcafe"] } ] }
//
// Each kind is a complete, designed beat (layout, type, entrances, a held frame that stays alive), and every beat after
// the first arrives through the brand's transition (a slash band, a wipe or a soft fade). The close beat always carries
// the credit at its foot ("Made with" / "kinetic-scenes.unysonplus.com"), on the same frame as the client's details, so
// it can't be trimmed off without cutting their call to action. With a reference rhythm (studio-reference.mjs), beat
// lengths snap to the reference's moments, so the reel is paced like the one it learns from. The result is an ordinary
// scene: every layer can be edited in the Studio.

const r2 = (x) => Math.round(x * 100) / 100;
const FORMATS = { '9x16': [9, 16], '1x1': [1, 1], '4x5': [4, 5], '16x9': [16, 9] };
export const KINDS = ['headline', 'photo', 'split', 'list', 'proof', 'logo', 'close'];
const LENGTH = { headline: 2.6, photo: 3.2, split: 3.6, list: 3.8, proof: 2.8, logo: 2.6, close: 4.5 };
const CREDIT = ['Made with', 'kinetic-scenes.unysonplus.com'];

/** Check a beats document; returns problems in plain words (empty when it can be built). */
export function checkBeats(doc) {
  const problems = [];
  if (!doc || !Array.isArray(doc.beats) || !doc.beats.length) return ['Give at least one beat in "beats".'];
  doc.beats.forEach((b, i) => {
    const at = `Beat ${i + 1}`;
    if (!KINDS.includes(b.kind)) problems.push(`${at}: unknown kind "${b.kind}" (use ${KINDS.join(', ')}).`);
    if (b.kind === 'photo' && !b.image) problems.push(`${at}: a photo beat needs "image".`);
    if (b.kind === 'split' && (!Array.isArray(b.images) || b.images.length < 2)) problems.push(`${at}: a split beat needs two "images".`);
    if (b.kind === 'list' && (!Array.isArray(b.items) || !b.items.length)) problems.push(`${at}: a list beat needs "items".`);
    if (['headline', 'proof'].includes(b.kind) && !b.text) problems.push(`${at}: a ${b.kind} beat needs "text".`);
  });
  if (doc.beats.filter((b) => b.kind === 'close').length > 1) problems.push('Only one close beat: the reel ends on it.');
  if (doc.beats.some((b) => b.kind === 'close') && doc.beats[doc.beats.length - 1].kind !== 'close') problems.push('The close beat must be the last one (it carries the credit).');
  return problems;
}

/** Beat lengths: each beat's own (or its kind's default), scaled to `duration`, then snapped to the rhythm's moments. */
export function beatTimes(beats, { duration, rhythm } = {}) {
  let lens = beats.map((b) => Number(b.seconds) || LENGTH[b.kind] || 3);
  const total = lens.reduce((a, b) => a + b, 0);
  const target = Number(duration) || (rhythm ? rhythm.duration : total);
  lens = lens.map((l) => (l * target) / total);
  const starts = [];
  let at = 0;
  for (const l of lens) { starts.push(at); at += l; }
  if (rhythm && rhythm.moments?.length) {
    const k = target / rhythm.duration;
    const moments = rhythm.moments.map((m) => m.t * k);
    for (let i = 1; i < starts.length; i++) {
      const near = moments.filter((t) => Math.abs(t - starts[i]) <= 0.6 && t > starts[i - 1] + 1 && t < target - 1.2).sort((a, b) => Math.abs(a - starts[i]) - Math.abs(b - starts[i]))[0];
      if (near !== undefined) starts[i] = near;
    }
  }
  return starts.map((s, i) => ({ start: r2(s), end: r2(i + 1 < starts.length ? starts[i + 1] : target) }));
}

/** Build the scene. Options: duration (seconds; default the beats' own lengths), rhythm (a reference map), title, music. */
export function beatsScene(doc, { duration, rhythm, title, music } = {}) {
  const problems = checkBeats(doc);
  if (problems.length) throw new Error(problems.join(' '));
  const format = doc.format && FORMATS[doc.format] ? doc.format : '9x16';
  const [aw, ah] = FORMATS[format];
  const tall = ah > aw;
  const b = { bg: '#0d0d0f', fg: '#ffffff', accent: '#00B295', muted: null, font: 'Inter', transition: 'slash', ...(doc.brand || {}) };
  b.muted = b.muted || `${b.fg}b3`;
  const times = beatTimes(doc.beats, { duration: duration || doc.duration, rhythm });
  const layers = [];
  const W = tall ? 1 : aw / ah; // text sizes are in stage-width units, so wide formats need smaller numbers
  const size = (n) => r2(n / W);
  const font = { fontFamily: b.font };
  let uid = 0;
  const id = (p) => `${p}-${++uid}`;
  const clip = (preset, start, duration, params, ease) => ({ id: id('c'), preset, start: r2(start), duration: r2(duration), ...(ease ? { ease } : {}), ...(params ? { params } : {}) });
  // On vertical video the apps cover the top ~10%, the bottom ~22% and a strip ~15% wide on the right (their buttons),
  // so words sit between 12% and 75% down, centred a little left of the middle and no wider than 74%.
  const safe = (box) => (tall && box.anchor !== 'left' ? { ...box, x: 46, w: Math.min(box.w || 74, 74), y: Math.max(13, Math.min(74, box.y)) } : tall ? { ...box, w: Math.min(box.w || 64, 64), y: Math.max(13, Math.min(74, box.y)) } : box);
  const text = (name, value, box, style, start, end, clips) => layers.push({ id: id('t'), name, type: 'text', text: value, box: safe(box), style: { ...font, color: b.fg, align: 'center', ...style }, start: r2(start), end: r2(end), clips });
  const shape = (name, fill, box, start, end, clips, extra = {}) => layers.push({ id: id('s'), name, type: 'shape', shape: 'rect', fill, box, start: r2(start), end: r2(end), clips, ...extra });
  const image = (name, src, box, start, end, clips, extra = {}) => layers.push({ id: id('i'), name, type: 'image', src, fit: 'cover', box, start: r2(start), end: r2(end), clips, ...extra });

  /** The arrival of a beat: the base layer comes in through the brand's transition. */
  const arrive = (i, s) => {
    if (i === 0) return [clip('fade', s, 0.5)];
    if (b.transition === 'wipe') return [clip('wipe', s, 0.6, { direction: 'in', from: i % 2 ? 'left' : 'right' })];
    if (b.transition === 'fade') return [clip('soft-wipe', s, 0.7, { direction: 'in', from: 'left', feather: 30 })];
    return [clip('tr-slash', s, 0.6, { direction: 'in', angle: 25, color: b.accent, glow: false })];
  };
  const full = { x: 50, y: 50, w: 100, h: 100 };

  doc.beats.forEach((beat, i) => {
    const { start: s, end: e } = times[i];
    const len = e - s;
    const enter = s + (i ? 0.35 : 0.15);
    const hold = () => clip('drift', s, len, { x: 0, y: -2, scale: 1.05, rotate: 0 }, 'none');
    switch (beat.kind) {
      case 'headline': {
        shape('Background', beat.bg || b.bg, full, s, e, arrive(i, s));
        text('Headline', beat.text, { x: 50, y: beat.sub ? 46 : 50, w: 84 }, { fontSize: size(beat.text.length > 22 ? 8.5 : 11), fontWeight: 800, lineHeight: 1.05, letterSpacing: -0.02 }, s, e,
          [clip('text-rise', enter, 0.8, { direction: 'in', by: 'words', stagger: 0.08 }), hold()]);
        if (beat.sub) text('Line', beat.sub, { x: 50, y: 60, w: 80 }, { fontSize: size(4.2), fontWeight: 500, color: b.muted }, s, e, [clip('fade', enter + 0.5, 0.5)]);
        break;
      }
      case 'photo': {
        image('Photo', beat.image, full, s, e, [...arrive(i, s), hold()], { alt: beat.alt || beat.text || '' });
        if (beat.text || beat.sub) shape('Shade', 'linear-gradient(180deg, rgba(0,0,0,0) 45%, rgba(0,0,0,.72) 100%)', full, s, e, [clip('fade', s + 0.2, 0.5)]);
        if (beat.text) text('Caption', beat.text, { x: 50, y: beat.sub ? 62 : 68, w: 84 }, { fontSize: size(9), fontWeight: 800, uppercase: true, letterSpacing: 0.04, color: '#ffffff' }, s, e,
          [clip('text-rise', enter, 0.7, { direction: 'in', by: 'chars', stagger: 0.025 })]);
        if (beat.sub) text('Line', beat.sub, { x: 50, y: 69, w: 80 }, { fontSize: size(4.2), fontWeight: 500, color: '#ffffffdd' }, s, e, [clip('fade', enter + 0.4, 0.5)]);
        break;
      }
      case 'split': {
        shape('Background', b.bg, full, s, e, arrive(i, s));
        const [a, c] = beat.images;
        const half = tall ? [{ x: 50, y: 25, w: 100, h: 50 }, { x: 50, y: 75, w: 100, h: 50 }] : [{ x: 25, y: 50, w: 50, h: 100 }, { x: 75, y: 50, w: 50, h: 100 }];
        image('Photo 1', a, half[0], s, e, [clip('wipe', s + 0.15, 0.7, { direction: 'in', from: tall ? 'left' : 'top' }), hold()]);
        image('Photo 2', c, half[1], s, e, [clip('wipe', s + 0.45, 0.7, { direction: 'in', from: tall ? 'right' : 'bottom' }), hold()]);
        shape('Divider', b.accent, tall ? { x: 50, y: 50, w: 100, h: 0.6 } : { x: 50, y: 50, w: 0.4, h: 100 }, s, e, [clip('wipe', s + 0.8, 0.5, { direction: 'in', from: 'left' })]);
        if (beat.text) text('Label', beat.text, { x: 50, y: 50, w: 86 }, { fontSize: size(7), fontWeight: 800, uppercase: true, letterSpacing: 0.06 }, s, e, [clip('text-slam', s + 1, 0.6)], );
        if (beat.text) layers[layers.length - 1].pill = { fill: b.bg, padX: 0.6, padY: 0.3, radius: 0.2 };
        break;
      }
      case 'list': {
        shape('Background', beat.bg || b.bg, full, s, e, arrive(i, s));
        const items = beat.items.slice(0, 6);
        const top = beat.text ? 32 : 26, gap = tall ? 8 : 13;
        if (beat.text) text('Title', beat.text, { x: 50, y: top - (tall ? 11 : 14), w: 84 }, { fontSize: size(7.5), fontWeight: 800 }, s, e, [clip('text-rise', enter, 0.7, { direction: 'in', by: 'words', stagger: 0.06 }), hold()]);
        items.forEach((item, k) => {
          shape(`Mark ${k + 1}`, b.accent, { x: 10, y: top + k * gap, w: tall ? 2.2 : 1.2, ratio: 1 }, s, e, [clip('pop', enter + 0.3 + k * 0.22, 0.4)], { shape: 'ellipse' });
          text(`Item ${k + 1}`, item, { x: 15, y: top + k * gap, w: 70, anchor: 'left' }, { fontSize: size(6), fontWeight: 600, align: 'left' }, s, e, [clip(k % 2 ? 'stack-in' : 'slide', enter + 0.3 + k * 0.2 + (k % 3) * 0.04, 0.5, k % 2 ? { direction: 'in' } : { direction: 'in', from: 'left', distance: 30 })]);
        });
        break;
      }
      case 'proof': {
        shape('Background', beat.bg || b.accent, full, s, e, arrive(i, s));
        text('Proof', beat.text, { x: 50, y: 45, w: 86 }, { fontSize: size(16), fontWeight: 800, letterSpacing: -0.03, color: beat.color || b.fg }, s, e, [clip('text-slam', enter, 0.7), hold()]);
        if (beat.sub) text('Line', beat.sub, { x: 50, y: 58, w: 80 }, { fontSize: size(4.6), fontWeight: 600, color: beat.color || b.fg }, s, e, [clip('text-tracking', enter + 0.4, 0.9)]);
        break;
      }
      case 'logo': {
        shape('Background', beat.bg || b.bg, full, s, e, arrive(i, s));
        const logo = beat.image || b.logo;
        if (logo) image('Logo', logo, { x: 50, y: 42, w: tall ? 34 : 18, ratio: beat.ratio || 1 }, s, e, [clip('pop', enter, 0.6), hold()], { fit: 'contain' });
        if (beat.text) text('Name', beat.text, { x: 50, y: logo ? 62 : 50, w: 86 }, { fontSize: size(logo ? 6.5 : 11), fontWeight: 800, letterSpacing: 0.08, uppercase: true }, s, e, [clip('text-tracking', enter + 0.3, 1)]);
        break;
      }
      case 'close': {
        shape('Background', beat.bg || b.accent, full, s, e, arrive(i, s));
        const logo = beat.image || b.logo;
        let y = tall ? 24 : 30;
        if (logo) { image('Logo', logo, { x: 50, y, w: tall ? 26 : 12, ratio: beat.ratio || 1 }, s, e, [clip('pop', enter, 0.6)], { fit: 'contain' }); y += tall ? 13 : 22; }
        if (beat.text) { text('Name', beat.text, { x: 50, y, w: 86 }, { fontSize: size(7.5), fontWeight: 800, letterSpacing: 0.06, uppercase: true, color: beat.color || b.fg }, s, e, [clip('text-rise', enter + 0.2, 0.7, { direction: 'in', by: 'chars', stagger: 0.03 })]); y += tall ? 8 : 12; }
        (beat.lines || []).slice(0, 4).forEach((line, k) => {
          text(`Detail ${k + 1}`, line, { x: 50, y: y + k * (tall ? 4.4 : 7), w: 86 }, { fontSize: size(4.2), fontWeight: 500, color: beat.color || b.fg }, s, e, [clip('fade', enter + 0.5 + k * 0.15, 0.5)]);
        });
        // The credit, on the client's own closing frame (never a separate end card).
        text('Credit', CREDIT.join('\n'), { x: 50, y: tall ? 72 : 86, w: 80 }, { fontSize: size(3.6), fontWeight: 500, lineHeight: 1.35, color: beat.color || b.fg }, s, e, [clip('fade', enter + 0.9, 0.6)]);
        layers[layers.length - 1].opacity = 0.85;
        layers[layers.length - 2]?.clips?.push(hold());
        break;
      }
    }
  });

  const total = times[times.length - 1].end;
  const scene = {
    format: 'unysonplus-scene', version: 1, title: title || doc.title || 'Beats', duration: r2(total), mode: 'video',
    video: { formats: [format], fps: 30, platform: format === '16x9' ? 'youtube' : 'shorts' },
    stage: { breakpoints: [{ id: format, label: format.replace('x', ':'), minWidth: 0, aspect: [aw, ah] }], heightMode: 'fill', background: b.bg, safeArea: 0.06,
      fonts: b.font && !/^(Arial|Helvetica|system-ui|sans-serif|serif)$/i.test(b.font) ? [{ family: b.font, href: `https://fonts.googleapis.com/css2?family=${encodeURIComponent(b.font)}:wght@300;400;500;600;700;800&display=swap` }] : [] },
    playback: { trigger: 'load', loop: false },
    layers,
    markers: doc.beats.map((beat, i) => ({ id: `b${i + 1}`, t: times[i].start, label: `${i + 1} ${beat.kind}` })),
    audio: music ? [{ id: 'music', name: 'Music', role: 'music', src: music, start: 0, volume: 0.5 }] : [],
  };
  return scene;
}
