// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Kokoro voices: a second set of built-in voices, more natural than Piper's, from Kokoro-82M (Apache-2.0), run on the
// computer's processor by kokoro-js (Apache-2.0) inside Node: no Python, no graphics card, nothing uploaded.
// Installed once, on request, into its own folder beside the other voices (<voices>/kokoro, with its own package.json,
// so npm never touches anything else); the model (about 90 MB, 8-bit) is cached in that folder too.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const PACKAGE = 'kokoro-js@1.2.1';

/** The voices offered (Kokoro has more; these are the clearest English ones). Ids are "kokoro:<voice>". */
export const KOKORO_VOICES = {
  'kokoro:af_heart': { label: 'Natural, warm (American English, female)' },
  'kokoro:af_bella': { label: 'Natural, bright (American English, female)' },
  'kokoro:am_michael': { label: 'Natural, steady (American English, male)' },
  'kokoro:am_fenrir': { label: 'Natural, deep (American English, male)' },
  'kokoro:bf_emma': { label: 'Natural, clear (British English, female)' },
  'kokoro:bm_george': { label: 'Natural, calm (British English, male)' },
};
export const KOKORO_MB = 500; // on disk: the program (about 410 MB) and the 8-bit model (about 90 MB)

export const kokoroDir = (voicesDir) => join(voicesDir, 'kokoro');
const entry = (dir) => join(dir, 'node_modules', 'kokoro-js', 'dist', 'kokoro.js');
const cacheDir = (dir) => join(dir, 'models');
/** Installed: the package and its downloaded model are both there. */
export function kokoroInstalled(voicesDir) {
  const dir = kokoroDir(voicesDir);
  return existsSync(entry(dir)) && existsSync(cacheDir(dir)) && readdirSync(cacheDir(dir)).length > 0;
}

function npm(args, cwd) {
  return new Promise((ok, bad) => {
    const p = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-3000); });
    p.on('error', bad);
    p.on('exit', (c) => (c === 0 ? ok() : bad(new Error(`npm failed (${c}): ${err.trim().split('\n').slice(-2).join(' ')}`))));
  });
}

let tts = null;
let loading = null;
/** The engine, loaded once per kit run (about 6 s the first time). */
async function engine(voicesDir) {
  if (tts) return tts;
  if (!loading) {
    loading = (async () => {
      const dir = kokoroDir(voicesDir);
      const tf = await import(pathToFileURL(join(dir, 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.mjs')).href).catch(() => null);
      if (tf?.env) { tf.env.cacheDir = cacheDir(dir); tf.env.allowRemoteModels = true; }
      const { KokoroTTS } = await import(pathToFileURL(entry(dir)).href);
      tts = await KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype: 'q8', device: 'cpu', cache_dir: cacheDir(dir) });
      return tts;
    })().finally(() => { loading = null; });
  }
  return loading;
}

/** Installs kokoro-js into its own folder and downloads the model (by loading it once). */
export async function installKokoro(voicesDir, onStep = () => {}) {
  const dir = kokoroDir(voicesDir);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, 'package.json'))) writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'upw-kokoro', private: true, description: 'Kokoro voices for the Unyson+ AI Dev Kit' }, null, 2));
  if (!existsSync(entry(dir))) {
    onStep('Installing the Kokoro voice program');
    await npm(['install', '--no-audit', '--no-fund', '--omit=dev', PACKAGE], dir);
  }
  onStep(`Downloading the Kokoro voices (about 90 MB)`);
  mkdirSync(cacheDir(dir), { recursive: true });
  await engine(voicesDir);
}

/** Speaks one line into a WAV (24 kHz mono). speed: 1 is Kokoro's own pace; lower is slower. */
export async function kokoroSpeak(voicesDir, voiceId, text, wav, speed = 0.95) {
  const t = await engine(voicesDir);
  const voice = voiceId.replace(/^kokoro:/, '');
  const audio = await t.generate(text, { voice, speed });
  await audio.save(wav);
}
