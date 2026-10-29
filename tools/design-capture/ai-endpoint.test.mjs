// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Browser-free, network-free tests for the "bring your own endpoint" tier: the OpenAI-compatible
// translation, the model listing filter, and the error messages. `fetch` is mocked throughout, so no
// key, no provider and no Ollama are needed.
//
// WHY THESE EXIST. The endpoint tier reuses every existing caller by translating an Ollama-shaped body
// into OpenAI's shape and back. That translation is invisible at runtime — a wrong field does not throw,
// it just makes the model answer badly or the provider reject a conversation with a generic 400. Each
// difference between the two APIs is therefore pinned here:
//
//   • options.temperature / options.num_predict  ->  temperature / max_tokens
//   • format (schema | 'json')                   ->  response_format
//   • assistant tool_calls: arguments OBJECT     ->  JSON STRING, plus a required id
//   • tool results: Ollama's tool_name           ->  OpenAI's tool_call_id (matched to that call)
//   • reply: choices[0].message                  ->  message, arguments STRING -> OBJECT
//
// Run: node --test ai-endpoint.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

// Write config to a THROWAWAY file: these tests save endpoint settings, and the service's real
// ai-endpoint.json sits in this same folder — a test run must never re-point the live tier.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
process.env.AI_ENDPOINT_CONFIG = joinPath(mkdtempSync(joinPath(tmpdir(), 'sc-ep-')), 'ai-endpoint.json');

process.env.AI_ENDPOINT_URL = 'https://endpoint.example/v1';
process.env.AI_ENDPOINT_KEY = 'test-key';
process.env.AI_ENDPOINT_MODEL = 'vendor/model-70b';

const { endpointConfig, endpointActive, selectedLocalModel, listEndpointModels,
  testLocalModel, toolChatLocalModel, localAiStatus } = await import('./to-ai.mjs');

/** Run `fn` with a mocked fetch; returns { sent, url, headers, result }. */
async function withFetch(reply, fn) {
  const real = global.fetch;
  let sent = null, url = '', headers = null;
  global.fetch = async (u, opts = {}) => {
    url = String(u); headers = opts.headers || {};
    if (opts.body) { try { sent = JSON.parse(opts.body); } catch { sent = opts.body; } }
    return typeof reply === 'function' ? reply(url) : reply;
  };
  try { const result = await fn(); return { sent, url, headers, result }; }
  finally { global.fetch = real; }
}
const ok = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
const err = (status, body) => ({ ok: false, status, json: async () => ({}), text: async () => body });
/** An OpenAI chat reply. */
const oai = (message) => ok({ choices: [{ message }] });

test('the endpoint config resolves from the environment and reports its source', () => {
  const c = endpointConfig();
  assert.equal(c.baseUrl, 'https://endpoint.example/v1');
  assert.equal(c.model, 'vendor/model-70b');
  assert.equal(c.source, 'env');
  assert.equal(endpointActive(), true);
});

test('a configured endpoint IS the picked model for the non-Claude tier', () => {
  // Otherwise every caller that reads selectedLocalModel() would send an Ollama tag to the endpoint.
  assert.equal(selectedLocalModel(), 'vendor/model-70b');
});

test('the request goes to /chat/completions with bearer auth, not to Ollama', async () => {
  const { url, headers } = await withFetch(oai({ content: 'hi' }), () => testLocalModel('hello'));
  assert.equal(url, 'https://endpoint.example/v1/chat/completions');
  assert.equal(headers.authorization, 'Bearer test-key');
});

test('Ollama options are translated to OpenAI fields, and Ollama-only keys are dropped', async () => {
  const { sent } = await withFetch(oai({ content: 'hi' }), () => testLocalModel('hello'));
  assert.equal(sent.model, 'vendor/model-70b');
  assert.equal(sent.temperature, 0);
  assert.equal(sent.stream, false);
  // `think` and `options` are Ollama's own — a provider either ignores or rejects them.
  assert.equal('think' in sent, false, '`think` must not be sent to an OpenAI endpoint');
  assert.equal('options' in sent, false, '`options` must not be sent to an OpenAI endpoint');
});

