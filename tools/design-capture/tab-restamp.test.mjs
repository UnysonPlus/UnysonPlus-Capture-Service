// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * A TAB PANEL REVEALED BY CLICKING MUST BE STAMPED.
 *
 * The computed-style pass runs once, while only the ACTIVE panel exists in the DOM. revealTabPanels()
 * then clicks each tab and keeps what it finds — but those nodes are rendered AFTER the pass, so they
 * carried no data-sc-cs, and an unstamped subtree is invisible to the converter.
 *
 * Measured on a captured menu page: panel 0 was 459/459 stamped, panel 1 was 5/301, and 3,780 characters
 * of the second panel were dropped. This is ORDER, not a rule — so the only test that can prove it is an
 * end-to-end capture. A unit test over a copy of the stamping logic would pass either way.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// execFileSync would block this process's event loop — and the fixture server runs in it, so the capture
// could never be served and every run timed out. The child must be awaited, not waited on.
const run = promisify(execFile);

/* Only the ACTIVE panel is in the DOM — the shape of a React/Vue tab widget, and the whole point. */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Tab fixture</title><style>
body{font-family:system-ui;margin:0;background:#fff;color:#111}
.bar{display:flex;gap:8px;padding:16px}
.bar button{padding:8px 16px;border-radius:9999px;border:1px solid #ccc;background:#f4f4f4}
.wrap{padding:24px}.card{background:#f0f0f0;border-radius:12px;padding:16px;margin:8px 0}
h3{font-size:20px;margin:0 0 8px}
</style></head><body>
<main><section><div class="bar"><button id="t0">First Panel</button><button id="t1">Second Panel</button></div>
<div class="wrap" id="wrap"></div></section></main>
<script>
var P = {
  0: '<h3>First Panel Heading</h3><div class="card"><h3>Alpha Item One</h3><p>Alpha item one description line.</p></div><div class="card"><h3>Alpha Item Two</h3><p>Alpha item two description line.</p></div>',
  1: '<h3>Second Panel Heading</h3><div class="card"><h3>Beta Item One</h3><p>Beta item one description line.</p></div><div class="card"><h3>Beta Item Two</h3><p>Beta item two description line.</p></div>'
};
function show(i){ document.getElementById('wrap').innerHTML = P[i]; }
document.getElementById('t0').addEventListener('click', function(){ show(0); });
document.getElementById('t1').addEventListener('click', function(){ show(1); });
show(0);
</script></body></html>`;

test('every revealed tab panel is stamped, not just the one that was active', async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-tabstamp-'));
  try {
    await run(process.execPath, ['capture.mjs', `http://127.0.0.1:${port}/`, out, '--max-pages', '1'],
      { cwd: import.meta.dirname, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });

    const dir = fs.readdirSync(out).find((d) => fs.existsSync(path.join(out, d, 'rendered.html')));
    assert.ok(dir, 'the capture wrote a rendered.html');
    const html = fs.readFileSync(path.join(out, dir, 'rendered.html'), 'utf8');

    // Both panels must exist…
    const panels = [...html.matchAll(/<div[^>]*role="tabpanel"[^>]*>/g)];
    assert.ok(panels.length >= 2, `expected 2+ tab panels, got ${panels.length}`);
    // …and the SECOND panel's content must be present AND stamped. Presence alone was never the defect:
    // the markup was always cloned correctly; it was the stamps that were missing.
    assert.ok(html.includes('Beta Item Two'), 'the second panel\'s content survived');
    const beta = html.slice(html.indexOf('Second Panel Heading'));
    const seg = beta.slice(0, beta.indexOf('Beta Item Two') + 400);
    const els = (seg.match(/<(?:div|h3|p)\b/g) || []).length;
    const stamped = (seg.match(/data-sc-cs=/g) || []).length;
    assert.ok(els > 0, 'the second panel holds elements to stamp');
    assert.ok(stamped >= els - 1,
      `second panel stamped ${stamped}/${els} — a revealed panel must be stamped like the active one`);
  } finally {
    server.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});
