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
  // One free voice for each common language, for a video translated into it (Translate a video). Only voices this Piper
  // build can load (newer models with multi-letter phonemes fail on it), so a few languages have a basic-quality voice.
  'es_MX-ald-medium': { path: 'es/es_MX/ald/medium/', label: 'Spanish (Mexico)', mb: 63, lang: 'es' },
  'es_AR-daniela-high': { path: 'es/es_AR/daniela/high/', label: 'Spanish (Argentina)', mb: 114, lang: 'es' },
  'fr_FR-tom-medium': { path: 'fr/fr_FR/tom/medium/', label: 'French', mb: 64, lang: 'fr' },
  'de_DE-thorsten-high': { path: 'de/de_DE/thorsten/high/', label: 'German', mb: 114, lang: 'de' },
  'it_IT-riccardo-x_low': { path: 'it/it_IT/riccardo/x_low/', label: 'Italian (basic quality)', mb: 28, lang: 'it' },
  'pt_BR-edresson-low': { path: 'pt/pt_BR/edresson/low/', label: 'Portuguese (Brazil, basic quality)', mb: 63, lang: 'pt' },
  'nl_NL-mls-medium': { path: 'nl/nl_NL/mls/medium/', label: 'Dutch', mb: 77, lang: 'nl' },
  'pl_PL-gosia-medium': { path: 'pl/pl_PL/gosia/medium/', label: 'Polish', mb: 63, lang: 'pl' },
  'sv_SE-nst-medium': { path: 'sv/sv_SE/nst/medium/', label: 'Swedish', mb: 63, lang: 'sv' },
  'tr_TR-dfki-medium': { path: 'tr/tr_TR/dfki/medium/', label: 'Turkish', mb: 63, lang: 'tr' },
  'ru_RU-irina-medium': { path: 'ru/ru_RU/irina/medium/', label: 'Russian', mb: 63, lang: 'ru' },
  'uk_UA-ukrainian_tts-medium': { path: 'uk/uk_UA/ukrainian_tts/medium/', label: 'Ukrainian', mb: 77, lang: 'uk' },
  'zh_CN-huayan-medium': { path: 'zh/zh_CN/huayan/medium/', label: 'Chinese (Mandarin)', mb: 63, lang: 'zh' },
  'vi_VN-vais1000-medium': { path: 'vi/vi_VN/vais1000/medium/', label: 'Vietnamese', mb: 63, lang: 'vi' },
  'id_ID-news_tts-medium': { path: 'id/id_ID/news_tts/medium/', label: 'Indonesian', mb: 63, lang: 'id' },
  'hi_IN-pratham-medium': { path: 'hi/hi_IN/pratham/medium/', label: 'Hindi', mb: 64, lang: 'hi' },
  'ar_JO-kareem-medium': { path: 'ar/ar_JO/kareem/medium/', label: 'Arabic', mb: 63, lang: 'ar' },
};

/** The language a voice speaks (a two-letter code): a Piper voice's own, else English. */
export const voiceLanguage = (id) => (VOICES[id]?.lang) || (/^[a-z]{2}_[A-Z]{2}-/.test(String(id)) ? String(id).slice(0, 2) : 'en');
/** Voicebox's voices (its Qwen3 model) speak these languages; a Voicebox voice can be asked to speak any of them. */
export const VOICEBOX_LANGUAGES = ['en', 'zh', 'ja', 'ko', 'de', 'fr', 'ru', 'pt', 'es', 'it'];
/** A free voice for a language (Piper), or null when the kit has none: the first listed for it. */
export const voiceForLanguage = (lang) => Object.keys(VOICES).find((k) => voiceLanguage(k) === lang) || null;

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
      ...Object.entries(VOICES).map(([k, v]) => [k, { label: v.label, mb: v.mb, installed: hasVoice(k), ...(v.lang ? { lang: v.lang } : {}) }]),
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

