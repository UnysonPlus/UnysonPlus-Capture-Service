// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Joins rendered chapters into one video: a long video is made of scenes of at most 10 minutes each, rendered one by
// one, then joined here.
//
// When every part has the same size, frame rate, codecs and sound (chapters rendered by the kit do), they are joined
// without re-encoding: seconds, and not a pixel changes. Otherwise (different sizes, a part with no sound, or a fade
// between chapters) every part is fitted to the first one's size and frame rate and encoded once.
//
// It also writes the chapter list YouTube reads from a description ("0:00 Intro", one line per part), since a long
// video is where chapters help viewers most.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { hasFfmpeg, ffmpegNeeded } from './studio-ffmpeg.mjs';

const ffmpegBin = () => process.env.FFMPEG || 'ffmpeg';
const ffprobeBin = () => process.env.FFPROBE || 'ffprobe';

/** What a part is: its size, frame rate, codecs, sound and length. */
export function probeVideo(file) {
  const r = spawnSync(ffprobeBin(), ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,pix_fmt,sample_rate,channels:format=duration', '-of', 'json', file],
    { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (r.status !== 0) throw new Error(`${file} could not be read as a video: ${String(r.stderr).trim().slice(0, 200)}`);
  const j = JSON.parse(r.stdout || '{}');
  const v = (j.streams || []).find((s) => s.codec_type === 'video');
  const a = (j.streams || []).find((s) => s.codec_type === 'audio');
  if (!v) throw new Error(`${file} has no picture.`);
  const [n, d] = String(v.r_frame_rate || '30/1').split('/').map(Number);
  return {
    file, width: v.width, height: v.height, fps: d ? n / d : n, vcodec: v.codec_name, pix: v.pix_fmt,
    audio: a ? { codec: a.codec_name, rate: +a.sample_rate, channels: a.channels } : null,
    seconds: +((j.format || {}).duration) || 0,
  };
}

/** "0:00", "1:05", "1:02:03": the form YouTube reads chapter times in. */
export function chapterTime(s) {
  const t = Math.floor(s);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

/** A part's chapter title from its file name: "02-setting-up_1920x1080.mp4" -> "Setting up". */
export function titleFromFile(file) {
  const t = basename(file, extname(file)).replace(/[-_]\d{3,4}x\d{3,4}.*$/, '').replace(/^\d+[\s._-]+/, '').replace(/[-_]+/g, ' ').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : 'Chapter';
}

/** The chapter list for a video description. YouTube needs the first at 0:00, at least three, each 10 s or longer. */
export function chapterList(parts, titles = []) {
  let at = 0;
  const lines = parts.map((p, i) => { const line = `${chapterTime(at)} ${titles[i] || titleFromFile(p.file)}`; at += p.seconds; return line; });
  const usable = parts.length >= 3 && parts.every((p) => p.seconds >= 10);
  return { text: lines.join('\n'), usable };
}

/** Whether the parts can be joined as they are (no re-encode). */
function sameKind(parts) {
  const a = parts[0];
  return parts.every((p) => p.width === a.width && p.height === a.height && Math.abs(p.fps - a.fps) < 0.01 && p.vcodec === a.vcodec && p.pix === a.pix
    && !!p.audio === !!a.audio && (!a.audio || (p.audio.codec === a.audio.codec && p.audio.rate === a.audio.rate && p.audio.channels === a.audio.channels)));
}

function run(args, onTime) {
  return new Promise((ok, bad) => {
    const p = spawn(ffmpegBin(), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => {
      const s = String(d);
      err = (err + s).slice(-4000);
      const m = /time=(\d+):(\d+):(\d+\.?\d*)/.exec(s);
      if (m && onTime) onTime(+m[1] * 3600 + +m[2] * 60 + +m[3]);
    });
    p.on('error', bad);
    p.on('exit', (c) => (c === 0 ? ok() : bad(new Error(`Joining failed: ${err.trim().split('\n').slice(-3).join(' ')}`))));
  });
}

/**
 * Joins the parts, in order, into `out`.
 * opts.fade: seconds of fade through black between chapters (0 = straight cuts; any fade means a re-encode).
 * opts.titles: chapter titles in order (default: from the file names).
 * opts.onProgress(seconds done, seconds in all).
 * Returns { out, seconds, reencoded, parts, chapters: { text, usable }, chaptersFile }.
 */
export async function joinVideos(files, out, opts = {}) {
  if (!hasFfmpeg()) throw new Error(ffmpegNeeded('Joining videos'));
  const list = (files || []).map((f) => resolve(String(f)));
  if (list.length < 2) throw new Error('Give at least two videos to join, in order.');
  for (const f of list) if (!existsSync(f)) throw new Error(`${f} was not found.`);
  const target = resolve(out || 'joined.mp4');
  if (list.includes(target)) throw new Error('The joined video cannot overwrite one of its parts: choose another --out.');
  const parts = list.map(probeVideo);
  const total = parts.reduce((s, p) => s + p.seconds, 0);
  const fade = Math.max(0, Math.min(3, +opts.fade || 0));
  const onTime = opts.onProgress ? (t) => opts.onProgress(Math.min(t, total), total) : null;
  const reencoded = fade > 0 || !sameKind(parts);

  if (!reencoded) {
    // The concat demuxer reads a list of files and copies their streams end to end.
    const listFile = join(tmpdir(), `upw-join-${Date.now().toString(36)}.txt`);
    writeFileSync(listFile, parts.map((p) => `file '${p.file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
    try {
      await run(['-y', '-loglevel', 'error', '-stats', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', target], onTime);
    } finally { rmSync(listFile, { force: true }); }
  } else {
    // Every part fitted (letterboxed, not stretched) to the first part's size and frame rate; a part without sound
    // gets silence, so picture and sound stay in step; an optional fade through black at each chapter edge.
    const W = parts[0].width & ~1, H = parts[0].height & ~1, fps = Math.round(parts[0].fps * 1000) / 1000;
    const inputs = [];
    const chains = [];
    parts.forEach((p, i) => {
      inputs.push('-i', p.file);
      const first = i === 0, last = i === parts.length - 1;
      const fi = fade > 0 && !first ? `,fade=t=in:st=0:d=${fade}` : '';
      const fo = fade > 0 && !last ? `,fade=t=out:st=${Math.max(0, p.seconds - fade).toFixed(3)}:d=${fade}` : '';
      chains.push(`[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p${fi}${fo}[v${i}]`);
      const afi = fade > 0 && !first ? `,afade=t=in:st=0:d=${fade}` : '';
      const afo = fade > 0 && !last ? `,afade=t=out:st=${Math.max(0, p.seconds - fade).toFixed(3)}:d=${fade}` : '';
      if (p.audio) chains.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${p.seconds.toFixed(3)}${afi}${afo}[a${i}]`);
      else chains.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${p.seconds.toFixed(3)}[a${i}]`);
    });
    const joined = parts.map((_, i) => `[v${i}][a${i}]`).join('');
    const filter = `${chains.join(';')};${joined}concat=n=${parts.length}:v=1:a=1[v][a]`;
    await run(['-y', '-loglevel', 'error', '-stats', ...inputs, '-filter_complex', filter, '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', target], onTime);
  }

  const chapters = chapterList(parts, opts.titles || []);
  const chaptersFile = target.replace(/\.[a-z0-9]+$/i, '') + '-chapters.txt';
  writeFileSync(chaptersFile, chapters.text + '\n');
  const made = probeVideo(target);
  return { out: target, seconds: Math.round(made.seconds * 100) / 100, expected: Math.round(total * 100) / 100, reencoded, parts: parts.length, chapters, chaptersFile };
}
