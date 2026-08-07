// Browser-free, GPU-free unit tests for the user-directed tweak feature (POST /ai-instruct → instructTweak).
// Covers the CSS SANITIZER (the security/trust boundary), the response-shape normalizer, and instructTweak
// end-to-end with the model call MOCKED via global.fetch (Anthropic API backend), like local-ai-light.test.mjs.
// Run: node --test ai-instruct.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

const { sanitizeTweakCss, normalizeInstructResult, instructTweak } = await import('./to-ai.mjs');

/* ---- The CSS sanitizer — the trust boundary ---- */

test('sanitizeTweakCss keeps valid CSS rules intact', () => {
  const css = '#hero { background: #111; padding: 40px; } .sc-button { border-radius: 999px; }';
  assert.equal(sanitizeTweakCss(css), css);
});

test('sanitizeTweakCss strips <script> and <style> tags (and their contents)', () => {
  const out = sanitizeTweakCss('#a{color:red}<script>alert(1)</script><style>#b{}</style>#c{color:blue}');
  assert.ok(!/script/i.test(out), 'no script');
  assert.ok(!/alert/i.test(out), 'script contents removed');
  assert.ok(out.includes('#a{color:red}'));
  assert.ok(out.includes('#c{color:blue}'));
});

test('sanitizeTweakCss drops @import', () => {
  const out = sanitizeTweakCss('@import url("https://evil.example/x.css");\n#a{color:red}');
  assert.ok(!/@import/i.test(out), '@import removed');
  assert.ok(out.includes('#a{color:red}'));
});

