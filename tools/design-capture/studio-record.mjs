// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Kinetic Scenes' screencast recorder: runs a list of steps in a real browser, the way a person would (a visible
// cursor with click ripples, curved mouse moves, letter-by-letter typing, real drags), and records it as a sharp video
// (2x, from Chrome's own frame stream, carried across page loads, with the waiting cut out). Beside the video it writes
// actions.json: when each step happened in the video and where its target was on screen, so a reel can zoom to it.
//
// A step may carry "about": a sentence on what it does and why, for the narration studio-narrate.mjs writes.
//
// Steps are plain ({ do: 'click', target }) or Unyson+ actions (wp.publish publishes; wp.view opens the published page;
// le.* drive the Live Editor, whose page sits in a frame: target it with { frame: true, … }) ({ do: 'pb.add', element: 'special_heading' }) that
// already know the WordPress admin and the page builder. A target is a Playwright selector string, { text }, { role,
// name }, { label } or { pb: … } (see target()).
//
//   node studio-cli.mjs record steps.json [--out folder]

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CURSOR = `(() => {
  const css = document.createElement('style');
  css.textContent = '#__rc{position:fixed;left:0;top:0;width:24px;height:24px;z-index:2147483647;pointer-events:none;transform:translate(-3px,-2px);transition:transform .08s}'
    + '#__rc svg{filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}'
    + '.__rr{position:fixed;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;border:3px solid #6b4cf6;z-index:2147483646;pointer-events:none;animation:__rr .55s ease-out forwards}'
    + '@keyframes __rr{to{transform:scale(4.2);opacity:0}}' + (window.__hide || '');
  const add = () => {
    if (document.getElementById('__rc')) return;
    document.head.appendChild(css);
    const c = document.createElement('div'); c.id = '__rc';
    c.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M4 2 L4 19 L8.5 15 L11.5 22 L14.5 20.7 L11.6 14 L18 14 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.body.appendChild(c);
    let xy = [-50, -50]; try { xy = JSON.parse(sessionStorage.getItem('__rxy')) || xy; } catch {}
    c.style.left = xy[0] + 'px'; c.style.top = xy[1] + 'px';
    addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; try { sessionStorage.setItem('__rxy', JSON.stringify([e.clientX, e.clientY])); } catch {} }, true);
    addEventListener('mousedown', (e) => { c.style.transform = 'translate(-3px,-2px) scale(.85)'; const r = document.createElement('div'); r.className = '__rr'; r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px'; document.body.appendChild(r); setTimeout(() => r.remove(), 600); }, true);
    addEventListener('mouseup', () => { c.style.transform = 'translate(-3px,-2px)'; }, true);
  };
  if (document.body) add(); else addEventListener('DOMContentLoaded', add);
})();`;
// Admin noise that dates a recording or distracts from it.
const HIDE = '.notice,.update-nag,#wpfooter,.fw-brz-dismiss,#screen-meta-links,.primary-menu-notice{display:none!important}';

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

function run(cmd, args) {
  return new Promise((ok, bad) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('exit', (c) => (c === 0 ? ok() : bad(new Error(`${cmd} failed: ${err.trim().split('\n').pop()}`))));
    p.on('error', bad);
  });
}

/**
 * Records a step list. spec: { site, login?: { user, pass }, start?: path, viewport?: [w, h], scale?: 2, steps: [] }.
 * Returns { video, actions, seconds, width, height }.
 */
