// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Kinetic Scenes' voice-over from a script: no microphone, no account, no API. Piper (MIT, by the Rhasspy
// project) speaks each line of the script on this computer with a free voice model; the lines are joined with
// short pauses, and the kit's own speech recognition (studio-transcribe.mjs) then gives every word its time,
// so a scene can be built on the real narration (the audio is the clock). Each line is kept by its words, so
// changing one line of a script regenerates only that line.
//
// Piper and a voice are downloaded once, on request, into the kit (assembled/voices) or, for a standalone
// capture service, ~/.unysonplus/voices.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTranscribe, transcribeJob, transcribeStatus } from './studio-transcribe.mjs';
import { voiceboxSpeak, voiceboxStatus } from './studio-addons.mjs';
import { KOKORO_MB, KOKORO_VOICES, installKokoro, kokoroInstalled, kokoroSpeak } from './studio-kokoro.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PIPER = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/';
const PROGRAMS = {
  'win32-x64': { asset: 'piper_windows_amd64.zip', exe: 'piper.exe' },
  'linux-x64': { asset: 'piper_linux_x86_64.tar.gz', exe: 'piper' },
  'linux-arm64': { asset: 'piper_linux_aarch64.tar.gz', exe: 'piper' },
  'darwin-x64': { asset: 'piper_macos_x64.tar.gz', exe: 'piper' },
  'darwin-arm64': { asset: 'piper_macos_aarch64.tar.gz', exe: 'piper' },
};
const HF = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';
/** Free voices (Piper's own voice models, each under its own permissive licence). Sizes in MB. */
export const VOICES = {
  'en_US-lessac-medium': { path: 'en/en_US/lessac/medium/', label: 'Clear (American English)', mb: 63 },
  'en_US-ryan-medium': { path: 'en/en_US/ryan/medium/', label: 'Warm (American English)', mb: 63 },
  'en_GB-alba-medium': { path: 'en/en_GB/alba/medium/', label: 'Bright (British English)', mb: 63 },
};

function voicesDir() {
  if (process.env.UPW_VOICES_DIR) return resolve(process.env.UPW_VOICES_DIR);
  const assembled = resolve(HERE, '../../..');
  if (basename(assembled) === 'assembled') return join(assembled, 'voices');
  return join(homedir(), '.unysonplus', 'voices');
}
const platformKey = () => `${process.platform}-${process.arch}`;

function findFile(root, name, depth = 4) {
  if (!existsSync(root)) return null;
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, d] = stack.pop();
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isFile() && e.name === name) return p;
      if (e.isDirectory() && d < depth) stack.push([p, d + 1]);
    }
  }
  return null;
}
const program = () => { const spec = PROGRAMS[platformKey()]; return spec ? findFile(join(voicesDir(), 'piper'), spec.exe) : null; };
const modelFile = (id) => join(voicesDir(), 'models', `${id}.onnx`);
const hasVoice = (id) => existsSync(modelFile(id)) && existsSync(`${modelFile(id)}.json`);

let install = null;

export async function voiceStatus() {
  const t = await transcribeStatus();
  return {
    program: !!program() || kokoroInstalled(voicesDir()),
    canInstall: !!PROGRAMS[platformKey()],
    voices: Object.fromEntries([
      ...Object.entries(VOICES).map(([k, v]) => [k, { label: v.label, mb: v.mb, installed: hasVoice(k) }]),
      // Kokoro: more natural voices, one download for all six.
      ...Object.entries(KOKORO_VOICES).map(([k, v]) => [k, { label: v.label, mb: KOKORO_MB, installed: kokoroInstalled(voicesDir()), engine: 'kokoro' }]),
    ]),
    // The words' times come from the kit's speech recognition, which must be installed too.
    transcription: t.program && Object.values(t.models).some((m) => m.installed),
    // Voicebox (an add-on): the person's own voices, when the app is open.
    voicebox: await voiceboxStatus(),
    ffmpeg: t.ffmpeg,
    install: install ? { ...install } : null,
  };
}

async function download(url, dest, onBytes) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`Download failed (${r.status}) for ${basename(dest)}.`);
  const total = Number(r.headers.get('content-length')) || 0;
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const out = createWriteStream(part);
  let got = 0;
  for await (const chunk of r.body) {
    got += chunk.length;
    if (!out.write(chunk)) await new Promise((ok) => out.once('drain', ok));
    onBytes(got, total);
  }
  await new Promise((ok, bad) => out.end((e) => (e ? bad(e) : ok())));
  renameSync(part, dest);
}