test('the reply is read from choices[0].message, not message', async () => {
  const { result } = await withFetch(oai({ content: 'Hello there!' }), () => testLocalModel('hi'));
  assert.equal(result.ok, true);
  assert.equal(result.reply, 'Hello there!');
});

test('a JSON-schema `format` becomes response_format json_schema', async () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } } };
  const { sent } = await withFetch(oai({ content: '{"a":"b"}' }),
    () => toolChatLocalModel({ messages: [{ role: 'user', content: 'go' }], format: schema }));
  assert.equal(sent.response_format.type, 'json_schema');
  assert.deepEqual(sent.response_format.json_schema.schema, schema);
  assert.equal('format' in sent, false);
});

test('tool definitions pass straight through (both APIs use the same tool schema)', async () => {
  const tools = [{ type: 'function', function: { name: 'add_text', description: 'x', parameters: { type: 'object' } } }];
  const { sent } = await withFetch(oai({ content: '' }),
    () => toolChatLocalModel({ messages: [{ role: 'user', content: 'go' }], tools }));
  assert.deepEqual(sent.tools, tools);
});

test('an assistant tool call is sent with a STRING arguments field and an id', async () => {
  // Ollama hands them back as objects; OpenAI requires a JSON string and an id to match results to.
  const messages = [
    { role: 'user', content: 'add a heading' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'add_heading', arguments: { text: 'Hi' } } }] },
    { role: 'tool', tool_name: 'add_heading', content: 'done' },
  ];
  const { sent } = await withFetch(oai({ content: 'ok' }), () => toolChatLocalModel({ messages }));
  const call = sent.messages[1].tool_calls[0];
  assert.equal(typeof call.function.arguments, 'string', 'arguments must be a JSON string');
  assert.deepEqual(JSON.parse(call.function.arguments), { text: 'Hi' });
  assert.equal(call.type, 'function');
  assert.ok(call.id, 'a tool call must carry an id');
});

test('a tool RESULT is matched to the call it answers by id', async () => {
  // Without this the provider rejects the whole conversation: a tool message with no tool_call_id, or
  // one naming a call that was never made, is a 400 on every OpenAI-compatible provider.
  const messages = [
    { role: 'user', content: 'add a heading' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'add_heading', arguments: { text: 'Hi' } } }] },
    { role: 'tool', tool_name: 'add_heading', content: 'done' },
  ];
  const { sent } = await withFetch(oai({ content: 'ok' }), () => toolChatLocalModel({ messages }));
  const callId = sent.messages[1].tool_calls[0].id;
  assert.equal(sent.messages[2].role, 'tool');
  assert.equal(sent.messages[2].tool_call_id, callId, 'the result must point at that exact call');
  assert.equal('tool_name' in sent.messages[2], false, 'tool_name is Ollama-only');
});

test('a returned tool call comes back in OLLAMA shape, with arguments parsed to an object', async () => {
  // The callers (the assistant panel's loop) read Ollama's shape; the string would break them silently.
  const reply = oai({ content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'add_faq', arguments: '{"items":[{"question":"q","answer":"a"}]}' } }] });
  const { result } = await withFetch(reply, () => toolChatLocalModel({ messages: [{ role: 'user', content: 'go' }] }));
  const tc = result.message.tool_calls[0];
  assert.equal(tc.function.name, 'add_faq');
  assert.equal(typeof tc.function.arguments, 'object', 'arguments must be parsed back to an object');
  assert.deepEqual(tc.function.arguments.items[0], { question: 'q', answer: 'a' });
});

test('malformed tool arguments degrade to {} instead of throwing', async () => {
  const reply = oai({ content: '', tool_calls: [{ id: 'c', function: { name: 'f', arguments: 'not json' } }] });
  const { result } = await withFetch(reply, () => toolChatLocalModel({ messages: [{ role: 'user', content: 'go' }] }));
  assert.deepEqual(result.message.tool_calls[0].function.arguments, {});
});

