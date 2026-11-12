// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// What a screencast recording (studio-record.mjs: video.mp4 + actions.json) becomes besides the video itself:
//
//   narrate  the voice-over written from the recording: one line per step, timed to its action and short enough to be
//            said before the next one (about 2.5 words a second), written by the AI from the step labels, their
//            "about" notes and a frame of each step it looks at; in another language with --lang. Without an AI the
//            lines are the step labels. Writes narration.json for the person to read and change before anything is spoken.
//   voice    each narration line spoken on its own (the kit's voices), voice-checked, and listed in voice.json, the file
//            `screencast --voice` places on the timeline with its subtitles. A line that runs into the next step is
//            reported, never sped up.
//   guide    a written step-by-step guide from the same take: a numbered step per action with a screenshot of the
//            moment, the target ringed, as guide.md and a self-contained guide.html (help pages, the docs, a blog post).
//
//   node studio-cli.mjs narrate <recording folder> [--lang es] [--audience "…"] [--intro "…"] [--outro "…"]
//   node studio-cli.mjs voice <recording folder> [--voice kokoro:am_michael] [--file narration.json]
//   node studio-cli.mjs guide <recording folder> [--title "…"] [--file narration.json] [--accent #00B295]

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const WORDS_A_SECOND = 2.5; // a calm explainer pace
const r2 = (v) => Math.round(v * 100) / 100;
const ffmpeg = () => process.env.FFMPEG || 'ffmpeg';

