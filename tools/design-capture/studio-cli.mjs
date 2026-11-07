#!/usr/bin/env node
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Kinetic Scenes from the command line: check, outline, frames, video and audio analysis for a scene file,
// so an agent (or a person) can work on scenes without the Studio open. See studio-tools.mjs.
//
//   node studio-cli.mjs check <scene.json>
//   node studio-cli.mjs inspect <scene.json>
//   node studio-cli.mjs stills <scene.json> [--times 1.2,3.5] [--out folder] [--width 1280]
//   node studio-cli.mjs render <scene.json> [--out video.mp4] [--width 1920 --height 1080] [--fps 30] [--format mp4|webm|mov]
//                              [--transparent] [--composite] [--cover]
//   node studio-cli.mjs timeline <scene.json> [--from 0 --to 10] [--frames 8] [--out timeline.png]
//   node studio-cli.mjs cut-check <video.mp4> [--scene scene.json]
//   node studio-cli.mjs cleanup <clip.mp4|wav> [--out file] [--max-pause 0.6] [--keep-pause 0.25] [--no-fillers]
//   node studio-cli.mjs best-take --text "the line" <take1.wav> <take2.wav> …
//   node studio-cli.mjs connect [--yes]
//   node studio-cli.mjs beats <music.mp3>
//   node studio-cli.mjs transcribe <voice.mp3> [--language en]
//   node studio-cli.mjs voice-check <voice.wav> --text "the script line" [--max-gap 0.4]
//   node studio-cli.mjs separate <clip.mp4> [--out folder] [--stems]
//   node studio-cli.mjs music "<style>" [--seconds 30] [--bpm 120] [--out music.mp3]
//   node studio-cli.mjs record <steps.json> [--out folder]
//   node studio-cli.mjs shot <shots.json> [--out folder]
//   node studio-cli.mjs screencast <recording folder> [--format 9x16|16x9] [--title "…"] [--end "…"] [--cta "…"] [--music file]
//   node studio-cli.mjs reference <video.mp4> [--fit 30] [--scene scene.json] [--sections-only] [--threshold 0.2]
//   node studio-cli.mjs from-beats <reel.beats.json> [--duration 20] [--rhythm video.reference.json] [--music file] [--out scene.json]
//   node studio-cli.mjs breakdown <reel.mp4> [--scene s.json --beats b.json | --rhythm r.json] [--title "…"] [--accent #hex] [--out f.json]
//   node studio-cli.mjs blender model|render <script.py> [--out file] [--project name] [--seconds 4 --fps 30 --width 1080 --height 1080]
//   node studio-cli.mjs doctor
//   node studio-cli.mjs projects
//   node studio-cli.mjs project <scene.json> [--name "…"]
//   node studio-cli.mjs notes "<project>" [--add "…" --section Decided]
//
// Add --json for machine-readable output, --player <address> to use a particular player version.

import { installFfmpeg, ffmpegStatus, requireFfmpeg } from './studio-ffmpeg.mjs'; // first: it makes a copy the kit installed usable
import { analyseBeats, checkScene, inspectScene, loadScene, renderScene, sceneStills, separateAudio, transcribeFile } from './studio-tools.mjs';