export async function record(spec, outDir, onStep = () => {}) {
  const out = resolve(outDir);
  const framesDir = join(out, 'frames');
  rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });
  const [vw, vh] = spec.viewport || [1600, 900];
  const scale = spec.scale || 2;
  const site = String(spec.site || '').replace(/\/$/, '');
  const browser = await chromium.launch({ channel: process.env.CAPTURE_CHANNEL || 'chrome', headless: true, args: [`--force-device-scale-factor=${scale}`] });
  const actions = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: scale });
    await ctx.addInitScript(`window.__hide = ${JSON.stringify(HIDE + (spec.hide || ''))};`);
    await ctx.addInitScript(CURSOR);
    const p = await ctx.newPage();
    p.setDefaultTimeout(20000);

    // Off camera: log in and open the starting page.
    if (spec.login) {
      await p.goto(`${site}/wp-login.php`);
      await p.fill('#user_login', spec.login.user); await p.fill('#user_pass', spec.login.pass);
      await Promise.all([p.waitForNavigation({ waitUntil: 'load' }).catch(() => {}), p.click('#wp-submit')]);
    }
    if (spec.start) await p.goto(site + spec.start, { waitUntil: 'load', timeout: 90000 });
    await sleep(800);

    // The recording: frames with their times; loading spans are cut out afterwards.
    const frames = [];
    const skips = [];
    let cdp = null, n = 0;
    const startCast = async () => {
      cdp = await ctx.newCDPSession(p);
      cdp.on('Page.screencastFrame', (f) => {
        const name = `f${String(n++).padStart(6, '0')}.jpg`;
        writeFileSync(join(framesDir, name), Buffer.from(f.data, 'base64'));
        frames.push({ name, t: f.metadata.timestamp });
        cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      });
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: vw * scale, maxHeight: vh * scale, everyNthFrame: 1 });
    };
    const stopCast = async () => { try { await cdp?.send('Page.stopScreencast'); await cdp?.detach(); } catch {} cdp = null; };
    const now = () => Date.now() / 1000;
    // Waiting for a page is cut: the stream restarts on the new page.
    const loading = async (fn) => {
      const a = now(); await stopCast();
      try { await fn(); } finally {
        await p.waitForLoadState('load', { timeout: 60000 }).catch(() => {});
        await sleep(600);
        await startCast(); skips.push([a, now()]);
      }
    };

    // The hand: curved, eased moves.
    let at = { x: vw / 2, y: vh / 2 };
    const moveTo = async (x, y, ms = 650) => {
      const steps = Math.max(10, Math.round(ms / 16)), bend = (Math.random() - 0.5) * 0.25;
      const cx = (at.x + x) / 2 + (y - at.y) * bend, cy = (at.y + y) / 2 - (x - at.x) * bend;
      for (let i = 1; i <= steps; i++) {
        const t = ease(i / steps), u = 1 - t;
        await p.mouse.move(u * u * at.x + 2 * u * t * cx + t * t * x, u * u * at.y + 2 * u * t * cy + t * t * y);
        await sleep(16);
      }
      at = { x, y };
    };
    // The Live Editor shows the page inside a frame: { frame: true, … } looks there instead of the editor.
    const LE_FRAME = 'iframe[src*="fw-live-editor-frame"]';
    const target = (t) => {
      if (typeof t === 'string') return p.locator(t).first();
      const base = t.frame ? p.frameLocator(LE_FRAME) : p;
      if (t.css) return base.locator(t.css).first();
      if (t.text) return base.getByText(t.text, { exact: t.exact ?? true }).first();
      if (t.role) return base.getByRole(t.role, { name: t.name, exact: t.exact ?? false }).first();
      if (t.label) return base.getByLabel(t.label).first();
      if (t.pb === 'tile') return p.locator(t.element ? `.builder-item-type:has(.fw-page-builder-thumb-shortcode--${t.element})` : '.builder-item-type', t.title ? { hasText: new RegExp(`^\\s*${t.title}\\s*$`) } : undefined).first();
      if (t.pb === 'tab') return p.getByText(t.name, { exact: true }).first();
      if (t.pb === 'item') return p.locator('.builder-root-items .builder-item', { hasText: t.name }).last();
      if (t.pb === 'field') return p.locator(`[name="fw_edit_options_modal[${t.name}]"]:visible`).first();
      if (t.pb === 'save') return p.locator('button.media-button.button-primary:visible', { hasText: 'Save' }).last();
      if (t.pb === 'first-field') return p.locator('.fw-modal input[type=text]:visible, .fw-modal textarea:visible').first();
      throw new Error(`Unknown target ${JSON.stringify(t)}`);
    };
    const box = async (loc) => {
      let why = '';
      // Playwright waits for the target to hold still before scrolling; a page with a running animation (the
      // Extensions screen) never does, so after a short try the target is scrolled to the middle directly.
      await loc.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(async (e) => {
        why = String(e.message || e).split('\n')[0];
        await loc.evaluate((el) => el.scrollIntoView({ block: 'center' })).then(() => sleep(400), () => {});
      });
      const r = await loc.boundingBox().catch(() => null);
      if (!r) {
        const seen = await loc.evaluate((el) => { const s = getComputedStyle(el); const q = el.getBoundingClientRect(); return `${el.tagName.toLowerCase()} ${Math.round(q.width)}x${Math.round(q.height)} at ${Math.round(q.y)}, display ${s.display}, visibility ${s.visibility}`; }).catch((e) => String(e.message || e).split('\n')[0]);
        throw new Error(`target is not on screen: ${seen}${why ? ` (${why})` : ''}`);
      }
      return r;
    };
    const dropZone = async () => p.evaluate(() => {
      const z = [...document.querySelectorAll('.builder-root-items .builder-items')].filter((e) => e.offsetParent && e.closest('.builder-item'));
      if (!z.length) return null;
      const r = z[z.length - 1].getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    let about = ''; // the step's own note for the narration (steps.json "about"), carried on its actions
    const log = (kind, label, r, a, extra = {}) => actions.push({ kind, label, t0: a, t1: now(), rect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null, ...(about ? { about } : {}), ...extra });
    const click = async (loc, label, double = false) => {
      const r = await box(loc); const a = now();
      await moveTo(r.x + r.width / 2, r.y + r.height / 2); await sleep(120);
      if (double) await p.mouse.dblclick(at.x, at.y); else { await p.mouse.down(); await sleep(90); await p.mouse.up(); }
      log(double ? 'dblclick' : 'click', label, r, a);
    };
    const typeText = async (text, label) => {
      const a = now();
      for (const ch of String(text)) { await p.keyboard.type(ch); await sleep(55 + Math.random() * 60); }
      const r = await p.evaluate(() => { const e = document.activeElement; if (!e || e === document.body) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; });
      log('type', label || `Type "${text}"`, r, a, { text });
    };
    const drag = async (fromLoc, toRect, label) => {
      const r = await box(fromLoc); const a = now();
      await moveTo(r.x + r.width / 2, r.y + r.height / 2); await sleep(150); await p.mouse.down();
      const sx = at.x, sy = at.y, tx = toRect.x + toRect.width * 0.75, ty = toRect.y + toRect.height / 2, steps = 55;
      for (let i = 1; i <= steps; i++) { const t = ease(i / steps); await p.mouse.move(sx + (tx - sx) * t, sy + (ty - sy) * t); await sleep(16); }
      await sleep(250); await p.mouse.up(); at = { x: tx, y: ty };
      log('drag', label, { x: Math.min(r.x, toRect.x), y: Math.min(r.y, toRect.y), width: Math.max(r.x + r.width, toRect.x + toRect.width) - Math.min(r.x, toRect.x), height: Math.max(r.y + r.height, toRect.y + toRect.height) - Math.min(r.y, toRect.y) }, a, { from: { x: r.x, y: r.y, w: r.width, h: r.height }, to: { x: toRect.x, y: toRect.y, w: toRect.width, h: toRect.height } });
    };

    await startCast();
    const t0 = now();
    await sleep(700);
    for (const [i, s] of spec.steps.entries()) {
      const label = s.label || '';
      about = typeof s.about === 'string' ? s.about : '';
      onStep(`Step ${i + 1} of ${spec.steps.length}: ${s.do}${label ? ` (${label})` : ''}`);
      try {
      switch (s.do) {
        case 'click': await click(target(s.target), label); break;
        case 'dblclick': await click(target(s.target), label, true); break;
        case 'hover': { const r = await box(target(s.target)); const a = now(); await moveTo(r.x + r.width / 2, r.y + r.height / 2); log('hover', label, r, a); break; }
        case 'type': if (s.target) await click(target(s.target), label); if (s.clear) { await p.keyboard.press('Control+A'); } await typeText(s.text, label); break;
        case 'press': await p.keyboard.press(s.key); break;
        // A dropdown: the cursor goes to it and the choice is made (a native list does not show in the recording).
        case 'select': {
          const loc = target(s.target);
          const r = await box(loc);
          const a = now();
          await moveTo(r.x + Math.min(r.width / 2, 160), r.y + r.height / 2);
          await loc.selectOption(s.value != null ? { value: String(s.value) } : { label: s.option });
          log('click', label, r, a);
          await sleep(500);
          break;
        }
        case 'drag': await drag(target(s.from), await box(target(s.to)), label); break;
        case 'scroll': { const a = now(); for (let k = 0, by = s.by || 300; k < Math.abs(by); k += 6) { await p.mouse.wheel(0, Math.sign(by) * 6); await sleep(16); } log('scroll', label, null, a); break; }
        case 'wait': await sleep(s.ms || 600); break;
        case 'upload': {
          // Choosing a file: the cursor goes to the file field (or its button: `click`) and the file is set, since a
          // system file dialog does not show in a recording. `file` is a path on this computer.
          const input = target(s.target || 'input[type=file]');
          const shown = s.click ? target(s.click) : input;
          const r = await box(shown).catch(() => null); const a = now();
          if (r) await moveTo(r.x + r.width / 2, r.y + r.height / 2);
          await input.setInputFiles(s.file);
          log('click', label, r, a); break;
        }
        case 'waitFor': {
          // Something slow (an AI building a page, an import): `keep` seconds of the wait stay in the video so the viewer
          // sees it working, the rest is cut until the target reaches `state` (visible, hidden, attached, detached).
          const a = now();
          await sleep((s.keep ?? 2) * 1000);
          const b = now(); await stopCast();
          try { await target(s.target).waitFor({ state: s.state || 'visible', timeout: s.timeout || 600000 }); }
          finally { await sleep(500); await startCast(); skips.push([b, now()]); }
          log('wait', label, null, a); break;
        }
        case 'goto': { const a = now(); await loading(() => p.goto(site + s.path, { waitUntil: 'load', timeout: 90000 })); log('page', label || s.path, null, a); break; }
        case 'mark': log('mark', label, null, now()); break;
        // Unyson+ actions.
        case 'wp.title': await click(p.locator('#title'), label || 'Page title'); await typeText(s.text, label || 'Page title'); break;
        case 'pb.tab': await click(target({ pb: 'tab', name: s.name }), label || s.name); await sleep(350); break;
        case 'pb.addSection': await click(target({ pb: 'tile', title: s.kind || 'Section' }), label || 'Add a section'); await sleep(600); break;
        case 'pb.add': {
          if (s.tab) { await click(target({ pb: 'tab', name: s.tab }), s.tab); await sleep(350); }
          const zone = await dropZone(); if (!zone) throw new Error('No section to drop into: add a section first.');
          await drag(target({ pb: 'tile', element: s.element }), zone, label || `Add ${s.element}`); await sleep(600); break;
        }
        case 'pb.edit': await click(target({ pb: 'item', name: s.item }), label || `Edit ${s.item}`); await sleep(900); break; // one click opens an element's settings
        case 'pb.set': await click(s.field ? target({ pb: 'field', name: s.field }) : target({ pb: 'first-field' }), label || s.field); if (s.clear !== false) await p.keyboard.press('Control+A'); await typeText(s.text, label || s.field); break;
        case 'pb.save': await click(target({ pb: 'save' }), label || 'Save'); await sleep(700); break;
        case 'wp.saveDraft': { await click(p.locator('#save-post'), label || 'Save draft'); const a = now(); await loading(() => p.waitForLoadState('load')); log('page', 'Saved', null, a); break; }
        // Live Editor (front-end editing).
        case 'le.select': await click(target({ frame: true, text: s.text, exact: s.exact ?? false }), label || `Select ${s.text}`); await sleep(500); break;
        case 'le.edit': await click(p.frameLocator(LE_FRAME).locator('.fw-le-act-edit:visible').first(), label || 'Edit it'); await sleep(900); break;
        case 'le.device': await click(p.locator(`.fw-le-device[title="${s.name}"]`).first(), label || s.name); await sleep(900); break;
        case 'le.save': await click(p.locator('.fw-le-btn--primary', { hasText: 'Save' }).first(), label || 'Save'); await sleep(1200); break;
        case 'wp.publish': {
          // Publish (not a draft), wait for WordPress to confirm, so "see it live" really is live.
          await click(p.locator('#publish'), label || 'Publish');
          const a = now();
          // The confirmation is waited for off camera too (a styled admin can hide the notice: the wait then ran its
          // whole 15 s on screen), and only while the page is still the editor.
          await loading(async () => {
            await p.waitForLoadState('load');
            await p.locator('#message, .notice-success, .updated, #sample-permalink a').first().waitFor({ timeout: 15000 }).catch(() => {});
          });
          log('page', 'Published', null, a); break;
        }
        case 'wp.view': {
          // The published page itself, through its real link.
          const href = await p.locator('#sample-permalink a, #view-post-btn a, #message a').first().getAttribute('href');
          const a = now(); await loading(() => p.goto(href, { waitUntil: 'load', timeout: 90000 }));
          await p.addStyleTag({ content: '#wpadminbar{display:none!important}html{margin-top:0!important}' }).catch(() => {});
          log('page', label || 'See it live', null, a); break;
        }
        case 'wp.preview': {
          const href = await p.locator('#post-preview').getAttribute('href');
          const a = now(); await loading(() => p.goto(href, { waitUntil: 'load', timeout: 90000 }));
          await p.addStyleTag({ content: '#wpadminbar{display:none!important}html{margin-top:0!important}' }).catch(() => {});
          log('page', label || 'Preview', null, a); break;
        }
        default: throw new Error(`Unknown step "${s.do}"`);
      }
      } catch (e) {
        // Which step failed, so a long take is fixed at the right place.
        throw new Error(`Step ${i + 1} (${s.do}${label ? ` "${label}"` : ''}): ${e.message.split('\n')[0]}`);
      }
      await sleep(s.pause ?? 350);
    }
    await sleep(spec.tail ?? 1500);
    await stopCast();
    const t1 = now();

    // Real time → video time: loading spans are removed (a short 0.12 s cut is left in their place).
    const cut = (t) => { let d = 0; for (const [a, b] of skips) { if (t >= b) d += (b - a) - 0.12; else if (t > a) return a - t0 - (d); } return t - t0 - d; };
    const inSkip = (t) => skips.some(([a, b]) => t > a && t < b);
    const kept = frames.filter((f) => f.t >= t0 && !inSkip(f.t)).sort((a, b) => a.t - b.t);
    if (!kept.length) throw new Error('No frames were recorded.');
    const total = cut(t1);
    let list = '';
    // Each frame lasts until the next one: Chrome sends no frames while the screen is still, so a cap here (it was 2 s)
    // shortened every still stretch and the video ran shorter than actions.json, every later zoom landing late.
    kept.forEach((f, i) => {
      const next = kept[i + 1] ? cut(kept[i + 1].t) : total;
      list += `file '${join(framesDir, f.name).replace(/\\/g, '/')}'\nduration ${Math.max(0.001, next - cut(f.t)).toFixed(4)}\n`;
    });
    // The concat format needs the last image listed twice; the repeat would take the previous duration again (seconds
    // too long), so the output is cut at the true length with -t below.
    list += `file '${join(framesDir, kept[kept.length - 1].name).replace(/\\/g, '/')}'\n`;
    writeFileSync(join(out, 'frames.txt'), list);
    const video = join(out, 'video.mp4');
    onStep('Making the video');
    await run(process.env.FFMPEG || 'ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(out, 'frames.txt'),
      '-vf', `fps=30,scale=${vw * scale}:${vh * scale}:flags=lanczos,format=yuv420p`, '-t', total.toFixed(3), '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-movflags', '+faststart', video]);
    const W = vw * scale, H = vh * scale;
    const acts = actions.map((x) => ({
      kind: x.kind, label: x.label, t: +cut(x.t0).toFixed(2), end: +cut(x.t1).toFixed(2), ...(x.text ? { text: x.text } : {}), ...(x.about ? { about: x.about } : {}),
      // Where it happened, in the video's pixels.
      ...(x.rect ? { rect: { x: Math.round(x.rect.x * scale), y: Math.round(x.rect.y * scale), w: Math.round(x.rect.w * scale), h: Math.round(x.rect.h * scale) } } : {}),
    }));
    const result = { video: 'video.mp4', width: W, height: H, seconds: +total.toFixed(2), actions: acts };
    writeFileSync(join(out, 'actions.json'), JSON.stringify(result, null, 1));
    rmSync(framesDir, { recursive: true, force: true });
    return result;
  } finally {
    await browser.close().catch(() => {});
  }
}
