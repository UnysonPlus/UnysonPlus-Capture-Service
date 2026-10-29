// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// "Check this computer": everything Kinetic Scenes uses on this machine, in one report ready to paste into a bug report.
// The kit and Node versions, the operating system, ffmpeg and ffprobe, the browser the kit renders with, the graphics
// card and its free memory, the AI the kit is connected to, Blender, the workspace folder and its free disk space, and
// every add-on with its state and where it is. Nothing is sent anywhere; nothing personal beyond paths is included.

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { arch, cpus, platform, release, totalmem } from 'node:os';

const sh = (cmd, args, timeout = 8000) => new Promise((ok) => {
  execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => ok(err ? null : String(stdout || stderr)));
});
const first = (s) => (s ? s.split('\n').find((l) => l.trim()) || '' : '');
const gb = (b) => `${(b / 1024 ** 3).toFixed(1)} GB`;

async function graphics() {
  const smi = await sh('nvidia-smi', ['--query-gpu=name,memory.total,memory.free,driver_version', '--format=csv,noheader,nounits']);
  if (smi) {
    return first(smi).split(',').map((x) => x.trim()).reduce((o, v, i) => ({ ...o, [['name', 'totalMb', 'freeMb', 'driver'][i]]: i === 1 || i === 2 ? Number(v) : v }), { vendor: 'NVIDIA' });
  }
  if (platform() === 'win32') {
    const ps = await sh('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController | Select-Object -First 1 -ExpandProperty Name)']);
    if (ps) return { name: first(ps).trim() };
  }
  if (platform() === 'darwin') {
    const sp = await sh('system_profiler', ['SPDisplaysDataType']);
    const m = sp && sp.match(/Chipset Model: (.+)/);
    if (m) return { name: m[1].trim() };
  }
  return { name: 'unknown (no NVIDIA tools found)' };
}

async function renderBrowser() {
  try {
    const { chromium } = await import('playwright-core');
    for (const channel of ['chrome', 'msedge', undefined]) {
      try {
        const b = await chromium.launch({ channel, headless: true });
        const v = b.version();
        await b.close();
        return { ok: true, name: channel === 'chrome' ? 'Google Chrome' : channel === 'msedge' ? 'Microsoft Edge' : 'Chromium (Playwright)', version: v };
      } catch { /* try the next */ }
    }
  } catch { /* playwright-core missing */ }
  return { ok: false, name: 'none found', note: 'Video rendering and stills need Chrome, Edge or Playwright\'s Chromium.' };
}

/** The report as data. */
export async function checkComputer() {
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  let kit = null;
  try { kit = JSON.parse(readFileSync(new URL('../../../../kit-manifest.json', import.meta.url), 'utf8')).kit_version; } catch { /* not inside the kit */ }
  const [ffmpeg, ffprobe, gpu, browser] = await Promise.all([
    sh(process.env.FFMPEG || 'ffmpeg', ['-version']), sh(process.env.FFPROBE || 'ffprobe', ['-version']), graphics(), renderBrowser(),
  ]);
  let ai = { backend: null };
  try { const t = await import('./to-ai.mjs'); ai = { backend: t.aiBackend() || null }; } catch { /* AI module unavailable */ }
  let blender = null;
  try {
    const exe = (await import('./studio-blender.mjs')).findBlender();
    const v = await sh(exe, ['--version'], 20000);
    blender = v ? { path: exe, version: first(v).trim() } : null;
  } catch { /* none */ }
  let workspace = null;
  try {
    const root = (await import('./studio-workspace.mjs')).workspaceRoot();
    let free = null;
    try { const s = statfsSync(root); free = s.bavail * s.bsize; } catch { /* unknown */ }
    workspace = { path: root, exists: existsSync(root), free };
  } catch { /* none */ }
  let addons = [];
  try {
    addons = (await (await import('./studio-addons.mjs')).listAddons()).map((a) => ({
      id: a.id, name: a.name, state: a.state,
      where: a.location?.value || a.app?.value || a.folder || null,
    }));
  } catch (e) { addons = [{ id: 'error', name: 'Add-ons could not be listed', state: String(e.message || e) }]; }
  return {
    date: new Date().toISOString(),
    kit: { kit, captureService: pkg.version, node: process.version },
    system: { os: `${platform()} ${release()} (${arch()})`, cpu: `${cpus()[0]?.model?.trim() || 'unknown'} x${cpus().length}`, memory: gb(totalmem()) },
    ffmpeg: ffmpeg ? first(ffmpeg).replace(/ Copyright.*/, '').trim() : null,
    ffprobe: ffprobe ? first(ffprobe).replace(/ Copyright.*/, '').trim() : null,
    browser, gpu, ai, blender, workspace, addons,
  };
}

/** The same report as plain text, ready to paste into a bug report. */
export function doctorText(r) {
  const ok = (v) => (v ? 'yes' : 'NO');
  const lines = [
    `Kinetic Scenes / AI Dev Kit: computer check (${r.date.slice(0, 16).replace('T', ' ')} UTC)`,
    '',
    `Kit ${r.kit.kit ?? '(not inside the kit)'}, capture service ${r.kit.captureService}, Node ${r.kit.node}`,
    `System: ${r.system.os}, ${r.system.cpu}, ${r.system.memory} memory`,
    `ffmpeg: ${r.ffmpeg ?? 'NOT FOUND (needed for video, audio and previews)'}`,
    `ffprobe: ${r.ffprobe ?? 'NOT FOUND'}`,
    `Rendering browser: ${r.browser.ok ? `${r.browser.name} ${r.browser.version}` : `NONE: ${r.browser.note}`}`,
    `Graphics: ${r.gpu.name}${r.gpu.totalMb ? `, ${r.gpu.freeMb} MB free of ${r.gpu.totalMb} MB (driver ${r.gpu.driver})` : ''}`,
    `AI: ${r.ai.backend ? `connected (${r.ai.backend})` : 'off (connect Claude or a local model for AI assist)'}`,
    `Blender: ${r.blender ? `${r.blender.version} at ${r.blender.path}` : 'not found (only needed for blender_model / blender_render)'}`,
    `Workspace: ${r.workspace ? `${r.workspace.path} (exists: ${ok(r.workspace.exists)}${r.workspace.free != null ? `, ${(r.workspace.free / 1024 ** 3).toFixed(1)} GB free` : ''})` : 'unknown'}`,
    '',
    'Add-ons:',
    ...r.addons.map((a) => `  - ${a.name}: ${a.state}${a.where ? ` (${a.where})` : ''}`),
  ];
  return lines.join('\n');
}