function run(args) {
  return new Promise((ok, bad) => {
    const p = spawn(ffmpeg(), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', bad);
    p.on('exit', (c) => (c === 0 ? ok() : bad(new Error(`ffmpeg: ${err.trim().split('\n').pop()}`))));
  });
}

export function readRecording(dir) {
  const f = join(resolve(dir), 'actions.json');
  if (!existsSync(f)) throw new Error(`${f} was not found: record the steps first (studio-cli record).`);
  return JSON.parse(readFileSync(f, 'utf8'));
}

/**
 * The steps a viewer sees: each labelled action once, in order, with the window it has on screen (until the next
 * step). Tab clicks, Save and similar small actions join the step before them, as the screencast's captions do.
 */
export function recordingSteps(rec) {
  const skip = /^(Save|Saved|Published|Open its settings|Desktop|Tablet|Mobile|Content Elements|Components|Layout Elements|Media Elements|Interactive Elements)$/i;
  const steps = [];
  for (const a of rec.actions) {
    const last = steps[steps.length - 1];
    if (!a.label || skip.test(a.label) || (last && last.label === a.label)) { if (last) { last.end = Math.max(last.end, a.end); if (a.about && !last.about) last.about = a.about; } continue; }
    steps.push({ label: a.label, about: a.about || '', kind: a.kind, t: a.t, end: a.end, rect: a.rect || null, text: a.text || '' });
  }
  steps.forEach((s, i) => { s.until = i + 1 < steps.length ? steps[i + 1].t : rec.seconds; s.seconds = r2(s.until - s.t); });
  return steps;
}

/** The brand as a voice should say it ("Unyson+" is read wrongly); the subtitle keeps the written form. */
export const spoken = (text) => String(text).replace(/Unyson\s*\+|Unyson\s+Plus|UnysonPlus/gi, 'Unisonplus');

/** A frame of the video at `t` as a JPEG, `width` wide, optionally with `rect` (video pixels) ringed. */
export async function frameAt(rec, dir, t, file, { width = 1280, rect = null, accent = '#00B295' } = {}) {
  const k = width / rec.width;
  const ring = rect ? `,drawbox=x=${Math.round((rect.x - 10) * k)}:y=${Math.round((rect.y - 10) * k)}:w=${Math.round((rect.w + 20) * k)}:h=${Math.round((rect.h + 20) * k)}:color=${accent.replace('#', '0x')}@0.95:t=${Math.max(3, Math.round(6 * k * 2))}` : '';
  // Seeking into the last fraction of a second can return no frame at all (and no error): stay half a second clear.
  await run(['-v', 'error', '-y', '-ss', String(Math.max(0, Math.min(t, rec.seconds - 0.5))), '-i', join(resolve(dir), rec.video), '-frames:v', '1', '-vf', `scale=${width}:-2${ring}`, '-q:v', '3', file]);
  if (!existsSync(file)) throw new Error(`No frame could be taken at ${t} s of ${rec.video}.`);
  return file;
}

/** Where a step's picture is taken: once it has happened (the typing done, the panel open), still before the next one. */
const shotTime = (s) => Math.min(s.end + 0.4, s.until - 0.1);

/**
 * Writes the narration: { lang, lines: [{ step, at, text, say, budget }] } into narration.json (or opts.out).
 * `at` is seconds in the recording ("intro" for a line before it); `say` is the text the voice reads.
 */
export async function narrate(dir, opts = {}) {
  const rec = readRecording(dir);
  const steps = recordingSteps(rec);
  if (!steps.length) throw new Error('The recording has no labelled steps to narrate: give the steps a "label".');
  const lang = opts.lang || 'en';
  const budget = (s) => Math.max(3, Math.floor((s.seconds - 0.4) * WORDS_A_SECOND));
  const framesDir = join(resolve(dir), 'narrate-frames');
  let lines = null, by = 'labels', looked = false;
  const { aiReady, askWithImages, extractJson } = await import('./to-ai.mjs');
  if (aiReady() && opts.ai !== false) {
    mkdirSync(framesDir, { recursive: true });
    const images = [];
    for (const [i, s] of steps.entries()) images.push(await frameAt(rec, dir, shotTime(s), join(framesDir, `step-${String(i + 1).padStart(2, '0')}.jpg`), { width: 1024, rect: s.rect }));
    const system = `You write the voice-over of a screen-recorded tutorial. Each step below is something done on screen, with how long it stays on screen.
Write ONE spoken line per step that tells the viewer what is happening and why it matters, in plain, friendly words, as a person showing a friend.
Rules: say only what the step and its picture show (never claim a result that is not on screen); no "click here" without saying what it is; keep each line at or under its word budget (it must be said before the next step); vary the openings; no marketing superlatives; write the brand as it is written in the labels.
${lang !== 'en' ? `Write the lines in the language with the code "${lang}".` : 'Write in English.'}
Answer with JSON only: { "lines": [ { "step": 1, "text": "…" } ] }${opts.intro ? ', plus "intro": "…" (a line before the first step, at most 12 words)' : ''}.`;
    const user = `${opts.audience ? `The viewers: ${opts.audience}\n` : ''}${opts.context ? `About the video: ${opts.context}\n` : ''}${opts.intro ? `The intro should say, in your words: ${opts.intro}\n` : ''}
The images step-01.jpg, step-02.jpg… show each step's moment (its target is ringed in green).
STEPS
${steps.map((s, i) => `${i + 1}. "${s.label}"${s.about ? ` (about: ${s.about})` : ''}${s.text ? ` (types: "${s.text}")` : ''}: on screen ${s.seconds} s, word budget ${budget(s)}`).join('\n')}`;
    try {
      const r = await askWithImages({ system, user, images, maxTokens: 4000 });
      looked = r.looked;
      const j = extractJson(r.text);
      if (j && Array.isArray(j.lines)) {
        lines = steps.map((s, i) => ({ text: String((j.lines.find((l) => Number(l.step) === i + 1) || {}).text || s.label).trim() }));
        if (j.intro) lines.intro = String(j.intro).trim();
        by = 'ai';
        // One more pass for the lines over their budget: a long line runs into the next step, and the voice is never
        // sped up to fit.
        const over = steps.map((s, i) => ({ i, s, words: lines[i].text.split(/\s+/).filter(Boolean).length })).filter((x) => x.words > budget(x.s));
        if (over.length) {
          const { askText } = await import('./to-ai.mjs');
          const again = extractJson(await askText({ system: `Shorten each voice-over line to at most its word budget, keeping what it says and its language. Answer with JSON only: { "lines": [ { "step": 1, "text": "…" } ] }.`,
            user: over.map((x) => `${x.i + 1}. (budget ${budget(x.s)} words) ${lines[x.i].text}`).join('\n'), maxTokens: 2000 }).catch(() => ''));
          for (const l of (again && Array.isArray(again.lines) ? again.lines : [])) {
            const k = Number(l.step) - 1;
            if (lines[k] && l.text) lines[k].text = String(l.text).trim();
          }
        }
      }
    } catch (e) {
      by = `labels (the AI failed: ${String(e.message || e).slice(0, 160)})`;
    } finally {
      rmSync(framesDir, { recursive: true, force: true });
    }
  }
  if (!lines) lines = steps.map((s) => ({ text: s.about || s.label }));
  const out = [];
  if (lines.intro || (opts.intro && by !== 'ai')) { const text = lines.intro || opts.intro; out.push({ step: 0, at: 'intro', text, say: spoken(text) }); }
  steps.forEach((s, i) => {
    const text = lines[i].text;
    const words = text.split(/\s+/).filter(Boolean).length;
    out.push({ step: i + 1, label: s.label, at: r2(Math.max(0, s.t - 0.2)), until: r2(s.until), text, say: spoken(text), words, budget: budget(s), ...(words > budget(s) ? { long: true } : {}) });
  });
  if (opts.outro) out.push({ step: steps.length + 1, at: 'end', text: opts.outro, say: spoken(opts.outro) });
  const result = { lang, by, looked, recording: rec.video, lines: out };
  const file = resolve(dir, opts.out || (lang === 'en' ? 'narration.json' : `narration.${lang}.json`));
  writeFileSync(file, JSON.stringify(result, null, 1));
  return { file, ...result, long: out.filter((l) => l.long).length };
}

/** Speaks one line through the running kit; returns the MP3 bytes. */
async function speak(kit, text, voice) {
  const start = await fetch(`${kit}/studio/voice`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines: [text], ...(voice ? { voice } : {}) }) }).catch(() => null);
  if (!start || !start.ok) throw new Error(start ? `The kit refused the voice: ${(await start.text()).slice(0, 200)}` : 'The kit is not answering: start it first.');
  const { id } = await start.json();
  for (;;) {
    await new Promise((ok) => setTimeout(ok, 1200));
    const job = await (await fetch(`${kit}/studio/voice/${id}`)).json();
    if (job.state === 'done') return { mp3: Buffer.from(job.result.src.slice(job.result.src.indexOf(',') + 1), 'base64'), seconds: job.result.duration };
    if (job.state === 'error' || job.state === 'failed') throw new Error(job.error || 'The line could not be spoken.');
  }
}