test('sanitizeTweakCss neutralizes javascript: and expression()', () => {
  const out = sanitizeTweakCss('#a{background:javascript:alert(1);width:expression(alert(1))}');
  assert.ok(!/javascript:/i.test(out));
  assert.ok(!/expression\s*\(/i.test(out));
});

test('sanitizeTweakCss drops OFF-ORIGIN url() but keeps data: and same-origin refs', () => {
  const out = sanitizeTweakCss(
    '.a{background:url(https://evil.example/x.png)}' +
    '.b{background:url(//cdn.evil/x.png)}' +
    '.c{background:url("/uploads/local.png")}' +
    '.d{background:url(assets/rel.png)}' +
    '.e{background:url(data:image/png;base64,AAAA)}'
  );
  assert.ok(!/evil/i.test(out), 'off-origin hosts stripped');
  assert.ok(out.includes('url("/uploads/local.png")') || out.includes('url(/uploads/local.png)'), 'root-relative kept');
  assert.ok(out.includes('assets/rel.png'), 'relative kept');
  assert.ok(out.includes('data:image/png;base64,AAAA'), 'data: kept');
});

test('sanitizeTweakCss caps length at 20 KB', () => {
  const big = '#a{color:red}'.repeat(5000); // ~65 KB
  assert.ok(sanitizeTweakCss(big).length <= 20000);
});

test('sanitizeTweakCss tolerates junk input', () => {
  assert.equal(sanitizeTweakCss(null), '');
  assert.equal(sanitizeTweakCss(undefined), '');
  assert.equal(sanitizeTweakCss(123), '123'.replace(/[^]/g, (c) => c)); // number → its string, unchanged
});

/* ---- Response-shape normalizer ---- */

test('normalizeInstructResult: css kind clears the structural note', () => {
  const r = normalizeInstructResult({ kind: 'css', css: '#a{color:red}', structural_note: 'ignored', explanation: 'darkened it' });
  assert.equal(r.kind, 'css');
  assert.equal(r.structural_note, '');
  assert.ok(r.css.includes('#a{color:red}'));
});

test('normalizeInstructResult: structural kind NEVER emits css', () => {
  const r = normalizeInstructResult({ kind: 'structural', css: '#a{color:red}', structural_note: 'make a pricing table', explanation: 'needs structure' });
  assert.equal(r.kind, 'structural');
  assert.equal(r.css, '', 'structural never auto-applies CSS');
  assert.equal(r.structural_note, 'make a pricing table');
});

test('normalizeInstructResult infers kind when missing (css present)', () => {
  const r = normalizeInstructResult({ css: '#a{color:red}', structural_note: '', explanation: '' });
  assert.equal(r.kind, 'css');
  assert.ok(r.explanation, 'a fallback explanation is filled in');
});

test('normalizeInstructResult infers structural when only a note is present', () => {
  const r = normalizeInstructResult({ structural_note: 'add a testimonials section', explanation: '' });
  assert.equal(r.kind, 'structural');
  assert.equal(r.css, '');
});

test('normalizeInstructResult sanitizes css through the boundary', () => {
  const r = normalizeInstructResult({ kind: 'css', css: '<script>x</script>#a{color:red}', structural_note: '', explanation: 'x' });
  assert.ok(!/script/i.test(r.css));
  assert.ok(r.css.includes('#a{color:red}'));
});

test('normalizeInstructResult tolerates a non-object', () => {
  const r = normalizeInstructResult(null);
  assert.ok(['css', 'structural', 'both'].includes(r.kind));
  assert.equal(typeof r.explanation, 'string');
});

/* ---- instructTweak end-to-end with the model MOCKED (Anthropic API backend) ---- */

// Force the API backend so the model call goes through fetch(api.anthropic.com), which we mock.
process.env.AI_BACKEND = 'api';
process.env.ANTHROPIC_API_KEY = 'test-key';

function mockAnthropic(jsonText) {
  return async () => ({ ok: true, json: async () => ({ content: [{ text: jsonText }] }) });
}

test('instructTweak rejects an empty prompt (400)', async () => {
  await assert.rejects(() => instructTweak({ prompt: '   ' }), (e) => e.code === 400);
});

test('instructTweak returns a sanitized CSS result (mocked model)', async () => {
  const realFetch = global.fetch;
  global.fetch = mockAnthropic(JSON.stringify({
    kind: 'css',
    css: '#hero{background:#000}<script>bad()</script>',
    structural_note: '',
    explanation: 'Darkened the hero background.',
  }));
  try {
    const r = await instructTweak({ prompt: 'make the hero darker', pageHtml: '<div id="hero"></div>' });
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'css');
    assert.ok(r.css.includes('#hero{background:#000}'));
    assert.ok(!/script/i.test(r.css), 'sanitizer applied on the way out');
    assert.equal(r.structural_note, '');
    assert.equal(r.backend, 'api');
  } finally { global.fetch = realFetch; }
});

test('instructTweak passes through a structural note without css (mocked model)', async () => {
  const realFetch = global.fetch;
  global.fetch = mockAnthropic(JSON.stringify({
    kind: 'structural',
    css: '#x{color:red}',
    structural_note: 'Convert the pricing area into a real pricing table shortcode.',
    explanation: 'This needs a structural change.',
  }));
  try {
    const r = await instructTweak({ prompt: 'make this a real pricing table', pageHtml: '<div class="prices"></div>' });
    assert.equal(r.kind, 'structural');
    assert.equal(r.css, '', 'structural never auto-applies CSS');
    assert.ok(r.structural_note.includes('pricing table'));
  } finally { global.fetch = realFetch; }
});

test('instructTweak tolerates a model reply wrapped in prose/fences', async () => {
  const realFetch = global.fetch;
  global.fetch = mockAnthropic('Sure! ```json\n{"kind":"css","css":"#a{color:red}","structural_note":"","explanation":"ok"}\n``` done');
  try {
    const r = await instructTweak({ prompt: 'red text', pageHtml: '<div id="a"></div>' });
    assert.equal(r.kind, 'css');
    assert.ok(r.css.includes('#a{color:red}'));
  } finally { global.fetch = realFetch; }
});
