// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// FFmpeg for Kinetic Scenes: the free tool the kit uses for video, audio and previews. It isn't bundled, so when it
// isn't on this computer the kit says so at the moment it is needed, with a direct link, and can install it itself:
// a checksummed download into the kit's own folder (assembled/ffmpeg, or ~/.unysonplus/ffmpeg), so no administrator
// rights and nothing changed on the system; on macOS, through Homebrew when it is there.
//
// Importing this file makes a copy the kit installed earlier usable: it sets FFMPEG and FFPROBE (unless the person set
// them) and puts the folder first on PATH, which also covers everything that runs plain "ffmpeg". Import it first.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXE = process.platform === 'win32' ? '.exe' : '';

/** FFmpeg's own download page, for anyone who prefers to install it themselves. */
export const FFMPEG_LINK = 'https://ffmpeg.org/download.html';

const BTBN = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/';
const GYAN = 'https://www.gyan.dev/ffmpeg/builds/';
/** The builds the kit downloads. sum: where its SHA-256 is published; the download is refused when it doesn't match. */
const BUILDS = {
  // The same stable build from GitHub, far faster than its publisher's own server, which stays as the fallback.
  'win32-x64': { github: 'GyanD/codexffmpeg', asset: /-essentials_build\.zip$/, url: `${GYAN}ffmpeg-release-essentials.zip`, sum: `${GYAN}ffmpeg-release-essentials.zip.sha256`, mb: 110 },
  'win32-arm64': { url: `${BTBN}ffmpeg-master-latest-winarm64-gpl.zip`, sum: `${BTBN}checksums.sha256`, mb: 136 },
  'linux-x64': { url: `${BTBN}ffmpeg-master-latest-linux64-gpl.tar.xz`, sum: `${BTBN}checksums.sha256`, mb: 150 },
  'linux-arm64': { url: `${BTBN}ffmpeg-master-latest-linuxarm64-gpl.tar.xz`, sum: `${BTBN}checksums.sha256`, mb: 127 },
};
const build = () => BUILDS[`${process.platform}-${process.arch}`] ?? null;

function ffmpegDir() {
  if (process.env.KIT_FFMPEG_DIR) return resolve(process.env.KIT_FFMPEG_DIR);
  const assembled = resolve(HERE, '../../..');
  return basename(assembled) === 'assembled' ? join(assembled, 'ffmpeg') : join(homedir(), '.unysonplus', 'ffmpeg');
}
const binDir = () => join(ffmpegDir(), 'bin');
const kitHasIt = () => existsSync(join(binDir(), `ffmpeg${EXE}`)) && existsSync(join(binDir(), `ffprobe${EXE}`));

/** Makes the kit's own copy the one everything finds. */
function useKitCopy() {
  if (!kitHasIt()) return false;
  const bin = binDir();
  process.env.FFMPEG ||= join(bin, `ffmpeg${EXE}`);
  process.env.FFPROBE ||= join(bin, `ffprobe${EXE}`);
  if (!(process.env.PATH || '').split(delimiter).includes(bin)) process.env.PATH = `${bin}${delimiter}${process.env.PATH || ''}`;
  return true;
}
useKitCopy();

const runs = (bin) => {
  const r = spawnSync(bin, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  return r.status === 0 ? String(r.stdout).split('\n')[0].replace(/ Copyright.*/, '').trim() : '';
};
const ffmpegBin = () => process.env.FFMPEG || 'ffmpeg';
const ffprobeBin = () => process.env.FFPROBE || 'ffprobe';

/** Whether both programs run here. Asked again each time, so one installed meanwhile counts at once. */
export const hasFfmpeg = () => !!(runs(ffmpegBin()) && runs(ffprobeBin()));

const hasBrew = () => process.platform === 'darwin' && spawnSync('brew', ['--version'], { windowsHide: true, timeout: 10000 }).status === 0;

/** How the kit can install it here: a download, Homebrew, or not at all (then the link is the way). */
function installer() {
  if (build()) return 'download';
  return hasBrew() ? 'brew' : null;
}

/** What to tell someone, in one sentence, when FFmpeg is missing. */
function howToGetIt() {
  const by = installer();
  const size = by === 'download' ? ` (about ${build().mb} MB)` : '';
  const self = process.platform === 'darwin' && by !== 'brew' ? `Install it with Homebrew (brew install ffmpeg) or get it from ${FFMPEG_LINK}, then restart the kit.`
    : `Or get it yourself: ${FFMPEG_LINK}.`;
  return by ? `The kit can install it for you${size}: open Add-ons in Kinetic Scenes and click Install FFmpeg, or run "node studio-cli.mjs ffmpeg install". ${self}` : self;
}

/** The message for anything that needs FFmpeg when it isn't here. */
export const ffmpegNeeded = (what = 'This') => `${what} needs FFmpeg, a free video tool that isn't on this computer yet. ${howToGetIt()}`;

/** Stops with that message when FFmpeg isn't here. */
export function requireFfmpeg(what) {
  if (hasFfmpeg()) return;
  const e = new Error(ffmpegNeeded(what));
  e.needs = 'ffmpeg';
  throw e;
}

let install = null;

export function ffmpegStatus() {
  const version = runs(ffmpegBin());
  const probe = runs(ffprobeBin());
  const by = installer();
  return {
    ffmpeg: !!version, ffprobe: !!probe, version: version || null,
    source: !version ? null : kitHasIt() && process.env.FFMPEG?.startsWith(binDir()) ? 'kit' : 'system',
    canInstall: !!by, by, mb: by === 'download' ? build().mb : null, link: FFMPEG_LINK, message: version && probe ? '' : ffmpegNeeded(), install,
  };
}

async function download(url, dest, onBytes) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`The download answered ${r.status}.`);
  const total = Number(r.headers.get('content-length')) || 0;
  const hash = createHash('sha256');
  const out = createWriteStream(dest);
  let done = 0;
  for await (const chunk of r.body) {
    hash.update(chunk);
    done += chunk.length;
    onBytes(done, total);
    if (!out.write(chunk)) await once(out, 'drain');
  }
  out.end();
  await once(out, 'finish');
  return hash.digest('hex');
}