test('the model list hides the classes that cannot do this job', async () => {
  // A provider catalogue is not a list of chat models. Offering the whole thing gives the person a menu
  // where most entries fail with errors that do not say why.
  const reply = ok({ data: [
    { id: 'vendor/chat-70b' }, { id: 'vendor/nv-embed-v2' }, { id: 'vendor/rerank-1' },
    { id: 'vendor/content-safety' }, { id: 'vendor/active-speaker-detection' },
    { id: 'vendor/synthetic-video-detector' }, { id: 'vendor/diffusion-26b' }, { id: 'vendor/instruct-8b' },
  ] });
  const { result, url } = await withFetch(reply, () => listEndpointModels());
  assert.equal(url, 'https://endpoint.example/v1/models');
  assert.deepEqual(result.models, ['vendor/chat-70b', 'vendor/instruct-8b']);
  assert.equal(result.other.length, 6, 'the rest are kept, but out of the way');
  assert.equal(result.count, 8);
});

test('a rejected key says so, rather than surfacing the provider raw', async () => {
  await assert.rejects(
    () => withFetch(err(401, 'unauthorized'), () => testLocalModel('hi')),
    (e) => /API key was rejected/i.test(e.message) && e.code === 503);
});

test('an unknown model names BOTH causes, because the base URL is the usual one', async () => {
  await assert.rejects(
    () => withFetch(err(404, 'not found'), () => testLocalModel('hi')),
    (e) => /does not know the model/i.test(e.message) && /base URL/i.test(e.message));
});

test('a rate limit is named as one', async () => {
  await assert.rejects(
    () => withFetch(err(429, 'too many requests'), () => testLocalModel('hi')),
    (e) => /rate-limiting/i.test(e.message));
});

test('status reports which transport a conversion would actually use', async () => {
  const s = await withFetch(ok({ models: [] }), () => localAiStatus());
  assert.equal(s.result.transport, 'endpoint');
  assert.equal(s.result.endpoint.configured, true);
  assert.equal(s.result.endpoint.hasKey, true);
  assert.equal(s.result.endpoint.model, 'vendor/model-70b');
  // The key itself must never reach the dashboard payload.
  assert.equal(JSON.stringify(s.result).includes('test-key'), false, 'the API key must not be sent to the UI');
});

test('an explicit AI_BACKEND=ollama beats a saved endpoint, both ways', async () => {
  // Otherwise a saved config silently overrides the override — and a developer's own ai-endpoint.json
  // would change what every other test in this folder exercises.
  process.env.AI_BACKEND = 'ollama';
  try {
    assert.equal(endpointActive(), false, 'forcing the local transport must disable the endpoint');
  } finally { delete process.env.AI_BACKEND; }
  assert.equal(endpointActive(), true, 'and removing the override restores it');
});

// ---- the backend switch (a persisted choice, not just an env var) ----

const { preferredBackend, setPreferredBackend, aiBackends, aiBackend } = await import('./to-ai.mjs');

test('the saved choice is honoured, and the env var still beats it', () => {
  // The env override has to keep working: scripts, CI and this suite rely on it.
  try {
    setPreferredBackend('off');
    assert.equal(preferredBackend(), 'off');
    assert.equal(aiBackend(), null, '"off" means spend nothing — no backend at all');
    process.env.AI_BACKEND = 'claude-code';
    assert.equal(preferredBackend(), 'claude-code', 'the environment wins over the saved choice');
  } finally { delete process.env.AI_BACKEND; setPreferredBackend(''); }
  assert.equal(preferredBackend(), '', 'cleared = automatic');
});

test('the aliases people actually type are accepted', () => {
  try {
    for (const [typed, stored] of [['auto', ''], ['cli', 'claude-code'], ['local', 'ollama'], ['none', 'off']]) {
      setPreferredBackend(typed);
      assert.equal(preferredBackend(), stored, `${typed} → ${stored || 'automatic'}`);
    }
  } finally { setPreferredBackend(''); }
});

