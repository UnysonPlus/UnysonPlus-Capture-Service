// Browser-free, model-free unit tests for the SCOPED local job (refineSectionsLight's apply logic) and the
// "test the model" handler shape. No live GPU/Ollama needed — the model call is mocked via global.fetch.
// Run: node --test local-ai-light.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

// Force a selected local model without touching local-ai.json (selectedLocalModel prefers OLLAMA_MODEL).
process.env.OLLAMA_MODEL = 'test:1b';

// Force the local (Ollama) backend deterministically regardless of what's installed on the test machine.
process.env.AI_BACKEND = 'ollama';

const { summarizeSections, applySectionsLight, testLocalModel, chatLocalModel, localAiStatus } = await import('./to-ai.mjs');

// Warm the internal "_ollamaUp" flag so ollamaReady()/aiBackend() route to the local backend even when
// the `ollama` binary isn't on PATH here. localAiStatus() probes /api/tags — mock it to report up.
async function warmOllamaUp() {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ models: [{ name: 'test:1b' }] }) });
  try { await localAiStatus(); } finally { global.fetch = realFetch; }
}
await warmOllamaUp();

// A tiny draft mapping: a real hero (heading+text), an EMPTY decorative spacer, and a real cards section.
function draft() {
  return { pages: [ { title: 'Home', slug: 'home', front_page: true, sections: [
    { css_id: 'section-0', omit: false, blocks: [ { t: 'h', role: 'title', text: 'Welcome' }, { t: 'p', role: 'text', text: 'Some intro copy.' } ] },
    { css_id: 'section-1', omit: false, blocks: [ { t: 'div', role: 'skip', html: '' } ] }, // empty spacer
    { css_id: 'section-2', omit: false, blocks: [ { t: 'p', role: 'text', text: 'Real content here.' }, { t: 'row', role: 'columns', cols: [{}, {}] } ] },
  ] } ] };
}

test('summarizeSections flattens sections with a stable global index', () => {
  const s = summarizeSections(draft());
  assert.equal(s.length, 3);
  assert.deepEqual(s.map((x) => x.index), [0, 1, 2]);
  assert.equal(s[0].heading, 'Welcome');
  assert.ok(s[0].textLen > 0);
  assert.ok(Array.isArray(s[0].blockKinds));
});

test('applySectionsLight applies ONLY valid slugs', () => {
  const m = draft();
  const changes = applySectionsLight(m, { sections: [
    { index: 0, css_id: 'hero', decorative: false },        // valid → applied
    { index: 2, css_id: 'Features Grid!', decorative: false }, // invalid (space + '!' + caps) → rejected
  ] });
  assert.equal(m.pages[0].sections[0].css_id, 'hero');       // valid slug applied
  assert.equal(m.pages[0].sections[2].css_id, 'section-2');  // invalid slug rejected → unchanged
  assert.equal(changes.renamed, 1);
});

test('applySectionsLight omits a decorative section ONLY when it has no real content', () => {
  const m = draft();
  const changes = applySectionsLight(m, { sections: [
    { index: 1, css_id: 'spacer', decorative: true },  // empty → may omit
    { index: 2, css_id: 'cards', decorative: true },   // decorative BUT has content → must NOT omit
  ] });
  assert.equal(m.pages[0].sections[1].omit, true, 'empty decorative section omitted');
  assert.notEqual(m.pages[0].sections[2].omit, true, 'decorative-with-content is NEVER omitted');
  assert.equal(changes.decorative, 1);
});

test('applySectionsLight never drops content blocks', () => {
  const m = draft();
  const before = m.pages[0].sections.map((s) => s.blocks.length);
  applySectionsLight(m, { sections: [ { index: 0, css_id: 'hero', decorative: true }, { index: 2, css_id: 'cards', decorative: true } ] });
  const after = m.pages[0].sections.map((s) => s.blocks.length);
  assert.deepEqual(after, before, 'block counts unchanged — content preserved');
});

test('applySectionsLight tolerates junk model output (missing/extra indices)', () => {
  const m = draft();
  const changes = applySectionsLight(m, { sections: [ { index: 99, css_id: 'nope', decorative: true }, { foo: 'bar' } ] });
  assert.equal(changes.renamed, 0);
  assert.equal(changes.decorative, 0);
});

test('testLocalModel returns { ok, model, reply, ms } (mocked fetch)', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ message: { content: 'Hello there!' } }) });
  try {
    const r = await testLocalModel('hi');
    assert.equal(r.ok, true);
    assert.equal(r.model, 'test:1b');
    assert.equal(r.reply, 'Hello there!');
    assert.equal(typeof r.ms, 'number');
  } finally { global.fetch = realFetch; }
});

test('testLocalModel strips <think> blocks from the reply', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ message: { content: '<think>reasoning…</think>Done.' } }) });
  try {
    const r = await testLocalModel('hi');
    assert.equal(r.reply, 'Done.');
  } finally { global.fetch = realFetch; }
});

// ---- chatLocalModel (multi-turn chat on the local backend) ----

test('chatLocalModel returns { ok, model, reply, ms } (mocked fetch)', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ message: { content: 'Hi back!' } }) });
  try {
    const r = await chatLocalModel({ messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(r.ok, true);
    assert.equal(r.model, 'test:1b');
    assert.equal(r.reply, 'Hi back!');
    assert.equal(typeof r.ms, 'number');
  } finally { global.fetch = realFetch; }
});

test('chatLocalModel strips reasoning and sends a system + the turns', async () => {
  const realFetch = global.fetch;
  let sent = null;
  global.fetch = async (_url, opts) => { sent = JSON.parse(opts.body); return { ok: true, json: async () => ({ message: { content: '</think>Answer.' } }) }; };
  try {
    const r = await chatLocalModel({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] });
    assert.equal(r.reply, 'Answer.');                        // stripReasoning applied
    assert.equal(sent.messages[0].role, 'system');           // system prompt prepended
    assert.equal(sent.messages.length, 4);                   // system + 3 turns
    assert.equal(sent.think, false);
    assert.equal(sent.options.temperature, 0);
  } finally { global.fetch = realFetch; }
});

test('chatLocalModel caps context to the last 12 turns', async () => {
  const realFetch = global.fetch;
  let sent = null;
  global.fetch = async (_url, opts) => { sent = JSON.parse(opts.body); return { ok: true, json: async () => ({ message: { content: 'ok' } }) }; };
  try {
    const many = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i }));
    await chatLocalModel({ messages: many });
    // system + last 12 turns = 13 messages; the newest turn must be the last one sent.
    assert.equal(sent.messages.length, 13);
    assert.equal(sent.messages[sent.messages.length - 1].content, 'm29');
  } finally { global.fetch = realFetch; }
});

test('chatLocalModel rejects an empty message list', async () => {
  await assert.rejects(() => chatLocalModel({ messages: [] }), /No message to send/);
});