/**
 * Speaks every narration line on its own into voice/line-NN.mp3, checks each against its text, and writes voice.json
 * ([{ at, file, seconds, text }]) for `screencast --voice`. Lines that run past the next step are listed in `overruns`.
 */
export async function voiceNarration(dir, opts = {}) {
  const kit = opts.kit || 'http://127.0.0.1:8787';
  const nf = resolve(dir, opts.file || 'narration.json');
  if (!existsSync(nf)) throw new Error(`${nf} was not found: run narrate first (and read it through).`);
  const n = JSON.parse(readFileSync(nf, 'utf8'));
  const vdir = join(resolve(dir), 'voice');
  mkdirSync(vdir, { recursive: true });
  const { voiceCheck } = await import('./studio-tools.mjs');
  const out = [], checks = [], overruns = [];
  const rec = readRecording(dir);
  for (const [i, l] of n.lines.entries()) {
    if (opts.onStep) opts.onStep(`Line ${i + 1} of ${n.lines.length}`);
    const name = `line-${String(i + 1).padStart(2, '0')}.mp3`;
    const { mp3, seconds } = await speak(kit, l.say || spoken(l.text), opts.voice);
    writeFileSync(join(vdir, name), mp3);
    let check = null;
    if (opts.check !== false && (n.lang || 'en') === 'en') {
      try { const c = await voiceCheck(join(vdir, name), l.say || l.text); check = { ok: c.ok, problems: c.problems.map((p) => p.text) }; } catch { check = null; }
    }
    checks.push({ line: i + 1, text: l.text, ...(check || { ok: null }) });
    const at = l.at === 'end' ? rec.seconds : l.at;
    out.push({ at, file: `voice/${name}`, seconds: r2(seconds), text: l.text });
    // A line runs until the next one; the last step's line until the end card (`screencast` gives it 3 s); the end
    // card's own line is not limited here: the end card is made as long as it needs.
    const next = n.lines[i + 1];
    const nextAt = l.at === 'end' ? null : next && typeof next.at === 'number' ? next.at : (l.at === 'intro' ? null : rec.seconds + 3);
    if (typeof at === 'number' && nextAt != null && at + seconds > nextAt + 0.05) overruns.push({ line: i + 1, text: l.text, over: r2(at + seconds - nextAt) });
  }
  const file = join(resolve(dir), opts.out || 'voice.json');
  writeFileSync(file, JSON.stringify(out, null, 1));
  return { file, lines: out.length, checks, failed: checks.filter((c) => c.ok === false).length, overruns };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The step-by-step guide: guide/guide.md + guide/guide.html + guide/step-NN.jpg. */
export async function writeGuide(dir, opts = {}) {
  const rec = readRecording(dir);
  const steps = recordingSteps(rec);
  if (!steps.length) throw new Error('The recording has no labelled steps: give the steps a "label".');
  const nf = resolve(dir, opts.file || 'narration.json');
  const nar = existsSync(nf) ? JSON.parse(readFileSync(nf, 'utf8')) : null;
  const gdir = join(resolve(dir), opts.out || 'guide');
  mkdirSync(gdir, { recursive: true });
  const accent = opts.accent || '#00B295';
  const title = opts.title || 'Step by step';
  const items = [];
  for (const [i, s] of steps.entries()) {
    const img = `step-${String(i + 1).padStart(2, '0')}.jpg`;
    await frameAt(rec, dir, shotTime(s), join(gdir, img), { width: opts.width || 1600, rect: s.rect, accent });
    const line = nar ? (nar.lines.find((l) => l.step === i + 1) || {}).text : '';
    items.push({ n: i + 1, label: s.label, text: line || s.about || '', typed: s.text, img });
  }
  const intro = nar ? (nar.lines.find((l) => l.at === 'intro') || {}).text : '';
  const md = [`# ${title}`, '', ...(intro ? [intro, ''] : []),
    ...items.flatMap((it) => [`## ${it.n}. ${it.label}`, '', ...(it.text ? [it.text, ''] : []), ...(it.typed ? [`Type: \`${it.typed}\``, ''] : []), `![Step ${it.n}: ${it.label}](${it.img})`, ''])].join('\n');
  writeFileSync(join(gdir, 'guide.md'), md);
  const html = `<!doctype html>
<html lang="${esc(nar?.lang || 'en')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--accent:${accent};--ink:#1c1e22;--muted:#5f6266;--line:#e4e7ea;--bg:#fff}
@media (prefers-color-scheme:dark){:root{--ink:#eceef0;--muted:#a3a7ab;--line:#2b2f33;--bg:#141618}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:40px 16px 80px}h1{font-size:2rem;line-height:1.2;margin:0 0 12px}
.intro{color:var(--muted);margin:0 0 32px}ol{list-style:none;margin:0;padding:0;counter-reset:s}
li{counter-increment:s;border-top:1px solid var(--line);padding:28px 0}
h2{display:flex;gap:12px;align-items:baseline;font-size:1.25rem;margin:0 0 8px}
h2::before{content:counter(s);flex:none;display:inline-grid;place-items:center;width:30px;height:30px;border-radius:50%;background:var(--accent);color:#fff;font-size:.9rem}
p{margin:0 0 14px}code{background:color-mix(in srgb,var(--accent) 12%,transparent);padding:1px 6px;border-radius:4px}
img{display:block;width:100%;height:auto;border:1px solid var(--line);border-radius:8px}
</style></head><body><main>
<h1>${esc(title)}</h1>${intro ? `\n<p class="intro">${esc(intro)}</p>` : ''}
<ol>
${items.map((it) => `<li><h2>${esc(it.label)}</h2>${it.text ? `<p>${esc(it.text)}</p>` : ''}${it.typed ? `<p>Type <code>${esc(it.typed)}</code></p>` : ''}<img src="${it.img}" alt="Step ${it.n}: ${esc(it.label)}" loading="lazy"></li>`).join('\n')}
</ol></main></body></html>
`;
  writeFileSync(join(gdir, 'guide.html'), html);
  return { dir: gdir, steps: items.length, markdown: join(gdir, 'guide.md'), html: join(gdir, 'guide.html'), narrated: !!nar };
}
