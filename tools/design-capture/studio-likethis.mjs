// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// "Make one like this": a video the person likes, worked out (its structure, pacing, text style, cuts and use of
// music) into a brief the AI builds the person's OWN scene to: same shape, their words, pictures and brand.
// The timing comes measured from studio-reference.mjs (cuts, moments, sections, pace); the look comes from the AI
// reading a contact sheet of the reference (one frame per shot) and a second sheet of moments with words on screen.
// Only how it is made is carried over, never what it shows: no words, logos, people or footage from the reference.

import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyseReference, fitRhythm } from './studio-reference.mjs';

const SYSTEM = `You are a motion designer studying a reference video someone likes, so a NEW video can be made in the same way.
You get its measured rhythm (cuts, moments of change, sections) and a contact sheet: one frame from each shot, numbered in order.
Write a brief for building a new scene that follows HOW the reference is made. Never copy WHAT it shows: no wording,
names, logos, people, products or footage from it.

Write plain text with these headings, each a few short lines:
STRUCTURE: the sections in order and what each does (hook, problem, reveal, proof, call to action...), with their share of the time.
PACING: how often something changes, where it speeds up or holds, how it ends.
TEXT: how words are used: how many at once, weight, case, size relative to the frame, placement, colour treatment, how text enters and leaves.
CUTS AND MOTION: hard cuts or transitions, camera moves, zooms, what moves on screen.
COLOUR AND LOOK: palette type (not exact brand colours), contrast, backgrounds, texture.
MUSIC AND SOUND: what the pacing suggests (a beat-driven track, a calm bed, hits on cuts), since you cannot hear it.
Then one line: THE FEEL: <five words or fewer>.`;

/**
 * { file (the reference video), seconds? (the new scene's length; default the reference's) } →
 * { brief (art direction for the build), context (the rhythm, fitted to the new length), map, summary }.
 */
export async function likeThis({ file, seconds, onStep = () => {} }) {
  if (!file || !existsSync(file)) throw Object.assign(new Error('Give the video you like.'), { code: 400 });
  const dir = mkdtempSync(join(tmpdir(), 'upw-like-'));
  try {
    const sheet = join(dir, 'sheet.jpg');
    const map = await analyseReference(file, { sheet, onStep });
    const fitted = seconds && Math.abs(seconds - map.duration) > 0.5 ? fitRhythm(map, seconds) : map;
    onStep('Looking at how it is made');
    const { askWithImages, stripReasoning } = await import('./to-ai.mjs');
    const user = `THE REFERENCE: ${map.duration} s, ${map.width}x${map.height}.
MEASURED RHYTHM: ${map.summary}
SECTIONS (seconds): ${map.sections.map((s) => `${s.name ?? 'section'} ${s.from}-${s.to}`).join('; ')}
SHOTS: ${map.shots.length}, lengths ${map.shots.slice(0, 40).map((s) => s.length).join(', ')}
The image is the contact sheet (frame numbers = shot order).`;
    const r = await askWithImages({ system: SYSTEM, user, images: existsSync(sheet) ? [sheet] : [], maxTokens: 3000 });
    const brief = stripReasoning(typeof r === 'string' ? r : r.text ?? '').trim();
    const context = `THE RHYTHM TO FOLLOW (from the reference, fitted to ${fitted.duration} s)
Sections: ${fitted.sections.map((s) => `${s.name ?? 'section'} ${s.from}-${s.to} s`).join('; ')}
Moments of change (put a cut, a reveal or a new line of text on each): ${fitted.moments.map((m) => m.t).join(', ')}
Pace: ${map.summary}`;
    return { brief: `MAKE IT LIKE THE REFERENCE (how it is made; never what it shows)\n${brief}`, context, summary: map.summary, duration: fitted.duration, map: fitted };
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
}
