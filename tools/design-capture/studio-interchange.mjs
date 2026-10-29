// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// "Finish in another editor": a scene's cut as a project other video editors open, next to the finished video.
//   project.fcpxml  FCPXML 1.10: DaVinci Resolve, Final Cut Pro
//   project.xml     the older XML interchange (xmeml 4): Adobe Premiere Pro
//   captions.srt    the voice-over's words as subtitles: every editor, YouTube, CapCut
// Footage and sound clips keep their place, in and out points and volume, each layer on its own track (bottom layer
// lowest). The graphics come in as one clip on the top track when a see-through render of the scene exists (Export ›
// Video, See-through); otherwise the folder's README says to make one. Media files are referred to where they are.

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The scene's footage and sound, in scene time: [{ kind, name, file, start, offset, duration, volume, track }]. */
export function cutOf(scene, baseDir) {
  const media = (src) => {
    if (typeof src !== 'string' || /^(data|blob|local|sfx):/.test(src)) return null;
    if (/^file:/.test(src)) return new URL(src).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    if (/^https?:/.test(src)) return null;
    const f = isAbsolute(src) ? src : resolve(baseDir, src);
    return existsSync(f) ? f : null;
  };
  const items = [], skipped = [];
  let track = 0;
  const walk = (layers, at) => layers.forEach((l) => {
    if (l.type === 'group') return walk(l.layers || [], at + (l.start ?? 0));
    if (l.type !== 'video') return;
    const file = media(l.src);
    if (!file) { skipped.push(l.name || l.id); return; }
    const start = at + (l.start ?? 0), end = at + (typeof l.end === 'number' ? l.end : scene.duration);
    items.push({ kind: 'video', name: l.name || l.id, file, start, offset: l.offset ?? 0, duration: Math.max(0.04, end - start), volume: l.sound ?? 0, track: ++track });
  });
  walk(scene.layers || [], 0);
  let atrack = 0;
  for (const a of scene.audio || []) {
    const file = media(a.src);
    if (!file) { skipped.push(a.name || a.id); continue; }
    const dur = typeof a.duration === 'number' ? a.duration : Math.max(0.04, scene.duration - (a.start ?? 0));
    items.push({ kind: 'audio', name: a.name || a.id, file, start: a.start ?? 0, offset: a.offset ?? 0, duration: Math.min(dur, scene.duration - (a.start ?? 0)), volume: a.volume ?? 1, track: ++atrack, role: a.role });
  }
  return { items, skipped };
}