test('an unknown backend is refused rather than silently ignored', () => {
  assert.throws(() => setPreferredBackend('gpt'), (e) => e.code === 400);
  assert.equal(preferredBackend(), '', 'and nothing is saved');
});

test('the switch reports availability, so it cannot offer a choice that falls back', () => {
  const st = aiBackends();
  const ids = st.backends.map((b) => b.id);
  assert.deepEqual(ids, ['', 'claude-code', 'api', 'endpoint', 'ollama', 'off']);
  // Automatic and Off are always possible; the rest depend on what is installed/configured.
  assert.equal(st.backends.find((b) => b.id === '').available, true);
  assert.equal(st.backends.find((b) => b.id === 'off').available, true);
  // This test file configures an endpoint via env, so that row must read as available and say so.
  const ep = st.backends.find((b) => b.id === 'endpoint');
  assert.equal(ep.available, true);
  assert.ok(ep.detail.includes('vendor/model-70b'), 'the row names the configured model');
  // Every unavailable row must explain itself — otherwise the UI greys out a choice with no reason.
  for (const b of st.backends) { if (!b.available) { assert.ok(b.why, `${b.id} must say why it is unavailable`); } }
});

test('picking the local model disables a saved endpoint', () => {
  // Otherwise choosing "Local model" in the UI would still route to the endpoint.
  try {
    setPreferredBackend('ollama');
    assert.equal(endpointActive(), false);
  } finally { setPreferredBackend(''); }
  assert.equal(endpointActive(), true);
});

// ---- the base URL: a choice, not a memory test ----

const { normalizeEndpointUrl, ENDPOINT_PRESETS } = await import('./to-ai.mjs');

test('a base URL is derived from whatever the person actually has', () => {
  // What people paste: the host from a signup page, or a whole curl example from the docs.
  assert.equal(normalizeEndpointUrl('api.example.com'), 'https://api.example.com/v1');
  assert.equal(normalizeEndpointUrl('https://api.example.com/'), 'https://api.example.com/v1');
  assert.equal(normalizeEndpointUrl('https://api.example.com/v1/chat/completions'), 'https://api.example.com/v1');
  assert.equal(normalizeEndpointUrl('https://api.example.com/v1/models'), 'https://api.example.com/v1');
  assert.equal(normalizeEndpointUrl('https://api.example.com/v1?key=x'), 'https://api.example.com/v1');
  assert.equal(normalizeEndpointUrl(''), '', 'empty stays empty — that clears the tier');
});

test('an explicit scheme is respected, so a LAN server is not forced to https', () => {
  assert.equal(normalizeEndpointUrl('http://localhost:1234/v1'), 'http://localhost:1234/v1');
  assert.equal(normalizeEndpointUrl('localhost:1234'), 'https://localhost:1234/v1', 'bare host assumes https');
});

test('a version segment that is NOT last is left alone', () => {
  // The bug this pins: anchoring the check to the end appends a second /v1 to `/v1/openai`,
  // producing a dead URL for one of the providers in the list below.
  assert.equal(normalizeEndpointUrl('https://api.example.com/v1/openai'), 'https://api.example.com/v1/openai');
  assert.equal(normalizeEndpointUrl('https://api.example.com/openai/v1'), 'https://api.example.com/openai/v1');
  assert.equal(normalizeEndpointUrl('https://api.example.com/inference/v1'), 'https://api.example.com/inference/v1');
});

test('every shipped preset survives normalisation unchanged', () => {
  // If a preset changes under normalisation, the dropdown would hand the person a URL the saver then
  // rewrites into something else — the irregular ones are exactly where that would bite.
  for (const p of ENDPOINT_PRESETS) {
    assert.equal(normalizeEndpointUrl(p.url), p.url, `${p.label} → ${p.url}`);
    assert.match(p.url, /^https?:\/\/[^/]+\/.+/, `${p.label} must be a full base URL`);
    assert.ok(['Hosted', 'On this computer'].includes(p.group), `${p.label} needs a known group`);
    assert.equal(typeof p.key, 'boolean', `${p.label} must say whether a key is needed`);
  }
  // The on-machine ones must not demand a key, or the panel nags for one they ignore.
  for (const p of ENDPOINT_PRESETS.filter((x) => x.group === 'On this computer')) {
    assert.equal(p.key, false, `${p.label} runs locally and needs no key`);
  }
});