/** Installs a Piper voice (and the program) when missing, and waits for it. */
export async function ensureVoice(id, onStep = () => {}) {
  if (!VOICES[id] || (program() && hasVoice(id))) return;
  startVoiceInstall({ voice: id });
  for (;;) {
    await new Promise((ok) => setTimeout(ok, 800));
    if (!install || install.voice !== id) continue;
    onStep(install.total ? `${install.step}: ${Math.round((install.done / install.total) * 100)}%` : install.step);
    if (install.state === 'error') throw new Error(install.error);
    if (install.state === 'done') return;
  }
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
const normW = (w) => String(w).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
function likeness(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

/**
 * The script's own words on the heard timing. A voice the kit spoke from a script says exactly the script, but speech
 * recognition can mishear it ("exceso" for "acceso", "frango work" for "framework", a brand name in another language):
 * captions and word pins should read the script. The heard words are aligned to the script's words (one to one, two
 * heard as one, one heard as two, a word not heard or heard extra), and each script word takes the time of what it
 * matched. Returns the heard words unchanged when they are too unlike the script to trust the alignment.
 */
export function wordsFromScript(words, lines) {
  const script = lines.join(' ').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  const n = script.length, m = words.length;
  if (!n || !m || n > 4000 || m > 4000) return words;
  const S = script.map(normW), H = words.map((w) => normW(w.w));
  const INF = 1e9;
  const cost = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(INF));
  const step = Array.from({ length: n + 1 }, () => new Int8Array(m + 1));
  cost[0][0] = 0;
  for (let i = 0; i <= n; i++) for (let j = 0; j <= m; j++) {
    const c = cost[i][j];
    if (c >= INF) continue;
    const go = (di, dj, k, add) => { if (i + di <= n && j + dj <= m && c + add < cost[i + di][j + dj]) { cost[i + di][j + dj] = c + add; step[i + di][j + dj] = k; } };
    if (i < n && j < m) go(1, 1, 1, 1 - likeness(S[i], H[j]));               // one script word, one heard word
    if (i < n && j + 1 < m) go(1, 2, 2, 1.1 - likeness(S[i], H[j] + H[j + 1])); // heard as two
    if (i + 1 < n && j < m) go(2, 1, 3, 1.1 - likeness(S[i] + S[i + 1], H[j])); // two heard as one
    if (i < n) go(1, 0, 4, 0.9);                                                // not heard
    if (j < m) go(0, 1, 5, 0.9);                                                // heard, not in the script
  }
  // Too unlike: the recognition is better than a forced alignment.
  if (cost[n][m] / n > 0.55) return words;
  const r = (x) => Math.round(x * 1000) / 1000;
  const out = [];
  let i = n, j = m;
  const back = [];
  while (i > 0 || j > 0) { const k = step[i][j]; back.push([k, i, j]); if (k === 1) { i--; j--; } else if (k === 2) { i--; j -= 2; } else if (k === 3) { i -= 2; j--; } else if (k === 4) i--; else j--; }
  back.reverse();
  let last = 0;
  for (const [k, ii, jj] of back) {
    if (k === 1) { const h = words[jj - 1]; out.push({ ...h, w: script[ii - 1] }); last = h.t + h.d; }
    else if (k === 2) { const a = words[jj - 2], b = words[jj - 1]; out.push({ ...a, w: script[ii - 1], d: r(b.t + b.d - a.t) }); last = b.t + b.d; }
    else if (k === 3) { const h = words[jj - 1]; const half = r(h.d / 2); out.push({ ...h, w: script[ii - 2], d: half }, { ...h, w: script[ii - 1], t: r(h.t + half), d: r(h.d - half), p: undefined }); last = h.t + h.d; }
    else if (k === 4) out.push({ w: script[ii - 1], t: r(last), d: 0.05 });
    // k === 5: a heard word the script does not have is left out.
  }
  return out.map((w) => { const x = { ...w }; if (x.p === undefined) delete x.p; return x; });
}

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
  // The language spoken: given (Voicebox can speak several), else the Piper voice's own, else English. It is also the
  // language the words are timed in.
  const language = typeof body.language === 'string' && /^[a-z]{2}$/.test(body.language) ? body.language : voicebox ? 'en' : voiceLanguage(id);
  if (kokoro && language !== 'en') throw Object.assign(new Error('The Kokoro voices speak English only: pick a voice for this language.'), { code: 400 });
  if (voicebox && !VOICEBOX_LANGUAGES.includes(language)) throw Object.assign(new Error(`Voicebox voices do not speak "${language}": pick a free voice for it.`), { code: 400 });
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
        const key = createHash('sha1').update(`${id}|${voicebox ? '' : pace}|${language === 'en' ? '' : language}|${lines[i]}`).digest('hex').slice(0, 16);
        const wav = join(cache, `${key}.wav`);
        if (!existsSync(wav)) {
          if (voicebox) {
            // Voicebox's own WAV, brought to one format so the lines and pauses join cleanly.
            const raw = join(dir, `line${i}.wav`);
            writeFileSync(raw, await voiceboxSpeak(voicebox, lines[i], { language, onWait: (s) => { job.step = `Speaking line ${i + 1} of ${lines.length} in Voicebox (${s} s${i === 0 && s > 20 ? '; the first line loads its model' : ''})`; } }));
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
      const tj = startTranscribe({ src, language });
      let words = [], speech = {};
      for (;;) {
        await new Promise((ok) => setTimeout(ok, 700));
        const info = transcribeJob(tj.id);
        if (!info) throw new Error('The word timing was lost.');
        if (info.state === 'error') throw new Error(info.error);
        if (info.state === 'done') { words = fitWordsToLines(wordsFromScript(info.result.words, lines), segments); speech = info.result.speech; break; }
      }
      job.result = { src, duration: Math.round(t * 1000) / 1000, segments, words, speech, voice: id, language };
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