/** Subtitles from the voice-overs' words: lines of up to 7 words, broken at pauses and sentence ends. */
export function srtOf(scene) {
  const words = [];
  for (const a of scene.audio || []) {
    if (!a.words?.length || (a.role && a.role !== 'voice')) continue;
    const S = a.start ?? 0, O = a.offset ?? 0, end = S + (typeof a.duration === 'number' ? a.duration : Infinity);
    for (const w of a.words) { const t = S + (w.t - O); if (t >= S - 0.01 && t < end) words.push({ w: w.w.trim(), t, d: w.d || 0.3 }); }
  }
  words.sort((a, b) => a.t - b.t);
  const lines = [];
  let cur = [];
  for (const w of words) {
    const last = cur[cur.length - 1];
    if (cur.length && (cur.length >= 7 || w.t - (last.t + last.d) > 0.5 || /[.!?]$/.test(last.w))) { lines.push(cur); cur = []; }
    cur.push(w);
  }
  if (cur.length) lines.push(cur);
  const ts = (s) => { const ms = Math.max(0, Math.round(s * 1000)); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, sec = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
  return lines.map((l, i) => `${i + 1}\n${ts(l[0].t)} --> ${ts(Math.min(l[l.length - 1].t + l[l.length - 1].d, (lines[i + 1]?.[0].t ?? Infinity) - 0.01))}\n${l.map((w) => w.w).join(' ')}\n`).join('\n');
}

/** FCPXML 1.10 (Resolve, Final Cut): a gap the scene's length on the main storyline, every clip connected to it. */
export function fcpxmlOf(scene, cut, { width, height, fps, graphics }) {
  const fr = (s) => `${Math.round(s * fps)}/${fps}s`;
  const assets = new Map();
  const assetOf = (file, kind) => {
    if (!assets.has(file)) assets.set(file, { id: `a${assets.size + 1}`, file, kind });
    return assets.get(file).id;
  };
  const clips = [];
  for (const c of cut.items) {
    const lane = c.kind === 'video' ? c.track : -c.track;
    const db = c.volume > 0 ? (20 * Math.log10(c.volume)).toFixed(1) : '-96';
    clips.push(`          <asset-clip ref="${assetOf(c.file, c.kind)}" lane="${lane}" name="${esc(c.name)}" offset="${fr(c.start)}" start="${fr(c.offset)}" duration="${fr(c.duration)}"${c.kind === 'audio' ? ' audioRole="' + (c.role === 'music' ? 'music' : c.role === 'sfx' ? 'effects' : 'dialogue') + '"' : ''}>${c.kind === 'video' && !c.volume ? '' : `\n            <adjust-volume amount="${db}dB"/>\n          `}</asset-clip>`);
  }
  if (graphics) clips.push(`          <asset-clip ref="${assetOf(graphics, 'video')}" lane="${cut.items.filter((c) => c.kind === 'video').length + 1}" name="Graphics" offset="0s" start="0s" duration="${fr(scene.duration)}"/>`);
  const res = [...assets.values()].map((a) => `    <asset id="${a.id}" name="${esc(basename(a.file))}" start="0s" hasVideo="${a.kind === 'video' ? 1 : 0}" hasAudio="1" format="r1">\n      <media-rep kind="original-media" src="${esc(pathToFileURL(a.file).href)}"/>\n    </asset>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="r1" name="FFVideoFormat${height}p${fps}" frameDuration="1/${fps}s" width="${width}" height="${height}"/>
${res}
  </resources>
  <library>
    <event name="${esc(scene.title || 'Kinetic Scenes')}">
      <project name="${esc(scene.title || 'Kinetic Scenes')}">
        <sequence format="r1" duration="${fr(scene.duration)}" tcStart="0s" tcFormat="NDF">
          <spine>
            <gap name="Scene" offset="0s" start="0s" duration="${fr(scene.duration)}">
${clips.map((c) => '  ' + c).join('\n')}
            </gap>
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}

/** The older XML interchange (xmeml 4) that Premiere Pro imports: one video track per footage layer, one audio track per clip. */
export function xmemlOf(scene, cut, { width, height, fps, graphics }) {
  const f = (s) => Math.round(s * fps);
  const rate = `<rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>`;
  let n = 0;
  const file = (path, kind) => `<file id="file-${++n}"><name>${esc(basename(path))}</name><pathurl>${esc(pathToFileURL(path).href)}</pathurl>${rate}<media>${kind === 'video' ? '<video/>' : ''}<audio/></media></file>`;
  const item = (c, kind) => `<clipitem id="clip-${++n}"><name>${esc(c.name)}</name>${rate}<start>${f(c.start)}</start><end>${f(c.start + c.duration)}</end><in>${f(c.offset)}</in><out>${f(c.offset + c.duration)}</out>${file(c.file, kind)}${kind === 'audio' && c.volume !== 1 ? `<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><parameter><parameterid>level</parameterid><value>${c.volume}</value></parameter></effect></filter>` : ''}</clipitem>`;
  const vids = cut.items.filter((c) => c.kind === 'video').map((c) => `<track>${item(c, 'video')}</track>`);
  if (graphics) vids.push(`<track>${item({ name: 'Graphics', file: graphics, start: 0, offset: 0, duration: scene.duration }, 'video')}</track>`);
  const auds = cut.items.filter((c) => c.kind === 'audio').map((c) => `<track>${item(c, 'audio')}</track>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4"><sequence id="sequence-1"><name>${esc(scene.title || 'Kinetic Scenes')}</name><duration>${f(scene.duration)}</duration>${rate}
<media><video><format><samplecharacteristics>${rate}<width>${width}</width><height>${height}</height></samplecharacteristics></format>${vids.join('')}</video><audio>${auds.join('')}</audio></media>
</sequence></xmeml>
`;
}

/** The newest see-through render of this scene in a renders folder (ProRes .mov or WebM with alpha), if any. */
function graphicsIn(dir) {
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).filter((n) => /-alpha.*\.(mov|webm)$/i.test(n)).map((n) => join(dir, n)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return f[0] || null;
}

/**
 * Writes the edit folder: { scene, baseDir (where its media paths start), out (the folder), graphics? (a see-through
 * render; default the newest in baseDir/renders) } → { dir, files, skipped, graphics }.
 */
export function writeInterchange({ scene, baseDir, out, graphics }) {
  const fmt = scene.video?.formats?.[0];
  const [w, h] = { '9x16': [1080, 1920], '1x1': [1080, 1080], '4x5': [1080, 1350], '16x9': [1920, 1080] }[fmt] || [1920, 1080];
  const fps = scene.video?.fps || 30;
  const gfx = graphics || graphicsIn(join(baseDir, 'renders'));
  const cut = cutOf(scene, baseDir);
  mkdirSync(out, { recursive: true });
  const files = [];
  const put = (name, text) => { writeFileSync(join(out, name), text); files.push(name); };
  put('project.fcpxml', fcpxmlOf(scene, cut, { width: w, height: h, fps, graphics: gfx }));
  put('project.xml', xmemlOf(scene, cut, { width: w, height: h, fps, graphics: gfx }));
  const srt = srtOf(scene);
  if (srt) put('captions.srt', srt);
  put('README.txt', [
    `${scene.title || 'Scene'}: the cut, for another video editor (${w}x${h}, ${fps} fps, ${scene.duration} s).`,
    '',
    'DaVinci Resolve: File > Import > Timeline, choose project.fcpxml.',
    'Final Cut Pro: File > Import > XML, choose project.fcpxml.',
    'Premiere Pro: File > Import, choose project.xml.',
    'Subtitles: import captions.srt (Resolve, Premiere, Final Cut, CapCut, YouTube).',
    '',
    gfx ? `The graphics (titles, shapes, 3D) are one see-through clip on the top track: ${basename(gfx)}.`
      : 'The graphics (titles, shapes, 3D) are not in it yet: render the scene as See-through ProRes (Export > Video, See-through, MOV) into this project, then export for another editor again.',
    cut.skipped.length ? `Left out (kept only in the browser, or on the web): ${cut.skipped.join(', ')}.` : '',
  ].filter((x, i, a) => x || a[i - 1]).join('\n') + '\n');
  return { dir: out, files, skipped: cut.skipped, graphics: gfx, clips: cut.items.length };
}
