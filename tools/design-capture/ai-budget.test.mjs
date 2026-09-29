/**
 * Guards for the shared AI time budget.
 *
 * The bug: every AI pass read `AI_TIMEOUT_MS || 120000` independently while the whole capture had a 300s
 * watchdog, so one optional cosmetic pass could spend 40% of the capture budget. A real run did exactly
 * that — "naming box presets" burned 120s, failed with "Could not reach Ollama", and "naming sections"
 * then started 6s before the watchdog fired and threw away 294s of completed work. The conversion produced
 * nothing, and the failure read as "the site was too big" when it was "a pretty-naming call hung".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setAiDeadline, aiBudgetLeft, aiTimeout } from './to-ai.mjs';

test('with no budget open, a pass keeps its own default', () => {
  setAiDeadline(0);
  assert.equal(aiBudgetLeft(), Infinity);
  // Still capped per call — one pass must never be able to swallow a whole capture, budget or not.
  assert.equal(aiTimeout(120000), 30000);
});

test('a single pass can never exceed the per-call cap', () => {
  setAiDeadline(300000);
  assert.equal(aiTimeout(120000), 30000, '120s default is clamped to the 30s per-call cap');
  assert.equal(aiTimeout(5000), 5000, 'a pass asking for less than the cap keeps its own value');
});

test('the budget clamps a pass once most of it is spent', () => {
  setAiDeadline(4000);
  const t = aiTimeout(120000);
  assert.ok(t <= 4000, `expected <= 4000, got ${t}`);
  assert.ok(t > 0);
});

test('a spent budget yields an immediate abort, not a hang', () => {
  // 1ms rather than 0: the fetch aborts at once and each call site's existing catch reports a skip.
  // Skipping a naming pass costs a nicer preset label; overrunning the watchdog costs the conversion.
  setAiDeadline(1);
  const t = aiTimeout(120000);
  assert.ok(t >= 1 && t <= 2, `expected an immediate deadline, got ${t}`);
});

test('the budget drains over time rather than resetting per pass', async () => {
  setAiDeadline(1000);
  const first = aiBudgetLeft();
  await new Promise((r) => setTimeout(r, 120));
  const second = aiBudgetLeft();
  assert.ok(second < first, 'budget must be shared across passes, not refreshed by each one');
});

test('AI_CALL_MAX_MS overrides the per-call cap', () => {
  const prev = process.env.AI_CALL_MAX_MS;
  process.env.AI_CALL_MAX_MS = '5000';
  try {
    setAiDeadline(300000);
    assert.equal(aiTimeout(120000), 5000);
  } finally {
    if (prev === undefined) delete process.env.AI_CALL_MAX_MS; else process.env.AI_CALL_MAX_MS = prev;
  }
});

test('the budget bounds a run by ELAPSED time, so passes cannot accumulate past it', async () => {
  // A subtlety worth pinning, because the first version of this test asserted the wrong thing: the budget
  // drains by wall clock, not by what each pass was GRANTED. Ten instantaneous calls each get the full cap
  // and that is correct — a pass that returned at once consumed nothing. What must hold is that once the
  // deadline has actually passed, every later pass is immediate, so a run cannot creep toward the watchdog.
  setAiDeadline(60);
  assert.ok(aiTimeout(120000) > 1, 'inside the budget, a pass still gets real time');
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(aiTimeout(120000), 1, 'past the deadline every pass aborts immediately');
  assert.equal(aiTimeout(5000), 1, 'including a pass that only wanted a little');
});