// ---- probing: a listed model is not necessarily one YOUR key can call ----

const { probeEndpointModels } = await import('./to-ai.mjs');

/** A provider that lists everything but entitles only some of it. */
function provider(entitled, { rateLimitAll = false } = {}) {
  return async (_url, opts = {}) => {
    if (String(_url).endsWith('/models')) { return ok({ data: [] }); }
    if (rateLimitAll) { return err(429, 'Too Many Requests'); }
    const m = JSON.parse(opts.body).model;
    return entitled.includes(m) ? oai({ content: 'hi' })
      : err(404, '{"status":404,"detail":"Function \'abc\': Not found for account \'acct\'"}');
  };
}

test('the probe separates what the key can call from what is merely listed', async () => {
  const real = global.fetch;
  global.fetch = provider(['a/good', 'b/good']);
  try {
    const r = await probeEndpointModels({ models: ['a/good', 'b/good', 'c/locked', 'd/locked'] });
    assert.deepEqual(r.ok, ['a/good', 'b/good']);
    assert.equal(r.tested, 4);
    assert.equal(r.failed.length, 2);
    // The reason has to name the cause — "HTTP 404" alone sends people to re-check a correct URL.
    for (const f of r.failed) { assert.equal(f.reason, 'not available to your key'); }
  } finally { global.fetch = real; }
});

test('the probe sends ONE token and no tools — it is asking the status code, not the model', async () => {
  const real = global.fetch;
  let sent = null;
  global.fetch = async (_u, o = {}) => { if (o.body) { sent = JSON.parse(o.body); } return oai({ content: 'x' }); };
  try { await probeEndpointModels({ models: ['a/x'] }); } finally { global.fetch = real; }
  assert.equal(sent.max_tokens, 1);
  assert.equal('tools' in sent, false);
  assert.equal('response_format' in sent, false);
});

test('a run of rate limits aborts the sweep instead of mislabelling the rest', async () => {
  // Probing dozens of models is itself the most likely way to trip a free tier's limit, and a
  // rate-limited model must never be reported as a broken one.
  const real = global.fetch;
  global.fetch = provider([], { rateLimitAll: true });
  try {
    const r = await probeEndpointModels({ models: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], concurrency: 1 });
    assert.equal(r.aborted, true, 'the sweep stops');
    assert.ok(r.rateLimited >= 3);
    assert.equal(r.ok.length, 0);
    const limited = r.failed.filter((f) => /rate limited/.test(f.reason));
    assert.ok(limited.length >= 1, 'and says so rather than calling them unusable');
    assert.ok(r.failed.some((f) => f.reason === 'skipped'), 'the rest are skipped, not judged');
  } finally { global.fetch = real; }
});

// ---- the switcher names the PROVIDER, not "My endpoint" ----

const { endpointProviderLabel } = await import('./to-ai.mjs');

test('a saved base URL is named by its provider', () => {
  // "My endpoint" told the person nothing about which endpoint they were choosing — they think of it
  // as the provider they signed up with.
  assert.equal(endpointProviderLabel('https://integrate.api.nvidia.com/v1'), 'NVIDIA');
  assert.equal(endpointProviderLabel('https://api.groq.com/openai/v1'), 'Groq');
  assert.equal(endpointProviderLabel('http://localhost:1234/v1'), 'LM Studio');
  // A trailing slash must not defeat the match.
  assert.equal(endpointProviderLabel('https://integrate.api.nvidia.com/v1/'), 'NVIDIA');
});

test('a hand-typed endpoint falls back to its host, then to a generic name', () => {
  assert.equal(endpointProviderLabel('https://ai.example.com/v1'), 'ai.example.com');
  assert.equal(endpointProviderLabel('https://www.ai.example.com/v1'), 'ai.example.com');
  assert.equal(endpointProviderLabel('not a url'), 'Your own endpoint');
  assert.equal(endpointProviderLabel(''), '', 'nothing configured = no label');
});

