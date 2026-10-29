// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Kinetic Scenes' sound search: Freesound's public-domain (CC0) sounds, searched with the user's own free API key
// (freesound.org/apiv2/apply), so nothing to license or credit. Results come with a preview; a chosen sound is
// fetched once (its high-quality MP3 preview), kept in the kit's sound cache, and handed to the Studio as a file.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = 'https://freesound.org/apiv2';

function dataDir() {
  const assembled = resolve(HERE, '../../..');
  return basename(assembled) === 'assembled' ? join(assembled, 'sounds') : join(homedir(), '.unysonplus', 'sounds');
}
const keyFile = () => join(dataDir(), 'freesound-key.txt');

/** The Freesound key: the environment, the kit's .env, or the one saved from the Studio. */
function key() {
  if (process.env.FREESOUND_KEY) return process.env.FREESOUND_KEY.trim();
  for (const f of [resolve(HERE, '../../../../.env'), resolve(HERE, '.env')]) {
    try { const m = /^\s*FREESOUND_KEY\s*=\s*(.+)\s*$/m.exec(readFileSync(f, 'utf8')); if (m) return m[1].replace(/^["']|["']$/g, '').trim(); } catch { /* none */ }
  }
  try { return readFileSync(keyFile(), 'utf8').trim(); } catch { return ''; }
}

const err = (message, code = 400) => Object.assign(new Error(message), { code });

export function soundsStatus() {
  return { key: !!key(), cached: existsSync(join(dataDir(), 'cache')) };
}

/** Saves the key the person pasted in the Studio (checked against Freesound first). */
export async function saveSoundsKey(body = {}) {
  const k = String(body.key || '').trim();
  if (!/^[A-Za-z0-9]{20,64}$/.test(k)) throw err('That does not look like a Freesound API key.');
  const r = await fetch(`${API}/search/text/?query=pop&page_size=1&token=${k}`);
  if (r.status === 401) throw err('Freesound did not accept that key.');
  if (!r.ok) throw err(`Freesound answered ${r.status}.`, 502);
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(keyFile(), k);
  return { ok: true };
}

/** Searches public-domain sounds: { q, page?, maxSeconds? } → { results: [{ id, name, seconds, tags, by, preview }], next }. */
export async function searchSounds(body = {}) {
  const k = key();
  if (!k) throw err('Add your free Freesound key first.', 412);
  const q = String(body.q || '').trim().slice(0, 100);
  if (!q) throw err('What sound are you looking for?');
  const max = Math.max(0.2, Math.min(600, Number(body.maxSeconds) || 30));
  const params = new URLSearchParams({
    query: q, page: String(Math.max(1, Number(body.page) || 1)), page_size: '24', token: k,
    filter: `license:"Creative Commons 0" duration:[0 TO ${max}]`,
    fields: 'id,name,duration,tags,username,previews', sort: 'score',
  });
  const r = await fetch(`${API}/search/text/?${params}`);
  if (r.status === 401) throw err('Freesound did not accept the saved key. Add it again.', 412);
  if (!r.ok) throw err(`Freesound answered ${r.status}.`, 502);
  const j = await r.json();
  return {
    count: j.count ?? 0,
    next: !!j.next,
    results: (j.results || []).map((s) => ({
      id: s.id, name: String(s.name || '').replace(/\.(wav|mp3|ogg|flac|aiff?)$/i, ''), seconds: Math.round((s.duration || 0) * 100) / 100,
      tags: (s.tags || []).slice(0, 6), by: s.username, preview: s.previews?.['preview-lq-mp3'] || s.previews?.['preview-hq-mp3'],
    })),
  };
}

/** One sound as a file for the scene (its high-quality MP3), cached by id: { id } → { src, name, seconds }. */
export async function fetchSound(body = {}) {
  const k = key();
  if (!k) throw err('Add your free Freesound key first.', 412);
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) throw err('Which sound?');
  const cache = join(dataDir(), 'cache');
  const file = join(cache, `${id}.mp3`);
  const meta = join(cache, `${id}.json`);
  if (!existsSync(file)) {
    const r = await fetch(`${API}/sounds/${id}/?fields=id,name,duration,license,previews&token=${k}`);
    if (!r.ok) throw err(`Freesound answered ${r.status}.`, 502);
    const s = await r.json();
    if (!/publicdomain\/zero/.test(String(s.license))) throw err('That sound is not public domain.');
    const a = await fetch(s.previews['preview-hq-mp3']);
    if (!a.ok) throw err('The sound could not be downloaded.', 502);
    mkdirSync(cache, { recursive: true });
    writeFileSync(file, Buffer.from(await a.arrayBuffer()));
    writeFileSync(meta, JSON.stringify({ name: s.name, seconds: s.duration }));
  }
  const m = JSON.parse(readFileSync(meta, 'utf8'));
  return { src: `data:audio/mpeg;base64,${readFileSync(file).toString('base64')}`, name: String(m.name).replace(/\.(wav|mp3|ogg|flac|aiff?)$/i, ''), seconds: m.seconds };
}

/* ------------------------------------------------------------------ generating a sound */

const DESIGN_SYSTEM = `You are a sound designer. Turn the description into a synthesised sound effect, as ONE JSON object and
nothing else:
{ "name": "<two or three words>", "length": <seconds, 0.05 to 4>, "layers": [ <1 to 5 layers> ] }
Each layer: { "source": "sine" | "square" | "saw" | "noise",
  "freq": [from, to] (Hz, for the oscillators; it glides exponentially over the layer),
  "filter": { "kind": "lp" | "bp" | "hp", "from": Hz, "to": Hz, "q": 0.5 to 8 } (optional; noise usually needs one),
  "env": { "kind": "hit", "attack": seconds, "decay": seconds } or { "kind": "arc", "peak": 0 to 1 } (arc rises then falls over the layer),
  "start": seconds (when the layer begins, default 0), "length": seconds (default: the sound's), "gain": 0 to 1,
  "wobble": { "rate": Hz, "depth": 0 to 1 } (optional tremolo) }
How sounds are made: a whoosh or swoosh is band-passed noise gliding up (or down for leaving) under an arc; a pop is a
sine gliding down fast with a hit envelope; a click or tick is a very short hit of high band-passed noise or a high sine;
an impact is a low sine gliding down (100 to 40 Hz) with a long decay plus a short burst of low-passed noise; a riser is
noise and a saw gliding up under an arc peaking near the end; a chime is two or three sines (a chord) with long hits;
paper and cloth are noise high-passed or band-passed around 2 to 6 kHz. Keep the total gain of overlapping layers under
about 1.2.`;

/**
 * A new sound from a description: { prompt } → { design } (a recipe the Studio renders), or, with the person's
 * own ElevenLabs key (ELEVENLABS_API_KEY), { src } from its sound-effects model.
 */
export async function designSound(body = {}) {
  const prompt = String(body.prompt || '').trim().slice(0, 300);
  if (!prompt) throw err('Describe the sound.');
  const el = process.env.ELEVENLABS_API_KEY || (() => {
    for (const f of [resolve(HERE, '../../../../.env'), resolve(HERE, '.env')]) {
      try { const m = /^\s*ELEVENLABS_API_KEY\s*=\s*(.+)\s*$/m.exec(readFileSync(f, 'utf8')); if (m) return m[1].replace(/^["']|["']$/g, '').trim(); } catch { /* none */ }
    }
    return '';
  })();
  if (el && body.engine !== 'synth') {
    const seconds = Number(body.seconds) || undefined;
    const r = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
      method: 'POST', headers: { 'xi-api-key': el, 'content-type': 'application/json' },
      body: JSON.stringify({ text: prompt, ...(seconds ? { duration_seconds: Math.max(0.5, Math.min(22, seconds)) } : {}) }),
    });
    if (!r.ok) throw err(`ElevenLabs answered ${r.status}.`, 502);
    return { engine: 'elevenlabs', name: prompt.slice(0, 40), src: `data:audio/mpeg;base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}` };
  }
  const { aiBackend, askText, extractJson, stripReasoning } = await import('./to-ai.mjs');
  if (!aiBackend()) throw err('AI is off in the AI Dev Kit. Connect an AI first.', 503);
  const raw = await askText({ system: DESIGN_SYSTEM, user: JSON.stringify({ description: prompt, seconds: Number(body.seconds) || undefined }), maxTokens: 1500 });
  const j = extractJson(stripReasoning(raw));
  if (!j || !Array.isArray(j.layers) || !j.layers.length) throw new Error('The AI did not return a sound. Try describing it differently.');
  return { engine: 'synth', design: j };
}