function run(cmd, args, input) {
  return new Promise((ok, bad) => {
    const p = spawn(cmd, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', bad);
    p.on('exit', (c) => (c === 0 ? ok() : bad(new Error(`${basename(cmd)} failed (${c}): ${err.trim().split('\n').slice(-2).join(' ')}`))));
    if (input !== undefined) { p.stdin.write(input); p.stdin.end(); }
  });
}

/** Installs Piper and a voice, in the background (follow it with voiceStatus().install). */
export function startVoiceInstall(body = {}) {
  if (install && install.state === 'running') return { ...install };
  if (KOKORO_VOICES[body.voice]) {
    install = { state: 'running', step: 'Checking', done: 0, total: 0, error: '', voice: body.voice };
    installKokoro(voicesDir(), (step) => { install.step = step; })
      .then(() => { install.state = 'done'; install.step = 'Done'; })
      .catch((e) => { install.state = 'error'; install.error = String(e && e.message || e); });
    return { ...install };
  }
  const id = VOICES[body.voice] ? body.voice : 'en_US-lessac-medium';
  install = { state: 'running', step: 'Checking', done: 0, total: 0, error: '', voice: id };
  (async () => {
    try {
      const spec = PROGRAMS[platformKey()];
      if (!program()) {
        if (!spec) throw new Error('There is no ready-made voice program for this computer.');
        install.step = 'Downloading the voice program';
        const archive = join(voicesDir(), spec.asset);
        await download(PIPER + spec.asset, archive, (d, t) => { install.done = d; install.total = t; });
        install.step = 'Unpacking';
        const tar = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
        mkdirSync(join(voicesDir(), 'piper'), { recursive: true });
        await run(tar, ['-xf', archive, '-C', join(voicesDir(), 'piper')]);
        rmSync(archive, { force: true });
      }
      if (!hasVoice(id)) {
        install.step = `Downloading the voice (${VOICES[id].mb} MB)`;
        await download(`${HF}${VOICES[id].path}${id}.onnx`, modelFile(id), (d, t) => { install.done = d; install.total = t; });
        await download(`${HF}${VOICES[id].path}${id}.onnx.json`, `${modelFile(id)}.json`, () => {});
      }
      install.state = 'done';
      install.step = 'Done';
    } catch (e) {
      install.state = 'error';
      install.error = String(e && e.message || e);
    }
  })();
  return { ...install };
}

const jobs = new Map();
let seq = 0;

/** Seconds of a WAV file (from its header). */
function wavSeconds(file) {
  const b = readFileSync(file);
  const rate = b.readUInt32LE(24), bytesPerSec = b.readUInt32LE(28);
  return rate && bytesPerSec ? (b.length - 44) / bytesPerSec : 0;
}

/**
 * Recognition over a whole voice-over can run half a second late, but the kit knows exactly when each line was laid down.
 * So each line's words are fitted into that line's own window. Left as they are when the word counts differ (a misheard
 * name split in two), because the words can then not be shared out among the lines with any certainty.
 */
export function fitWordsToLines(words, segments) {
  const counts = segments.map((s) => s.text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length);
  if (counts.reduce((a, b) => a + b, 0) !== words.length) return words;
  const r = (x) => Math.round(x * 1000) / 1000;
  let i = 0;
  return segments.flatMap((seg, k) => {
    const line = words.slice(i, i += counts[k]);
    const a = line[0].t, b = line[line.length - 1].t + line[line.length - 1].d;
    const scale = b > a ? (seg.end - seg.start) / (b - a) : 1;
    return line.map((w) => ({ ...w, t: r(seg.start + (w.t - a) * scale), d: r(w.d * scale) }));
  });
}

/**
 * Speaks a script: { lines: string[], voice?, gap? (seconds between lines) } → a job. Its result:
 * { src (an MP3 data URL), duration, segments: [{ start, end, text }], words, speech } (words from the kit's
 * speech recognition, on the voice-over's own clock).
 */
export function startVoice(body = {}) {
  const lines = (Array.isArray(body.lines) ? body.lines : []).map((l) => String(l || '').trim()).filter(Boolean).slice(0, 80);
  if (!lines.length) throw Object.assign(new Error('Give the script (lines).'), { code: 400 });
  // "voicebox:<profile id>" speaks in one of the person's Voicebox voices; otherwise a built-in Piper voice.
  const voicebox = typeof body.voice === 'string' && body.voice.startsWith('voicebox:') ? body.voice.slice(9) : null;
  const kokoro = !voicebox && KOKORO_VOICES[body.voice] ? body.voice : null;
  const id = voicebox ? body.voice : kokoro || (VOICES[body.voice] ? body.voice : Object.keys(VOICES).find(hasVoice) || 'en_US-lessac-medium');
  if (kokoro && !kokoroInstalled(voicesDir())) throw Object.assign(new Error('Install the Kokoro voices first.'), { code: 400 });
  if (!voicebox && !kokoro && (!program() || !hasVoice(id))) throw Object.assign(new Error('Install the voice first.'), { code: 400 });
  const gap = Math.max(0.1, Math.min(2, Number(body.gap) || 0.4));
  // Piper's own pace is brisk; 1.12 is a calmer, explainer-like pace (higher is slower).
  const pace = Math.max(0.7, Math.min(1.6, Number(body.pace) || 1.12));
  const jid = `v${Date.now().toString(36)}${(seq++).toString(36)}`;
  const job = { id: jid, state: 'running', step: 'Speaking', error: '', result: null, started: Date.now() };
  jobs.set(jid, job);
  (async () => {
    const dir = join(tmpdir(), `upw-voice-${jid}`);
    mkdirSync(dir, { recursive: true });
    try {
      const cache = join(voicesDir(), 'cache');
      mkdirSync(cache, { recursive: true });
      const files = [];
      for (let i = 0; i < lines.length; i++) {
        job.step = `Speaking line ${i + 1} of ${lines.length}`;
        const key = createHash('sha1').update(`${id}|${voicebox ? '' : pace}|${lines[i]}`).digest('hex').slice(0, 16);
        const wav = join(cache, `${key}.wav`);
        if (!existsSync(wav)) {
          if (voicebox) {
            // Voicebox's own WAV, brought to one format so the lines and pauses join cleanly.
            const raw = join(dir, `line${i}.wav`);
            writeFileSync(raw, await voiceboxSpeak(voicebox, lines[i], { onWait: (s) => { job.step = `Speaking line ${i + 1} of ${lines.length} in Voicebox (${s} s${i === 0 && s > 20 ? '; the first line loads its model' : ''})`; } }));
            await run(process.env.FFMPEG || 'ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
          } else if (kokoro) {
            // Kokoro's speed is the inverse of Piper's length scale (higher is faster).
            if (i === 0) job.step = `Speaking line 1 of ${lines.length} (Kokoro loads its voices the first time)`;
            await kokoroSpeak(voicesDir(), kokoro, lines[i], wav, Math.round((1 / pace) * 100) / 100);
          } else await run(program(), ['--model', modelFile(id), '--length_scale', String(pace), '--output_file', wav], lines[i]);
        }
        files.push(wav);
      }
      // The lines, one after another, with a pause between them.
      job.step = 'Joining the lines';
      const segments = [];
      let t = 0;
      const list = join(dir, 'list.txt');
      const silence = join(dir, 'gap.wav');
      const ffmpeg = process.env.FFMPEG || 'ffmpeg';
      const rate = voicebox || kokoro ? 24000 : JSON.parse(readFileSync(`${modelFile(id)}.json`, 'utf8')).audio?.sample_rate || 22050;
      await run(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `anullsrc=r=${rate}:cl=mono`, '-t', String(gap), '-c:a', 'pcm_s16le', silence]);
      const parts = [];
      files.forEach((f, i) => {
        const len = wavSeconds(f);
        segments.push({ start: Math.round(t * 1000) / 1000, end: Math.round((t + len) * 1000) / 1000, text: lines[i] });
        t += len + (i < files.length - 1 ? gap : 0);
        parts.push(`file '${f.replace(/'/g, "'\\''")}'`);
        if (i < files.length - 1) parts.push(`file '${silence.replace(/'/g, "'\\''")}'`);
      });
      writeFileSync(list, parts.join('\n'));
      const mp3 = join(dir, 'voice.mp3');
      await run(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-ar', '44100', '-ac', '1', '-b:a', '96k', mp3]);
      const src = `data:audio/mpeg;base64,${readFileSync(mp3).toString('base64')}`;
      // Every word's time, from the kit's speech recognition (the same as for a recorded voice-over).
      job.step = 'Timing every word';
      const tj = startTranscribe({ src, language: 'en' });
      let words = [], speech = {};
      for (;;) {
        await new Promise((ok) => setTimeout(ok, 700));
        const info = transcribeJob(tj.id);
        if (!info) throw new Error('The word timing was lost.');
        if (info.state === 'error') throw new Error(info.error);
        if (info.state === 'done') { words = fitWordsToLines(info.result.words, segments); speech = info.result.speech; break; }
      }
      job.result = { src, duration: Math.round(t * 1000) / 1000, segments, words, speech, voice: id };
      job.state = 'done';
      job.step = 'Done';
    } catch (e) {
      job.state = 'error';
      job.error = String(e && e.message || e);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  })();
  return { id: jid, state: job.state };
}

export function voiceJob(id) {
  const j = jobs.get(id);
  if (!j) return null;
  return { id: j.id, state: j.state, step: j.step, error: j.error, result: j.state === 'done' ? j.result : null };
}