/** The published SHA-256 of one file: alone in the file, or on its own line beside the name. */
async function publishedSum(url, file) {
  const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`The checksum answered ${r.status}.`);
  const lines = (await r.text()).trim().split(/\r?\n/);
  const line = lines.length === 1 ? lines[0] : lines.find((l) => l.includes(file));
  const sum = /\b[0-9a-f]{64}\b/i.exec(line || '')?.[0];
  if (!sum) throw new Error('The checksum could not be read.');
  return sum.toLowerCase();
}

function extract(archive, dest) {
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  return new Promise((ok, bad) => {
    const p = spawn(tar, ['-xf', archive, '-C', dest], { windowsHide: true, stdio: 'ignore' });
    p.on('error', bad);
    p.on('exit', (c) => (c === 0 ? ok() : bad(new Error(`Could not unpack ${basename(archive)} (tar exited ${c}).`))));
  });
}

/** A file by name anywhere under a folder. */
function findFile(dir, name) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) { const f = findFile(p, name); if (f) return f; }
  }
  return null;
}

/** A build published as a GitHub release: its newest file and the SHA-256 GitHub lists for it; otherwise the fallback. */
async function fromGithub(spec) {
  if (!spec.github) return spec;
  try {
    const r = await fetch(`https://api.github.com/repos/${spec.github}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'unysonplus-kit' }, signal: AbortSignal.timeout(20000) });
    const asset = r.ok ? (await r.json()).assets?.find((a) => spec.asset.test(a.name)) : null;
    const sha = /^sha256:([0-9a-f]{64})$/i.exec(asset?.digest || '')?.[1];
    if (sha) return { url: asset.browser_download_url, sha: sha.toLowerCase() };
  } catch { /* the fallback below */ }
  return spec;
}

async function downloadAndInstall(chosen, state) {
  const dir = ffmpegDir();
  state.step = 'Checking the download';
  const spec = await fromGithub(chosen);
  const file = basename(new URL(spec.url).pathname);
  const archive = join(dir, file);
  const unpacked = join(dir, 'unpacked');
  rmSync(unpacked, { recursive: true, force: true });
  mkdirSync(unpacked, { recursive: true });
  mkdirSync(binDir(), { recursive: true });
  try {
    const expected = spec.sha ?? await publishedSum(spec.sum, file);
    state.step = 'Downloading FFmpeg';
    const got = await download(spec.url, archive, (d, t) => { state.done = d; state.total = t; });
    if (got !== expected) throw new Error('The download did not match its published checksum, so it was not installed. Try again.');
    state.step = 'Unpacking';
    await extract(archive, unpacked);
    for (const name of [`ffmpeg${EXE}`, `ffprobe${EXE}`]) {
      const from = findFile(unpacked, name);
      if (!from) throw new Error(`${name} was not in the download.`);
      copyFileSync(from, join(binDir(), name));
      if (!EXE) chmodSync(join(binDir(), name), 0o755);
    }
  } finally {
    rmSync(unpacked, { recursive: true, force: true });
    rmSync(archive, { force: true });
  }
  useKitCopy();
}

function brewInstall(state) {
  state.step = 'Installing with Homebrew';
  return new Promise((ok, bad) => {
    const p = spawn('brew', ['install', 'ffmpeg'], { stdio: 'ignore' });
    p.on('error', bad);
    p.on('exit', (c) => (c === 0 ? ok() : bad(new Error(`Homebrew stopped (exit ${c}). Run "brew install ffmpeg" yourself to see why.`))));
  });
}

/** Installs FFmpeg in the background; follow it through ffmpegStatus().install. */
export function startFfmpegInstall() {
  if (install?.state === 'running') return install;
  const by = installer();
  if (!by) throw new Error(`The kit can't install FFmpeg on this computer. Get it from ${FFMPEG_LINK}.`);
  const state = { state: 'running', step: 'Starting', done: 0, total: 0, error: '' };
  install = state;
  (by === 'download' ? downloadAndInstall(build(), state) : brewInstall(state))
    .then(() => {
      if (!runs(ffmpegBin()) || !runs(ffprobeBin())) throw new Error('FFmpeg was installed but does not run on this computer.');
      state.state = 'done';
      state.step = 'Installed';
    })
    .catch((e) => { state.state = 'error'; state.error = e.message; });
  return state;
}

/** The same, for the command line and agents: waits until it has finished. */
export async function installFfmpeg(onStep = () => {}) {
  const state = startFfmpegInstall();
  let last = '';
  while (state.state === 'running') {
    const line = state.total ? `${state.step}: ${Math.round((state.done / state.total) * 100)}%` : state.step;
    const tens = line.replace(/\d%$/, '0%');
    if (tens !== last) { last = tens; onStep(tens); }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (state.state === 'error') throw new Error(state.error);
  return ffmpegStatus();
}
