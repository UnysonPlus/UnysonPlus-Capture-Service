// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Generated from the Studio's apps/studio/src/lib/physics.ts (esbuild): change it there, then regenerate this file.
// Agents reach it through the MCP tool scene_physics.
const PHYSICS_DEFAULTS = { from: "above", at: 0, floor: 88, bounce: 0.35, stagger: 0.12, seconds: 4, sound: true };
const STEP = 1e3 / 60;
const KEY_EVERY = 3;
const WORLD_W = 1e3;
const r2 = (v) => Math.round(v * 100) / 100;
const CLIP_ID = "physics-";
function bodyOf(layer, stageH) {
  const b = layer.box;
  if (!b) return null;
  let w = typeof b.w === "number" ? b.w / 100 * WORLD_W : 0;
  let h = typeof b.ratio === "number" && b.ratio > 0 ? w / b.ratio : typeof b.h === "number" ? b.h / 100 * stageH : 0;
  if (layer.type === "text") {
    const size = (layer.style?.fontSize ?? 4) / 100 * WORLD_W;
    if (!w) w = Math.max(size, layer.text.replace(/\*/g, "").length * size * 0.56);
    if (!h) h = size * 1.3;
  }
  if (!w || !h) return null;
  const a = b.anchor ?? "center";
  const cx = b.x / 100 * WORLD_W + (/left/.test(a) ? w / 2 : /right/.test(a) ? -w / 2 : 0);
  const cy = b.y / 100 * stageH + (/top/.test(a) ? h / 2 : /bottom/.test(a) ? -h / 2 : 0);
  return { id: layer.id, cx, cy, w, h, angle: (b.rotate ?? 0) * Math.PI / 180, round: layer.type === "shape" && layer.shape === "ellipse" && Math.abs(w - h) < 2 };
}
function stageHeight(scene) {
  const a = scene.stage.breakpoints[0]?.aspect ?? [16, 9];
  return WORLD_W * a[1] / a[0];
}
function trimFrames(frames, tolerance = 0.5) {
  if (frames.length < 3) return frames;
  const kept = [frames[0]];
  for (let i = 1; i < frames.length - 1; i++) {
    const a = kept[kept.length - 1], m = frames[i], b = frames[i + 1];
    const u = (m.t - a.t) / (b.t - a.t);
    const off = (k) => Math.abs(a[k] + (b[k] - a[k]) * u - m[k]);
    if (off("x") > tolerance || off("y") > tolerance || off("rotate") > tolerance) kept.push(m);
  }
  kept.push(frames[frames.length - 1]);
  return kept;
}
function simulate(M, bodies, stageH, o) {
  M.Common._seed = 1;
  const engine = M.Engine.create({ enableSleeping: true });
  engine.gravity.y = 1.4;
  const floorY = o.floor / 100 * stageH;
  const wall = { isStatic: true, friction: 0.6 };
  const live = bodies.map((b, i) => {
    const y = o.from === "above" ? -b.h - 60 - (o.stagger < 0.1 ? i * b.h * 1.3 : 0) : b.cy;
    const opts = { restitution: o.bounce, friction: 0.5, frictionAir: 8e-3, angle: b.angle + (o.from === "above" ? (i * 37 % 11 - 5) * 0.03 : 0), sleepThreshold: 45 };
    return b.round ? M.Bodies.circle(b.cx, y, b.w / 2, opts) : M.Bodies.rectangle(b.cx, y, b.w, b.h, opts);
  });
  M.Composite.add(engine.world, [
    M.Bodies.rectangle(WORLD_W / 2, floorY + 100, WORLD_W * 3, 200, wall),
    M.Bodies.rectangle(-100, stageH / 2, 200, stageH * 6, wall),
    M.Bodies.rectangle(WORLD_W + 100, stageH / 2, 200, stageH * 6, wall)
  ]);
  const hits = [];
  let now = 0;
  M.Events.on(engine, "collisionStart", (ev) => {
    for (const p of ev.pairs) {
      const a = p.bodyA, b = p.bodyB;
      const force = Math.max(a.speed, b.speed);
      if (force > 6) hits.push({ t: now, force });
    }
  });
  const frames = bodies.map(() => []);
  const held = live.map(() => true);
  const steps = Math.round(o.seconds * 1e3 / STEP);
  let done = steps;
  for (let s = 0; s <= steps; s++) {
    now = s * STEP / 1e3;
    live.forEach((x, i) => {
      if (held[i] && now >= i * o.stagger) {
        held[i] = false;
        M.Composite.add(engine.world, x);
      }
    });
    if (s % KEY_EVERY === 0) {
      live.forEach((x, i) => {
        const b = bodies[i];
        frames[i].push({ t: r2(now), x: r2((x.position.x - b.cx) / b.w * 100), y: r2((x.position.y - b.cy) / b.h * 100), rotate: r2((x.angle - b.angle) * 180 / Math.PI) });
      });
    }
    M.Engine.update(engine, STEP);
    if (s % KEY_EVERY === 0 && !held.some(Boolean) && live.every((x) => x.isSleeping)) {
      done = s;
      break;
    }
  }
  return { frames: frames.map((f) => trimFrames(f)), seconds: r2(done * STEP / 1e3), hits };
}
function landings(hits) {
  const out = [];
  for (const h of hits) {
    if (out.length >= 8 || out.length && h.t - out[out.length - 1].t < 0.14) continue;
    out.push({ t: h.t, volume: r2(Math.min(0.5, 0.12 + h.force / 60)) });
  }
  return out;
}
const walk = (list, fn) => list.map((l) => {
  const n = fn(l);
  return n.type === "group" ? { ...n, layers: walk(n.layers, fn) } : n;
});
async function dropWithPhysics(scene, ids, options = {}) {
  const o = { ...PHYSICS_DEFAULTS, ...options };
  const M = (await import("matter-js")).default;
  const H = stageHeight(scene);
  const found = [];
  walk(scene.layers, (l) => {
    if (ids.includes(l.id)) found.push(l);
    return l;
  });
  const bodies = found.map((l) => bodyOf(l, H)).filter((b) => !!b);
  if (!bodies.length) throw new Error("Those layers have no size to work from.");
  const r = simulate(M, bodies, H, o);
  const by = new Map(bodies.map((b, i) => [b.id, r.frames[i]]));
  const layers = walk(scene.layers, (l) => {
    const f = by.get(l.id);
    if (!f) return l;
    const clip = { id: `${CLIP_ID}${l.id}`, preset: "keyframes", start: r2(o.at), duration: Math.max(0.2, r.seconds), ease: "none", params: { frames: f } };
    return { ...l, ...o.from === "above" ? { start: r2(o.at) } : {}, clips: [...l.clips.filter((c) => !c.id.startsWith(CLIP_ID)), clip] };
  });
  const { audio: before, ...rest } = scene;
  const audio = (before ?? []).filter((a) => !a.id.startsWith(CLIP_ID));
  if (o.sound) landings(r.hits).forEach((h, i) => audio.push({ id: `${CLIP_ID}thud-${i + 1}`, name: "Landing", src: "sfx:thud", start: r2(o.at + h.t), volume: h.volume }));
  const duration = Math.max(scene.duration, r2(o.at + r.seconds));
  return { scene: { ...rest, duration, layers, ...audio.length ? { audio } : {} }, seconds: r.seconds, count: bodies.length };
}
export {
  PHYSICS_DEFAULTS,
  bodyOf,
  dropWithPhysics,
  landings,
  simulate,
  stageHeight,
  trimFrames
};
