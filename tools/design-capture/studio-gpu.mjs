// One AI app on the graphics card at a time. Add-ons the kit opened itself (Voicebox, ACE-Step) register here; before
// one starts working, the kit closes the others it opened (never an app the person opened) and waits for the card's
// memory to come back, so a 6 GB card is not asked to hold two models at once.

import { execFile, execFileSync } from 'node:child_process';

const apps = new Map(); // name → { owned(): boolean, busy(): boolean, stop(): Promise }

export function registerGpuApp(name, hooks) { apps.set(name, hooks); }

/** Graphics memory in use (MB), or null when it cannot be read (no NVIDIA card). */
export function gpuUsedMb() {
  try { return Number(execFileSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0]) || null; } catch { return null; }
}

/** Closes the other kit-opened apps before `name` uses the card. Waits for one still working to finish first. */
export async function claimGpu(name, onStep = () => {}) {
  const others = [...apps].filter(([n, h]) => n !== name && h.owned());
  if (!others.length) return;
  for (const [n, h] of others) {
    for (let i = 0; h.busy() && i < 600; i++) { if (i === 0) onStep(`Waiting for ${n} to finish`); await new Promise((ok) => setTimeout(ok, 1000)); }
    onStep(`Closing ${n} to free the graphics card`);
    await h.stop();
  }
  // The driver takes a moment to hand the memory back.
  const before = gpuUsedMb();
  for (let i = 0; before != null && i < 15; i++) {
    await new Promise((ok) => setTimeout(ok, 1000));
    const now = gpuUsedMb();
    if (now == null || now < 1200) break;
  }
}

/** Stops a process and everything it started. */
export const killTree = (pid) => new Promise((ok) => {
  if (process.platform !== 'win32') { try { process.kill(pid); } catch {} return ok(); }
  execFile('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true }, () => ok());
});

/** The process listening on a TCP port on this computer (Windows), or null. */
export function listenerPid(port) {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
    const m = out.split(/\r?\n/).find((l) => new RegExp(`:${port}\\s.*LISTENING`).test(l));
    return m ? Number(m.trim().split(/\s+/).pop()) || null : null;
  } catch { return null; }
}