const HELP = `Kinetic Scenes tools (Unyson+ AI Dev Kit)

  check <scene.json>        Validate the scene and run Check scene
  inspect <scene.json>      Outline: stage, layers and clips in time, sound, key moments
  stills <scene.json>       A frame of each part once it has landed (or --times 1,2.5) as JPEGs in --out, with the layout measured on each
  render <scene.json>       A video (--out, --width, --height, --fps, --format mp4|webm|mov); needs ffmpeg
                            --transparent: see-through (WebM or ProRes .mov), --composite: keep reference footage,
                            --cover: also save the still frame as a PNG
                            --blur [n]: motion blur, n sub-frames a frame (default 8; n times the work)
  timeline <scene.json>     One picture of a stretch (--from, --to): frames, the sound wave, every spoken word at its time
                            (pauses inside a phrase in red) and the words on screen as bars (--out timeline.png)
  cut-check <video>         The finished video checked like an editor would (--scene for the narration):
                            black frames, every voice line heard, loudness and clipping. render runs it on every MP4
  cleanup <clip>            Spoken footage cleaned up from its words: false starts, fillers (um, uh) and long pauses cut,
                            each cut faded; writes <clip>-clean and an edit list (.edl.json)
  best-take <takes…>        The takes of one line (--text) ranked by the voice check: changed words, pauses mid-phrase
  object3d "<description>"  A 3D object built from a description as a GLB for a 3D layer: designed in parts, measured (parts
                            touch, none buried, sane sizes), fixed up to 3 times, looked at from four sides; --out object.glb
  compose <scene.json>      A short score written to the scene's timing (tempo from when things land, chords per section,
                            accents, a lift into the reveal), no add-on: --mood bright|calm|dark|driving, --out score.wav
  like-this <video>         Works out how a video you like is made (structure, pacing, text style, cuts, use of music) as a
                            brief and a rhythm to build your own scene to (--seconds for its length; --out brief.md)
  edit-export <scene.json>  The scene's cut for another video editor: project.fcpxml (Resolve, Final Cut), project.xml (Premiere),
                            captions.srt and a README, into --out (default edit/ beside the scene); --graphics <file> adds a
                            see-through render as the top track (default: the newest in renders/)
  highlights <video>        A reel from a long video: the sharp, steady, well-lit moments (and what is talked about, with speech
                            recognition installed) cut together to --length seconds (default 30) in --format 9x16|1x1|4x5|16x9,
                            on the beats of --music <file> (at 25%), a title on each part (--no-titles: none); writes --out (default highlights.json)
  reference <video>         The rhythm of a reference reel: hard cuts, motion peaks (reveals, transitions), the pace in words,
                            3-8 sections and a numbered contact sheet; writes <video>.reference.json and .jpg
                            (--fit <seconds> stretches it to a new length, --scene <scene.json> adds it as markers
                            [--sections-only], --threshold 0.2 cut sensitivity, --no-sheet)
  from-beats <reel.json>    A reel from a few lines: brand + beats (headline, photo, split, list, proof, logo, close) built
                            into a full scene, words kept clear of the apps' buttons, the credit on the close frame;
                            --duration <s>, --rhythm <video.reference.json> (lengths snap to its moments), --music, --out
  breakdown <reel.mp4>      "How this reel was made" (16:9): the finished reel beside its storyboard, a highlight on the
                            beat on screen and a progress bar; steps from --beats <reel.beats.json> with --scene, or the
                            --scene's markers, or --rhythm <video.reference.json>; --title, --accent, --out
  ffmpeg [install]          Whether FFmpeg is here (video, audio and previews need it); install: the kit installs it itself
  doctor                    Check this computer: kit and Node versions, ffmpeg, the rendering browser, graphics card and free
                            memory, AI, Blender, the workspace and each add-on; ready to paste into a bug report
  blender model <script.py> Blender (in the background) runs an agent's bpy script; what it builds becomes a glTF model
                            for a 3D layer (centred, sized, modifiers applied) with a 4-view preview; --out, --project, --name
  blender render <script.py> An animated Blender shot rendered with a transparent background to WebM for a footage layer
                            (--seconds, --fps, --width, --height). Scripts can use hex_color('#00B295') for exact colours
  batch <scene.json>        One video per row of a spreadsheet: --data rows.csv fills the scene's {{placeholders}} (a column
                            each) and renders every row (--rows 1-3,5; --name <column> names the files; --out <folder>);
                            --check only lists the placeholders and what is missing
  stock <words>             Free stock footage, photos (--photo) or sounds (--audio) from Pexels, Pixabay (keys: --key-pexels,
                            --key-pixabay), NASA and Openverse, each with its licence; --get <n> --project <name> downloads
                            result n into the project's media/ and notes its source, licence and credit
  connect                   Connects your AI agents (Claude Code, Cursor, Codex found on this computer) to Kinetic Scenes:
                            shows the plan; --yes applies it
  beats <music file>        Tempo, beats, their strength and the strongest moments
  transcribe <voice file>   Every word with its time (needs the kit's speech recognition)
  voice-check <voice file>  A voice line against its script (--text): changed words, and pauses mid-phrase that sound machine-made
  listen <video|sound|scene> A second opinion from Gemini, timed notes on how it sounds. Uploads to Google on your own key, so it
                            needs --yes (--question "…"; --scene <file> adds the script to a video)
  voice-review <lines.json> Every line of a script ({ lines, voice }), spoken and voice-checked on its own (the kit must be running)
  separate <sound or video> The voice and the music as two WAV files in --out (--stems: drums, bass, other, vocals too)
  sounds-in <sound or video> The sounds heard and when (speech, music, rain, a door slam…; --labels "a,b" for your own)
  clap-install              Install sound identification (about 560 MB, once)
  music "<style>"           An instrumental from the ACE-Step add-on (--seconds, --bpm, --out); the kit starts ACE-Step if needed
  record <steps.json>       A screencast of the steps in a real browser (2x video + actions.json in --out); see studio-record.mjs
  shot <shots.json>         Sharp 2x screenshots of pages or elements, with highlight, arrow, blur and callout (see studio-shot.mjs)
  projects                  The workspace's projects (folders the Studio opens with File > Projects)
  project <scene.json>      Puts a scene into a workspace project (--name; created if new), its files copied into media/;
                            the project open in the Studio updates at once
  notes "<project>"         The project's notes.md (the plan, what was decided, what is left); --add "…" [--section "Still to do"]
                            adds a dated line. Read them before working on a project, add to them when something is decided
  screencast <folder>       A recording as a scene that zooms to each action, with step captions (--format, --title, --end, --cta, --music, --intro, --accent, --bg, --title-bg, --end-bg, --voice)

  --json      print JSON
  --player    the player's address (default: the newest one on kinetic-scenes.unysonplus.com)`;

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[k] = true; else { out[k] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

/** What can't work without FFmpeg: it says so before it starts. */
const NEEDS_FFMPEG = new Set(['render', 'timeline', 'cut-check', 'cleanup', 'like-this', 'highlights', 'reference', 'transcribe', 'listen', 'separate', 'record']);

const a = args(process.argv.slice(2));
const [cmd, file] = a._;
const json = !!a.json;
// Machine output owns stdout: the tools' own progress lines go to stderr.
const out = console.log.bind(console);
if (json) for (const k of ['log', 'info']) console[k] = (...x) => process.stderr.write(`${x.join(' ')}
`);
const cutReport = (c) => `Cut check: ${c.ok ? 'OK' : 'PROBLEMS'} (${c.cuts.length} cut(s)${c.loudness != null ? `, ${c.loudness.toFixed(1)} LUFS` : ''}${c.narration ? `, ${c.narration.lines - c.narration.missing}/${c.narration.lines} voice lines heard` : ''})` + c.issues.map((i) => `\n  - ${i.t != null ? `${i.t} s: ` : ''}${i.text}`).join('');
const print = (human, data) => out(json ? JSON.stringify(data, null, 2) : human);
const progress = (s) => { if (!json && process.stderr.isTTY) process.stderr.write(`\r${s}`.padEnd(60)); };

async function main() {
  if (!cmd || cmd === 'help' || a.help) { console.log(HELP); return 0; }
  // An agent at work: the Studio shows it as connected.
  if (['record', 'screencast', 'project', 'projects', 'notes', 'timeline', 'render', 'stills', 'check', 'shot', 'music', 'inspect', 'stock'].includes(cmd)) {
    const w = await import('./studio-workspace.mjs');
    await w.noteAgent(w.agentFromEnv());
  }
  if (cmd === 'projects') {
    const { listProjects } = await import('./studio-workspace.mjs');
    const r = await listProjects();
    print(`${r.root}\n${r.projects.map((p) => `  ${p.id}  (${Math.round(p.duration)} s, ${new Date(p.updated).toLocaleString()})`).join('\n') || '  (no projects yet)'}`, r);
    return 0;
  }
  if (cmd === 'connect') {
    const { connectAgents } = await import('./studio-connect.mjs');
    const r = await connectAgents({ apply: a.yes === true, ask: a.ask === true });
    if (a.ask) return 0; // the start script: it asked (or not) and goes on
    const lines = r.plan.map((p) => `  ${p.done ? '✓ already' : a.yes ? '→' : '•'} ${p.agent}: ${p.what}`);
    const res = r.applied.map((x) => `  ${x.ok ? '✓ done' : '✗ failed'}: ${x.agent}, ${x.what}${x.error ? ` (${x.error})` : ''}`);
    const head = r.plan.length ? `AI agents on this computer:\n${lines.join('\n')}` : 'No AI agent found (Claude Code, Cursor or Codex).';
    const tail = res.length ? `\n\n${res.join('\n')}` : r.plan.some((p) => !p.done) && !a.yes ? '\n\nRun again with --yes to connect them.' : '';
    print(head + tail, r);
    return 0;
  }
  if (cmd === 'ffmpeg') {
    const now = ffmpegStatus();
    const ready = now.ffmpeg && now.ffprobe;
    if (file === 'install') {
      const r = ready ? now : await installFfmpeg((s) => process.stderr.write(`${s}\n`));
      print(`FFmpeg is ready: ${r.version}.`, r);
      return 0;
    }
    print(ready ? `FFmpeg is here (${now.source === 'kit' ? 'installed by the kit' : 'on this computer'}): ${now.version}.` : now.message, now);
    return ready ? 0 : 1;
  }
  if (!file && cmd !== 'stock' && cmd !== 'doctor' && cmd !== 'clap-install') throw new Error(`Give a file: studio-cli ${cmd} <file>`);
  if (NEEDS_FFMPEG.has(cmd)) requireFfmpeg(`"${cmd}"`);
  switch (cmd) {
    case 'check': {
      const r = await checkScene(loadScene(file), { player: a.player });
      print(r.errors.length
        ? `Can't be played:\n${r.errors.map((e) => `  - ${e}`).join('\n')}`
        : r.issues.length ? `${r.issues.length} issue(s):\n${r.issues.map((i) => `  - ${i}`).join('\n')}` : 'No issues.', r);
      return r.ok ? 0 : 1;
    }
    case 'inspect': {
      const r = inspectScene(loadScene(file));
      print([
        `${r.title || '(untitled)'}: ${r.duration}s${r.loop ? ', loops' : ''}; ${r.layers} layers; ${r.breakpoints.join(', ')}`,
        r.audio.length ? `Sound: ${r.audio.join('; ')}` : 'No sound.',
        r.markers.length ? `Markers: ${r.markers.join('; ')}` : '',
        `Key moments: ${r.keyMoments.join(', ')} s`, '', r.outline,
      ].filter((l) => l !== '').join('\n'), r);
      return 0;
    }
    case 'stills': {
      const times = typeof a.times === 'string' ? a.times.split(',').map(Number) : undefined;
      const r = await sceneStills(loadScene(file), { times, out: a.out, width: +a.width || undefined, player: a.player });
      print(`${r.files.map((f) => `${f.t}s  ${f.file}`).join('\n')}${r.layout.length ? `\n\nLayout (measured on these frames):\n${r.layout.map((l) => `  - ${l}`).join('\n')}` : '\n\nLayout: no problems measured.'}${r.issues.length ? `\n\nCheck scene: ${r.issues.length} issue(s) (run check to list them)` : ''}`, r);
      return 0;
    }
    case 'render': {
      const r = await renderScene(loadScene(file), {
        out: a.out, width: +a.width || undefined, height: +a.height || undefined, fps: +a.fps || undefined, format: a.format, player: a.player,
        transparent: !!a.transparent, composite: !!a.composite, cover: !!a.cover, blur: a.blur === true ? 8 : Number(a.blur) || 0,
        onProgress: (d, t) => progress(`Rendering frame ${d} of ${t}`),
      });
      if (!json && process.stderr.isTTY) process.stderr.write('\n');
      // Every cut checked before the video is handed over (MP4 and WebM; ProRes is for an editor to finish).
      if (a['no-check'] !== true && /\.(mp4|webm)$/i.test(r.file)) {
        const { cutCheck } = await import('./studio-cutcheck.mjs');
        r.check = await cutCheck(r.file, loadScene(file)).catch((e) => ({ ok: false, cuts: [], issues: [{ t: null, text: `The check could not run: ${e.message}` }] }));
      }
      print(`${r.check ? `${cutReport(r.check)}\n` : ''}${r.file} (${(r.bytes / 1e6).toFixed(1)} MB, ${r.seconds}s; drawn on ${r.gpu || 'the processor (software)'}, encoded with ${r.encoder || 'the processor'}, ${r.workers || 1} tab(s) at once)${r.cover ? `
Cover: ${r.cover}` : ''}${r.warnings?.length ? `\nRendered without: ${r.warnings.join(', ')}` : ''}`, r);
      return 0;
    }
    case 'timeline': {
      const { sceneTimeline } = await import('./studio-timeline.mjs');
      const r = await sceneTimeline(loadScene(file), { from: a.from, to: a.to, frames: a.frames, out: typeof a.out === 'string' ? a.out : 'timeline.png', player: a.player });
      const list = r.pauses.map((p) => `  - ${p.t} s: ${p.seconds} s between "${p.after}" and "${p.before}"`).join('\n');
      print(`${r.file}: ${r.from}-${r.to} s, ${r.words} spoken words, ${r.onScreen} text layer(s)\n${r.pauses.length ? `${r.pauses.length} pause(s) inside a phrase:\n${list}` : 'No pauses inside a phrase.'}`, r);
      return 0;
    }
    case 'cut-check': {
      const { cutCheck } = await import('./studio-cutcheck.mjs');
      const r = await cutCheck(file, typeof a.scene === 'string' ? loadScene(a.scene) : null);
      print(cutReport(r), r);
      return r.ok ? 0 : 1;
    }
    case 'cleanup': {
      const { cleanupClip } = await import('./studio-cleanup.mjs');
      const r = await cleanupClip(file, { out: typeof a.out === 'string' ? a.out : undefined, maxPause: Number(a['max-pause']) || 0.6, keepPause: Number(a['keep-pause']) || 0.25, fillers: a['no-fillers'] !== true });
      print(`${r.out}: ${r.before} s → ${r.after} s (${r.removed} s cut, ${r.cuts.length} cut(s))${r.cuts.map((c) => `\n  - ${c.start}-${c.end} s: ${c.why}`).join('')}`, r);
      return 0;
    }
    case 'object3d': {
      const { playerBase: pbase } = await import('./studio-tools.mjs');
      const r = await (await import('./studio-object3d.mjs')).objectFromDescription({ prompt: a._.slice(1).join(' '), playerBase: await pbase(a.player), look: a['no-look'] !== true, onStep: progress });
      const out = typeof a.out === 'string' ? a.out : 'object.glb';
      (await import('node:fs')).writeFileSync(out, r.glb);
      print(`${out}: "${r.name}", ${r.parts} parts, ${(r.glb.length / 1024).toFixed(0)} KB. ${r.problems.length ? `Still measured: ${r.problems.join(' ')}` : 'Measured: no problems.'} ${r.notes}`, { ...r, glb: undefined, out });
      return 0;
    }
    case 'compose': {
      const r = (await import('./studio-score.mjs')).composeScore(loadScene(file), { mood: typeof a.mood === 'string' ? a.mood : 'bright' });
      const out = typeof a.out === 'string' ? a.out : 'score.wav';
      (await import('node:fs')).writeFileSync(out, r.wav);
      print(`${out}: ${r.seconds} s, ${r.bpm} bpm, ${r.key}, a lift into ${r.reveal} s, accents at ${r.accents.join(', ') || 'none'}`, { ...r, wav: undefined, out });
      return 0;
    }
    case 'like-this': {
      const r = await (await import('./studio-likethis.mjs')).likeThis({ file, seconds: Number(a.seconds) || undefined, onStep: progress });
      const text = `${r.brief}\n\n${r.context}\n`;
      if (typeof a.out === 'string') (await import('node:fs')).writeFileSync(a.out, text);
      print(typeof a.out === 'string' ? `${a.out}: the brief and the rhythm (${r.duration} s). ${r.summary}` : text, r);
      return 0;
    }
    case 'edit-export': {
      const { dirname: dn, join: jn, resolve: rs } = await import('node:path');
      const m = await import('./studio-interchange.mjs');
      const base = dn(rs(file));
      const r = m.writeInterchange({ scene: loadScene(file), baseDir: base, out: typeof a.out === 'string' ? rs(a.out) : jn(base, 'edit'), graphics: typeof a.graphics === 'string' ? rs(a.graphics) : undefined });
      print(`${r.dir}: ${r.files.join(', ')} (${r.clips} clip(s))${r.graphics ? `\nGraphics: ${r.graphics}` : '\nNo see-through render yet: the graphics are not in it (render with --transparent --format mov first).'}${r.skipped.length ? `\nLeft out: ${r.skipped.join(', ')}` : ''}`, r);
      return 0;
    }
    case 'highlights': {
      const h = await import('./studio-highlights.mjs');
      const { resolve: res, dirname: dn } = await import('node:path');
      let words = null;
      if (a['no-words'] !== true) {
        try {
          const { tmpdir } = await import('node:os');
          const mp3 = res(tmpdir(), `upw-hl-${Date.now()}.mp3`);
          const { spawnSync } = await import('node:child_process');
          spawnSync(process.env.FFMPEG || 'ffmpeg', ['-v', 'error', '-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', mp3]);
          words = (await transcribeFile(mp3, { onProgress: progress })).words;
        } catch (e) { progress(`No speech used (${e.message.split('.')[0]})`); }
      }
      const beats = typeof a.music === 'string' ? (await analyseBeats(a.music)).beats.times : null;
      const r = await h.findHighlights({ file, length: Number(a.length) || 30, part: Number(a.part) || 3, words, beats, onStep: progress });
      const out = res(typeof a.out === 'string' ? a.out : 'highlights.json');
      const scene = h.highlightScene({ parts: r.parts, src: res(file), title: typeof a.title === 'string' ? a.title : 'Highlights', format: typeof a.format === 'string' ? a.format : '9x16', music: typeof a.music === 'string' ? res(a.music) : null, titles: a['no-titles'] !== true });
      (await import('node:fs')).writeFileSync(out, JSON.stringify(scene, null, 2));
      if (!json && process.stderr.isTTY) process.stderr.write('\n');
      print(`${out}: ${r.parts.length} part(s), ${scene.duration} s from ${r.seconds} s (${r.cuts.length} cut(s) found)${r.parts.map((p, i) => `\n  ${i + 1}. ${p.from}-${p.to} s (${p.why})${p.title ? `: "${p.title}"` : ''}`).join('')}`, { ...r, out });
      return 0;
    }
    case 'reference': {
      const ref = await import('./studio-reference.mjs');
      const fs = await import('node:fs');
      const base = file.replace(/\.[^.\\/]+$/, '');
      const map = await ref.analyseReference(file, { threshold: a.threshold !== undefined ? Number(a.threshold) : 0.2, sheet: a['no-sheet'] === true ? null : `${base}.reference.jpg`, onStep: progress });
      const fitted = a.fit ? ref.fitRhythm(map, Number(a.fit)) : map;
      const out = typeof a.out === 'string' ? a.out : `${base}.reference.json`;
      fs.writeFileSync(out, JSON.stringify(fitted, null, 2));
      let marked = '';
      if (typeof a.scene === 'string') {
        const scene = ref.rhythmMarkers(loadScene(a.scene), map, { sectionsOnly: a['sections-only'] === true });
        fs.writeFileSync(a.scene, JSON.stringify(scene, null, 2));
        marked = `\n${a.scene}: ${scene.markers.filter((m) => /^r\d+$/.test(m.id)).length} rhythm marker(s), fitted to ${scene.duration} s`;
      }
      if (!json && process.stderr.isTTY) process.stderr.write('\n');
      print(`${map.summary}\n${fitted.sections.map((s) => `  ${s.name.padEnd(8)} ${s.from}-${s.to} s`).join('\n')}${a.fit ? `\n(fitted from ${map.duration} s to ${fitted.duration} s)` : ''}\n${out}${map.sheet ? `\n${map.sheet}` : ''}${marked}`, { ...fitted, out });
      return 0;
    }
    case 'from-beats': {
      const bt = await import('./studio-beats.mjs');
      const fs = await import('node:fs');
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      const problems = bt.checkBeats(doc);
      if (problems.length) { print(`Can't build:\n- ${problems.join('\n- ')}`, { problems }); return 1; }
      const rhythm = typeof a.rhythm === 'string' ? JSON.parse(fs.readFileSync(a.rhythm, 'utf8')) : null;
      const scene = bt.beatsScene(doc, { duration: Number(a.duration) || undefined, rhythm, music: typeof a.music === 'string' ? a.music : null });
      const out = typeof a.out === 'string' ? a.out : file.replace(/(\.beats)?\.json$/i, '') + '.scene.json';
      fs.writeFileSync(out, JSON.stringify(scene, null, 2));
      const c = await checkScene(scene, { player: a.player });
      print(`${out}: ${doc.beats.length} beat(s), ${scene.duration} s, ${scene.layers.length} layer(s)${rhythm ? ' (on the reference rhythm)' : ''}\n${scene.markers.map((m) => `  ${m.t} s  ${m.label}`).join('\n')}\nCheck scene: ${c.errors.length ? `can't be played: ${c.errors.join('; ')}` : c.issues.length ? `${c.issues.length} note(s) (run check to list them)` : 'no issues'}`, { out, duration: scene.duration, markers: scene.markers, errors: c.errors, issues: c.issues });
      return c.errors.length ? 1 : 0;
    }
    case 'breakdown': {
      const bd = await import('./studio-breakdown.mjs');
      const fs = await import('node:fs');
      if (!file || !fs.existsSync(file)) { print('Give the finished reel (an MP4). Render the reel first when it has none yet.', {}); return 1; }
      const read = (k) => (typeof a[k] === 'string' ? JSON.parse(fs.readFileSync(a[k], 'utf8')) : null);
      const scene = await bd.breakdownScene({ video: file, scene: read('scene'), beats: read('beats'), reference: read('rhythm'), title: typeof a.title === 'string' ? a.title : undefined, accent: typeof a.accent === 'string' ? a.accent : undefined });
      const out = typeof a.out === 'string' ? a.out : file.replace(/\.[^.\\/]+$/, '') + '.breakdown.json';
      fs.writeFileSync(out, JSON.stringify(scene, null, 2));
      const c = await checkScene(scene, { player: a.player });
      print(`${out}: ${scene.markers.length} step(s), ${scene.duration} s (16:9)\n${scene.markers.map((m) => `  ${m.t} s  ${m.label}`).join('\n')}\nCheck scene: ${c.errors.length ? `can't be played: ${c.errors.join('; ')}` : c.issues.length ? `${c.issues.length} note(s) (run check to list them)` : 'no issues'}`, { out, markers: scene.markers, errors: c.errors, issues: c.issues });
      return c.errors.length ? 1 : 0;
    }
    case 'doctor': {
      const d = await import('./studio-doctor.mjs');
      const r = await d.checkComputer();
      print(d.doctorText(r), r);
      return 0;
    }
    case 'blender': {
      // blender model <script.py> | blender render <script.py>: Blender in the background, its result for a scene.
      const what = file, script = a._[2];
      if (!['model', 'render'].includes(what) || typeof script !== 'string') { print('Use: blender model <script.py> [--out x.glb] [--project p] [--name "..."], or blender render <script.py> [--seconds 4 --fps 30 --width 1080 --height 1080] [--out x.webm] [--project p]', {}); return 1; }
      const bl = await import('./studio-blender.mjs');
      const code = (await import('node:fs')).readFileSync(script, 'utf8');
      const opts = { script: code, out: typeof a.out === 'string' ? a.out : undefined, project: typeof a.project === 'string' ? a.project : null, name: typeof a.name === 'string' ? a.name : undefined };
      if (what === 'model') {
        const r = await bl.blenderModel(opts);
        print(`${r.glb}: ${r.stats.tris} triangles, ${r.stats.objects} object(s), ${r.stats.materials} material(s), ${(r.stats.bytes / 1e3).toFixed(0)} KB\nPreview (4 views): ${r.preview}\nIn a scene: { "type": "model", "model": { "kind": "gltf", "src": ${JSON.stringify(r.src)} } }${r.warnings.map((w) => `\n- ${w}`).join('')}`, r);
      } else {
        const r = await bl.blenderRender({ ...opts, seconds: Number(a.seconds) || 4, fps: Number(a.fps) || 30, width: Number(a.width) || 1080, height: Number(a.height) || 1080 });
        print(`${r.webm}: ${r.frames} frame(s), ${r.seconds} s, transparent\nPreview: ${r.preview}\nIn a scene: { "type": "video", "src": ${JSON.stringify(r.src)} }`, r);
      }
      return 0;
    }
    case 'clap-install': {
      const c = await import('./studio-clap.mjs');
      c.startClapInstall();
      let st;
      while ((st = c.clapStatus().install).state === 'running') { progress(st.step); await new Promise((ok) => setTimeout(ok, 1000)); }
      if (st.state === 'error') throw new Error(st.error);
      print(`Sound identification installed (about ${c.CLAP_MB} MB).`, c.clapStatus());
      return 0;
    }
    case 'sounds-in': {
      // sounds-in <clip> [--labels "rain,a door slam"]: names the sounds heard and when (CLAP, on this computer).
      const c = await import('./studio-clap.mjs');
      const labels = typeof a.labels === 'string' ? a.labels.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
      const r = await c.identifySounds(file, { labels, onProgress: (d, t) => progress(`Listening ${d} of ${t}`) });
      print(`${r.seconds} s. Mostly: ${r.overall.map((x) => `${x.label} (${x.score})`).join(', ') || 'nothing clear'}\n${r.segments.map((x) => `  ${x.start}-${x.end} s  ${x.label}  (${x.score})`).join('\n') || '  (no clear sounds)'}`, r);
      return 0;
    }
    case 'batch': {
      if (typeof a.data !== 'string') throw new Error('Give the spreadsheet: --data rows.csv');
      const b = await import('./studio-batch.mjs');
      const scene = loadScene(file);
      const { columns, rows } = b.parseCsv((await import('node:fs')).readFileSync(a.data, 'utf8'));
      const missing = b.missingColumns(scene, columns);
      if (a.check) {
        print(`Placeholders: ${b.placeholders(scene).map((p) => `{{${p}}}`).join(', ') || 'none'}\nColumns: ${columns.join(', ')}\n${rows.length} row(s)${missing.length ? `\nNo column for: ${missing.join(', ')}` : '\nEvery placeholder has a column.'}`, { columns, rows: rows.length, missing });
        return missing.length ? 1 : 0;
      }
      const r = await b.renderBatch({ scene, csvFile: a.data, outDir: typeof a.out === 'string' ? a.out : undefined, name: typeof a.name === 'string' ? a.name : undefined, rows: a.rows, width: +a.width || undefined, height: +a.height || undefined, fps: +a.fps || undefined,
        onRow: (i, n, label) => progress(`Row ${i} of ${n}: ${label}`) });
      if (!json && process.stderr.isTTY) process.stderr.write('\n');
      print(r.map((x) => `${x.row}. ${x.label}: ${x.file || `FAILED (${x.error})`}`).join('\n'), r);
      return r.every((x) => x.file) ? 0 : 1;
    }
    case 'stock': {
      const st = await import('./studio-stock.mjs');
      for (const src of ['pexels', 'pixabay']) if (typeof a[`key-${src}`] === 'string') await st.setStockKey(src, a[`key-${src}`]);
      const q = a._.slice(1).join(' ');
      if (!q) { const s = await st.stockStatus(); print(Object.entries(s.sources).map(([k, v]) => `${k}: ${v.on ? "on" : "off"}${v.needsKey ? (v.hasKey ? ", key saved" : ", needs a key") : ""}`).join(String.fromCharCode(10)), s); return 0; }
      const kind = a.photo ? 'photo' : a.audio ? 'audio' : 'video';
      const r = await st.stockSearch({ q, kind, orient: typeof a.orient === 'string' ? a.orient : '' });
      if (a.get !== undefined) {
        const pick = r.results[Number(a.get) - 1];
        if (!pick) throw new Error(`No result ${a.get}.`);
        if (typeof a.project !== 'string') throw new Error('Give the project: --project <name>');
        const g = await st.stockGet(a.project, pick);
        print(`${g.path}
${g.note}`, g);
        return 0;
      }
      print([...r.results.map((x, i) => `${i + 1}. [${x.source} ${x.kind}] ${String(x.title).slice(0, 60)}${x.seconds ? ` (${Math.round(x.seconds)} s)` : ''}${x.width ? ` ${x.width}x${x.height}` : ''}
   ${x.page}
   ${x.licence}${x.credit ? `
   CREDIT: ${x.credit}` : ''}`), ...r.notes.map((n) => `note: ${n}`)].join('\n'), r);
      return 0;
    }
    case 'best-take': {
      if (typeof a.text !== 'string') throw new Error('Give the line: --text "…"');
      const { bestTake } = await import('./studio-cleanup.mjs');
      const r = await bestTake(a._.slice(1), a.text);
      print(r.map((x, i) => `${i + 1}. ${x.ok ? 'PASS' : `${x.problems.length} problem(s)`}  ${x.file}${x.problems.map((p) => `\n     - ${p.text}`).join('')}`).join('\n'), r);
      return r.length && r[0].ok ? 0 : 1;
    }
    case 'beats': {
      const r = await analyseBeats(file);
      print([
        `${r.seconds}s, ${r.beats.bpm} bpm, ${r.beats.times.length} beats`,
        `Strongest moments: ${r.strong.map((b) => `${b.t}s (${b.s})`).join(', ') || 'none stand out'}`,
      ].join('\n'), r);
      return 0;
    }
    case 'transcribe': {
      const r = await transcribeFile(file, { language: a.language, onProgress: progress });
      if (!json && process.stderr.isTTY) process.stderr.write('\n');
      print(`${r.words.map((w) => `${w.t.toFixed(2)}  ${w.w}`).join('\n')}\n\n${r.speech?.wpm ?? '?'} words a minute${r.speech?.delivery?.length ? `, ${r.speech.delivery.join(', ')}` : ''}`, r);
      return 0;
    }
    case 'listen': {
      const { listen, CONSENT } = await import('./studio-listen.mjs');
      const { mixSceneSound } = await import('./studio-tools.mjs');
      if (a.yes !== true) throw new Error(`Add --yes to send it. ${CONSENT}`);
      const isScene = /\.json$/i.test(file);
      const r = await listen({ file: isScene ? undefined : file, scene: isScene ? loadScene(file) : typeof a.scene === 'string' ? loadScene(a.scene) : null, mix: (sc, out) => mixSceneSound(sc, out, { player: a.player }), question: a.question, confirm: true, onStep: progress });
      if (!json && process.stderr.isTTY) process.stderr.write('\n');
      const at = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
      print(`${r.summary}\n${r.notes.map((n) => `  ${at(n.t)}  [${n.level}, ${n.kind}] ${n.note}${n.fix ? ` Fix: ${n.fix}` : ''}`).join('\n') || '  No notes.'}${r.dropped ? `\n${r.dropped} note(s) dropped (timed past the end, or unreadable).` : ''}${r.warnings.map((w) => `\n${w}`).join('')}\n(${r.model}, heard: ${r.sent}. An opinion to weigh: it can mishear.)`, r);
      return 0;
    }
    case 'voice-review': {
      // Every line of a script, spoken and checked on its own: a whole voice-over heard at once hides what one line alone shows.
      const { readFileSync } = await import('node:fs');
      const { voiceReview } = await import('./studio-tools.mjs');
      const spec = JSON.parse(readFileSync(file, 'utf8'));
      const r = await voiceReview(spec, { kit: typeof a.kit === 'string' ? a.kit : undefined, onStep: progress });
      if (!json && process.stderr.isTTY) process.stderr.write('\n');
      const rows = r.lines.map((l, i) => [`${i + 1}. ${l.ok ? 'OK' : 'PROBLEMS'}  ${l.text}`, ...(l.ok ? [] : [`     heard: ${l.heard}`]), ...l.problems.map((p) => `     - ${p.text}`)].join('\n'));
      print(`${rows.join('\n')}\n\n${r.ok ? 'Every line passes.' : `${r.lines.filter((l) => !l.ok).length} of ${r.lines.length} lines need another look.`}`, r);
      return r.ok ? 0 : 1;
    }
    case 'voice-check': {
      if (typeof a.text !== 'string') throw new Error('Give the script line: --text "…"');
      const { voiceCheck } = await import('./studio-tools.mjs');
      const r = await voiceCheck(file, a.text, { maxGap: Number(a['max-gap']) || 0.4, language: a.language });
      print(`${r.ok ? 'OK' : 'PROBLEMS'}: heard "${r.heard}"${r.problems.map((p) => `
  - ${p.t.toFixed(2)} s: ${p.text}`).join('')}
  longest pause between words: ${r.longestGap.toFixed(2)} s`, r);
      return r.ok ? 0 : 1;
    }
    case 'music': {
      const [{ makeMusic }, { aceFolder }, { writeFileSync }] = await Promise.all([import('./studio-music.mjs'), import('./studio-addons.mjs'), import('node:fs')]);
      const r = await makeMusic(aceFolder(), { prompt: file, seconds: Number(a.seconds) || 30, bpm: Number(a.bpm) || undefined }, progress);
      const outFile = typeof a.out === 'string' ? a.out : 'music.mp3';
      writeFileSync(outFile, r.mp3);
      if (!json && process.stderr.isTTY) process.stderr.write('\n');
      print(`${r.seconds} s of music${r.bpm ? ` at ${r.bpm} bpm` : ''}: ${outFile}`, { file: outFile, seconds: r.seconds, bpm: r.bpm });
      await (await import('./studio-music.mjs')).stopAce();
      return 0;
    }
    case 'record': {
      const { readFileSync } = await import('node:fs');
      const { record } = await import('./studio-record.mjs');
      const r = await record(JSON.parse(readFileSync(file, 'utf8')), typeof a.out === 'string' ? a.out : 'recording', progress);
      if (!json && process.stderr.isTTY) process.stderr.write('\n');
      print(`${r.seconds} s at ${r.width}x${r.height}, ${r.actions.length} actions: ${typeof a.out === 'string' ? a.out : 'recording'}`, r);
      return 0;
    }
    case 'shot': {
      const { readFileSync } = await import('node:fs');
      const { shots } = await import('./studio-shot.mjs');
      const r = await shots(JSON.parse(readFileSync(file, 'utf8')), typeof a.out === 'string' ? a.out : 'shots', progress);
      print(r.map((x) => x.file).join('\n'), r);
      return 0;
    }
    case 'screencast': {
      const { writeScreencastScene } = await import('./studio-screencast.mjs');
      const r = writeScreencastScene(file, { format: a.format, title: a.title, end: a.end, cta: a.cta, music: a.music, intro: a.intro, accent: a.accent, glow: a.glow, bg: a.bg, endBg: a['end-bg'], titleBg: a['title-bg'], voice: a.voice });
      print(`${r.file}: ${r.seconds} s, ${r.steps} step captions, ${r.stops} camera keys`, r);
      return 0;
    }
    case 'notes': {
      const w = await import('./studio-workspace.mjs');
      if (typeof a.add === 'string') w.addNote(file, a.add, typeof a.section === 'string' ? a.section : 'Decided');
      const r = w.readNotes(file);
      print(r.notes || '(no notes yet)', r);
      return 0;
    }
    case 'project': {
      const { sceneIntoProject } = await import('./studio-workspace.mjs');
      const r = sceneIntoProject(file, typeof a.name === 'string' ? a.name : undefined);
      print(`Project "${r.id}": ${r.dir} (${r.files} file(s) copied into media/)\nOpen it: ${r.link}`, r);
      return 0;
    }
    case 'separate': {
      const r = await separateAudio(file, { out: a.out, stems: !!a.stems, onProgress: (d, t) => progress(`Separating part ${d} of ${t}`) });
      if (!json && process.stderr.isTTY) process.stderr.write('\n');
      print(`${r.seconds} s separated:\n${Object.entries(r.files).map(([k, f]) => `  ${k}  ${f}`).join('\n')}`, r);
      return 0;
    }
    default:
      console.log(HELP);
      return 2;
  }
}

main().then((code) => process.exit(code), (e) => { console.error(String(e && e.message || e)); process.exit(1); });