test('the switcher rows carry those names', async () => {
  const st = aiBackends();
  // This file configures the endpoint by env to a made-up host, so it reads as that host.
  assert.equal(st.backends.find((b) => b.id === 'endpoint').label, 'endpoint.example');
  // And the local row names the model rather than saying "Local model" twice over.
  const local = st.backends.find((b) => b.id === 'ollama');
  assert.match(local.label, /^Local( · .+)?$/);
});

// ---- the probe result must SURVIVE a refresh, and "none" must be an answer ----

const { endpointProbe, setEndpointProbe, setEndpointConfig: setCfg } = await import('./to-ai.mjs');

test('a sweep is remembered, and keyed to the URL it measured', async () => {
  // Held only in the page, a refresh lost it and the picker silently showed the whole catalogue again
  // — indistinguishable from the filter breaking, and the retry burned quota.
  const prev = process.env.AI_ENDPOINT_URL; delete process.env.AI_ENDPOINT_URL;
  try {
    setCfg({ baseUrl: 'https://a.example/v1', key: 'k', model: 'a/one' });
    setEndpointProbe({ ok: ['a/one', 'a/two'], tested: 9, aborted: false });
    assert.deepEqual(endpointProbe().ok, ['a/one', 'a/two'], 'it survives being read back');
    assert.equal(endpointProbe().tested, 9);

    // Point the tier somewhere else: the old verdict is not evidence about the new provider.
    setCfg({ baseUrl: 'https://b.example/v1' });
    assert.equal(endpointProbe(), null, 'a different base URL drops the stale verdict');

    // ...and coming back does not resurrect it, because the config no longer carries it.
    setCfg({ baseUrl: 'https://a.example/v1' });
    assert.equal(endpointProbe(), null);
  } finally {
    setCfg({ baseUrl: '' });
    if (prev) { process.env.AI_ENDPOINT_URL = prev; }
  }
});

test('a rate-limited sweep is NOT remembered', async () => {
  // A partial sweep says nothing about the models it never reached; saving it would pin a wrong
  // answer until someone manually re-tested.
  const prev = process.env.AI_ENDPOINT_URL; delete process.env.AI_ENDPOINT_URL;
  const real = global.fetch;
  try {
    setCfg({ baseUrl: 'https://c.example/v1', key: 'k', model: 'c/one' });
    global.fetch = async () => err(429, 'Too Many Requests');
    const r = await probeEndpointModels({ models: ['a', 'b', 'c', 'd'], concurrency: 1 });
    assert.equal(r.aborted, true);
    assert.equal(endpointProbe(), null, 'an aborted sweep leaves no stored verdict');
  } finally {
    global.fetch = real; setCfg({ baseUrl: '' });
    if (prev) { process.env.AI_ENDPOINT_URL = prev; }
  }
});

test('a completed sweep that found NOTHING is still stored as a result', async () => {
  // This is the case that used to fall back to the unfiltered catalogue.
  const prev = process.env.AI_ENDPOINT_URL; delete process.env.AI_ENDPOINT_URL;
  const real = global.fetch;
  try {
    setCfg({ baseUrl: 'https://d.example/v1', key: 'k', model: 'd/one' });
    global.fetch = async () => err(404, '{"detail":"Function \'x\': Not found for account \'y\'"}');
    const r = await probeEndpointModels({ models: ['a', 'b'], concurrency: 1 });
    assert.equal(r.ok.length, 0);
    assert.equal(r.aborted, false);
    const stored = endpointProbe();
    assert.ok(stored, 'an empty result is still a result');
    assert.deepEqual(stored.ok, []);
    assert.equal(stored.tested, 2);
  } finally {
    global.fetch = real; setCfg({ baseUrl: '' });
    if (prev) { process.env.AI_ENDPOINT_URL = prev; }
  }
});
