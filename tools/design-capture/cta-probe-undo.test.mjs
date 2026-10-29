// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * PROBING A BAR THAT TURNS OUT NOT TO BE TABS MUST LEAVE THE PAGE AS IT WAS FOUND.
 *
 * revealTabPanels() identifies a candidate tab bar loosely on purpose — 2-5 button-ish children with short
 * labels and nothing else in the bar — because real tabs are routinely plain <button>s with no ARIA at all
 * (see the tab-stamp fixture, which is exactly that shape). Requiring role="tab" / aria-selected / .active
 * would lose genuine tabs, so the looseness is deliberate.
 *
 * The price of that looseness is that a CALL-TO-ACTION PAIR matches the same predicate, and clicking a CTA
 * does not toggle a panel — it changes the page irreversibly. Measured on a captured source, BOTH of its
 * matches were false positives, and neither carried a single tab marker:
 *
 *     ["BOOK NOW", "VIEW SERVICES"]          clicking BOOK NOW mounted a booking MODAL
 *                                            (<form> 0 -> 1, <select> 3 -> 6, "Online Reservation" 0 -> 1)
 *     ["Monthly Billing", "AnnualSAVE 15%"]  clicking Annual switched every membership price
 *                                            ($95/$180/$320 -> $81/$153/$272)
 *
 * The groups were correctly REJECTED afterwards (their "panels" did not differ) and their markers stripped,
 * which is why no data-sc-tab appeared in the output and the cause stayed hidden. But the CLICKS were never
 * undone, so rendered.html held a modal the live page never shows and the wrong prices — and the converter
 * faithfully built both into the site: an invented 913px booking band, 13% of the converted page's height,
 * and three wrong headline prices.
 *
 * Clicking back to the originally-active index is not a safe undo on a CTA pair — that merely clicks the
 * other call to action. Reloading is, and that is what is asserted here.
 *
 * This can only be proven end-to-end: the bug is not in a predicate but in what the page looks like at
 * serialization time, after the probe has run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/* A hero CTA pair — the exact shape revealTabPanels() cannot tell from a tab bar. The second button mounts
   a dialog into <body>, the way a real booking modal does, so a click leaves content behind that the page
   does not otherwise show. Nothing here carries a tab marker, because the real sources did not either. */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>CTA fixture</title><style>
body{font-family:system-ui;margin:0;background:#fff;color:#111}
section{padding:48px}
.cta{display:flex;gap:12px}
.cta button{padding:10px 18px;border:1px solid #ccc;background:#f4f4f4}
/* an ORDINARY in-flow block, deliberately NOT a full-screen fixed overlay. A fixed, inset-0 modal
   sends the capture down its scroll-story / fixed-overlay extraction path and the child never
   finished - it timed out at 900s even run sequentially, while the real site captures in ~20s.
   What this fixture has to prove is only that content MOUNTED BY A CLICK is not serialized. */
#modal{background:#fff;padding:32px;border:1px solid #ddd}
h1{font-size:40px;margin:0 0 16px}
</style></head><body>
<main><section>
<h1>Cut Craft Confidence</h1>
<p>Precision cuts and expert grooming in the city.</p>
<div class="cta"><button id="c0">Book Now</button><button id="c1">View Services</button></div>
</section>
<section><h2>Our Services</h2><p>Haircut, beard trim and hot towel shave.</p></section>
</main>
<script>
document.getElementById('c0').addEventListener('click', function(){
  if (document.getElementById('modal')) return;
  var d = document.createElement('div');
  d.id = 'modal';
  d.innerHTML = '<h2>Online Reservation</h2><form><label>Service<select><option>Haircut</option><option>Beard trim</option></select></label><button type="submit">Confirm Booking</button></form>';
  document.body.appendChild(d);
});
document.getElementById('c1').addEventListener('click', function(){ /* a plain CTA: no panel toggles */ });
</script></body></html>`;

test('a CTA pair mistaken for tabs leaves no modal behind in the capture', async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-ctaundo-'));
  try {
    await run(process.execPath, ['capture.mjs', `http://127.0.0.1:${port}/`, out, '--max-pages', '1'],
      // Generous: proving this fix REQUIRES the capture to run renderPage twice (probe, then a clean
      // re-capture), and `node --test` runs files in parallel, so the child competes for CPU with the
      // rest of the suite. A 300s budget was hit exactly (duration_ms 300096) by the timeout, not by a
      // failed assertion.
      { cwd: import.meta.dirname, timeout: 900000, maxBuffer: 64 * 1024 * 1024 });

    const dir = fs.readdirSync(out).find((d) => fs.existsSync(path.join(out, d, 'rendered.html')));
    assert.ok(dir, 'the capture wrote a rendered.html');
    const html = fs.readFileSync(path.join(out, dir, 'rendered.html'), 'utf8');

    // ASK THE QUESTION OF THE DOM, NOT OF THE SOURCE TEXT.
    //
    // rendered.html serializes the whole document, <script> tags included — and this fixture's script
    // holds the modal's markup as a STRING (`d.innerHTML = '<h2>Online Reservation</h2><form>…'`),
    // because that is how a real page mounts one. A plain `html.includes('Online Reservation')`
    // therefore matches the *recipe* for the modal whether or not the modal was ever opened, so the
    // assertion failed on a capture that had undone the probe perfectly: no modal element, no form,
    // and both hero and services intact. It was reporting the fixture's own script back at us.
    //
    // Strip script/style first and the question becomes the one actually being asked: is the probe's
    // leftover in the page a visitor would see?
    const dom = html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');

    // The page's own content must still be there — the undo must restore, not truncate.
    assert.ok(dom.includes('Cut Craft Confidence'), 'the hero survived the reload');
    assert.ok(dom.includes('Our Services'), 'the rest of the page survived too');

    // …and nothing the probe's clicks created may be in it.
    assert.ok(!dom.includes('Online Reservation'),
      'the modal opened by the probe click must not be serialized');
    assert.ok(!dom.includes('Confirm Booking'),
      'nor its submit button');
    assert.ok(!/<form\b/i.test(dom),
      'the page has no form of its own, so a form in the output can only have come from the probe');
    assert.ok(!/\bid=["']modal["']/i.test(dom),
      'and the modal element itself is absent — the strongest form of the check');
  } finally {
    server.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});
