// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * AN AUTOPLAYING CLIP DOES NOT DEFER ITS OWN BYTES — the JS twin of the PHP [VP] golden.
 *
 * Both engines emitted preload="metadata" for every converted video. A clip that autoplays starts the
 * moment it can, so `metadata` buys nothing and costs the whole wait: the browser fetches the header,
 * stops, and only then goes back for the media. Measured on a real conversion over a 205 KB/s host that
 * was 12.4s of empty hero. A clip the visitor must press play on still defers.
 *
 * PHP twin: n_video() in class-fw-site-converter-mapper.php.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(path.join(import.meta.dirname, 'to-pages.mjs'), 'utf8');

/** The one expression that decides it, lifted from the source so the test cannot drift from the rule. */
function preloadRule() {
  const m = /preload:\s*\(b\.autoplay === 'yes'\)\s*\?\s*'([a-z]+)'\s*:\s*'([a-z]+)'/.exec(SRC);
  assert.ok(m, 'to-pages.mjs no longer derives preload from b.autoplay — the twin has drifted from the PHP rule');
  return { whenAutoplay: m[1], otherwise: m[2] };
}

test('an autoplaying clip preloads in full', () => {
  assert.equal(preloadRule().whenAutoplay, 'auto');
});

test('NEGATIVE: a clip the visitor must start still defers its bytes', () => {
  assert.equal(preloadRule().otherwise, 'metadata');
});
