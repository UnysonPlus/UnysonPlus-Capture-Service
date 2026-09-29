// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * NORMALISE VIDEO AT CAPTURE TIME, NOT AT IMPORT TIME.
 *
 * `media.json` used to be a list of URLs, so the WordPress host downloaded and processed every asset
 * itself. That works, but it puts the video work on the machine least likely to be able to do it: the
 * transcode and the poster frame both need ffmpeg, and a shared host almost never has it. The result was a
 * fix that worked perfectly in development and silently did nothing where it mattered.
 *
 * The capture service runs on the developer's own machine, where ffmpeg usually IS present. So the work
 * moves here: download each video once, transcode it if its codec is one many browsers cannot decode, cut
 * a poster frame, and ship both inside the bundle. Any host then gets a small H.264 file and a poster
 * regardless of what is installed on it.
 *
 * Why this matters beyond convenience — measured on one real conversion:
 *   · the source clip was HEVC, which Chrome and Firefox decode only on some platforms, so the converted
 *     backdrop did not play at all for many visitors;
 *   · it was 2,600,807 bytes at 4.2 Mbps, and the destination host served it at ~205 KB/s — twelve seconds
 *     of blank hero, because there was no poster either.
 *   · after: 395,115 bytes of H.264 (-85%) plus a poster on the first paint.
 *
 * Entirely optional. No ffmpeg, no network, or any failure at all → the entry is simply omitted and the
 * importer falls back to fetching that URL itself, exactly as before. A capture must never fail because a
 * video could not be re-encoded.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const run = promisify(execFile);

/** Codecs every current browser can decode. Anything else is a candidate for transcoding. */
const SAFE_CODECS = new Set(['h264', 'avc1', 'vp8', 'vp9']);
const VIDEO_RE = /\.(mp4|m4v|mov|webm|ogv)(\?|#|$)/i;

/** Is an ffmpeg-family binary runnable here? Resolved once. */
let _bins = null;
async function bins() {
  if (_bins) return _bins;
  const probe = async (name) => {
    try { await run(name, ['-version'], { timeout: 10000 }); return name; } catch { return ''; }
  };
  _bins = { ffmpeg: await probe('ffmpeg'), ffprobe: await probe('ffprobe') };
  return _bins;
}

/** The video's codec, or '' when it cannot be read. */
async function codecOf(file, ffprobe) {
  try {
    const { stdout } = await run(ffprobe, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name', '-of', 'default=noprint_wrappers=1:nokey=1', file,
    ], { timeout: 60000 });
    return String(stdout || '').trim().toLowerCase();
  } catch { return ''; }
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

/**
 * Download, transcode and poster every video in `urls`.
 *
 * @param {string} outdir  the capture-out directory for this site
 * @param {string[]} urls  every media URL the capture collected
 * @param {(m:string)=>void} [log]
 * @returns {Promise<Object>} map of source URL → { file, poster?, codec, bytes, was? }, paths RELATIVE to outdir
 */
export async function normalizeVideos(outdir, urls, log = () => {}) {
  const out = {};
  const vids = [...new Set((urls || []).map(String))].filter((u) => VIDEO_RE.test(u) && /^https?:/i.test(u));
  if (!vids.length) return out;

  const { ffmpeg, ffprobe } = await bins();
  if (!ffmpeg || !ffprobe) {
    log(`video normalisation skipped — ffmpeg not found (the importer will fetch ${vids.length} video(s) as before)`);
    return out;
  }

  const mediaDir = path.join(outdir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });

  for (const url of vids) {
    // one video failing must never stop the rest, nor the capture
    try {
      const base = (path.basename(new URL(url).pathname) || 'video.mp4').replace(/[^\w.-]+/g, '-');
      const stem = base.replace(/\.[^.]+$/, '') || 'video';
      const src = path.join(mediaDir, `_src-${base}`);
      await download(url, src);

      const codec = await codecOf(src, ffprobe);
      let file = src;
      let was = '';

      if (codec && !SAFE_CODECS.has(codec) && /\.(mp4|m4v|mov)$/i.test(base)) {
        const dst = path.join(mediaDir, `${stem}.mp4`);
        try {
          // CRF 24 + a 1080p cap: a decorative loop does not need a 4 Mbps master. `faststart` moves the
          // moov atom to the front so playback can begin before the file has finished arriving.
          await run(ffmpeg, ['-y', '-loglevel', 'error', '-i', src,
            '-c:v', 'libx264', '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-crf', '24',
            '-preset', 'veryfast', '-movflags', '+faststart',
            '-vf', "scale='min(1920,iw)':-2", '-an', dst], { timeout: 600000 });
          if (fs.existsSync(dst) && fs.statSync(dst).size > 1024) { file = dst; was = codec; }
        } catch { /* keep the original; a failed transcode is not an error */ }
      }

      // the poster: half a second in, because frame 0 of a fade-in loop is usually black
      let poster = '';
      const pdst = path.join(mediaDir, `${stem}-poster.jpg`);
      try {
        await run(ffmpeg, ['-y', '-loglevel', 'error', '-ss', '0.5', '-i', file,
          '-frames:v', '1', '-q:v', '4', pdst], { timeout: 120000 });
        if (fs.existsSync(pdst) && fs.statSync(pdst).size > 512) poster = path.relative(outdir, pdst);
      } catch { /* no poster is survivable; a wrong one is not */ }

      // Tidy the working name away. `_src-` marks the raw download; whatever ends up SHIPPING is named
      // after the asset, because this path appears in the bundle and in the media library after import.
      if (file !== src) {
        try { fs.unlinkSync(src); } catch { /* ignore */ }
      } else {
        const keep = path.join(mediaDir, base);
        try { if (keep !== src) { fs.renameSync(src, keep); file = keep; } } catch { /* keep the working name */ }
      }

      const rel = path.relative(outdir, file).split(path.sep).join('/');
      out[url] = {
        file: rel,
        ...(poster ? { poster: poster.split(path.sep).join('/') } : {}),
        codec: was ? 'h264' : (codec || 'unknown'),
        bytes: fs.statSync(file).size,
        ...(was ? { was } : {}),
      };
      log(was
        ? `video normalised: ${was} → h264, ${(fs.statSync(file).size / 1048576).toFixed(2)} MB${poster ? ' + poster' : ''}`
        : `video bundled as-is (${codec || 'unknown'})${poster ? ' + poster' : ''}`);
    } catch (e) {
      log(`video normalisation skipped for one asset (${String(e).slice(0, 80)}) — the importer will fetch it`);
    }
  }
  return out;
}
