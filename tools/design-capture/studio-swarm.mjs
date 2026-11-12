// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Generated from the Studio's apps/studio/src/lib/swarm.ts (esbuild): change it there, then regenerate this file.
// Agents reach it through the MCP tool scene_swarm and studio-cli swarm.
// packages/player/src/eases.ts
var powerOut = (p) => (t) => 1 - Math.pow(1 - t, p);
var powerIn = (p) => (t) => Math.pow(t, p);
var expoOut = (k) => {
  const d = 1 - Math.exp(-k);
  return (t) => (1 - Math.exp(-k * t)) / d;
};
var snapRamp = (w, tau) => {
  const n = w * (1 - Math.exp(-1 / tau)) + (1 - w);
  return (t) => (w * (1 - Math.exp(-t / tau)) + (1 - w) * t) / n;
};
var snapOver = (a, rise, decay) => {
  const f = (t) => (1 + a * Math.exp(-t / decay)) * (1 - Math.exp(-t / rise));
  const n = f(1);
  return (t) => f(t) / n;
};
var spring = (damping, freq) => {
  const f = (t) => 1 - Math.exp(-damping * t) * (Math.cos(freq * t) + damping / freq * Math.sin(freq * t));
  const n = f(1);
  return (t) => f(t) / n;
};
var smooth = (p) => (t) => {
  const a = Math.pow(t, p);
  const b = Math.pow(1 - t, p);
  return a / (a + b);
};
var ends = (f) => (t) => t <= 0 ? 0 : t >= 1 ? 1 : f(t);
var NAMED_EASES = [
  { id: "softLand", label: "Soft land", use: "Firm slow-down into place. The workhorse for text and panels.", seconds: 0.4, role: "enter", fn: ends(expoOut(3.41)) },
  { id: "snapSettle", label: "Snap and settle", use: "Most of the travel at once, then a gentle settle. A strong hero entrance.", seconds: 0.37, role: "enter", fn: ends(snapRamp(0.942, 0.118)) },
  { id: "glide", label: "Glide", use: "A gentle slow-down for medium moves.", seconds: 0.33, role: "enter", fn: ends(powerOut(1.7)) },
  { id: "whip", label: "Whip", use: "A fast, hard slow-down for big moves.", seconds: 0.23, role: "enter", fn: ends(powerOut(2.52)) },
  { id: "popOver", label: "Pop over", use: "Passes its mark late and settles back (peaks about 8% over). One per scene.", seconds: 0.5, role: "enter", fn: ends(spring(2.67, 4.36)) },
  { id: "crashIn", label: "Crash in", use: "Hits its mark at once and overshoots (about 18%). For impact.", seconds: 0.33, role: "enter", fn: ends(snapOver(2, 0.19, 0.218)) },
  { id: "bounceHard", label: "Bounce hard", use: "A big springy overshoot (about 48%). Use sparingly.", seconds: 0.73, role: "enter", fn: ends(spring(1.34, 5.07)) },
  { id: "cruise", label: "Cruise", use: "Steady speed. For drifts, counters and slow ambient moves.", seconds: 0.3, role: "any", fn: ends((t) => t) },
  { id: "softInOut", label: "Soft in-out", use: "A symmetric S-curve for opacity and blur changes.", seconds: 0.3, role: "any", fn: ends(smooth(1.42)) },
  { id: "gentleIn", label: "Gentle in", use: "A mild speed-up.", seconds: 0.3, role: "exit", fn: ends(powerIn(2.07)) },
  { id: "accelExit", label: "Leave", use: "The leaving curve: speeds up out of frame. The default for exits.", seconds: 0.43, role: "exit", fn: ends(powerIn(2.6)) },
  { id: "crashOut", label: "Crash out", use: "A hard speed-up, into a cut or a big change.", seconds: 0.57, role: "exit", fn: ends(powerIn(3.97)) }
];
var NAMED_EASE_IDS = NAMED_EASES.map((e) => e.id);
var namedEase = Object.fromEntries(NAMED_EASES.map((e) => [e.id, e]));

// packages/player/src/presets/catalog.ts
var DIRECTION = {
  key: "direction",
  label: "Direction",
  type: "select",
  options: [{ value: "in", label: "In" }, { value: "out", label: "Out" }]
};
var LOOK_OPTIONS = [
  { value: "bw", label: "Black and white" },
  { value: "noir", label: "Noir" },
  { value: "warm", label: "Warm" },
  { value: "cool", label: "Cool" },
  { value: "film", label: "Film" },
  { value: "vivid", label: "Vivid" },
  { value: "faded", label: "Faded" },
  { value: "teal", label: "Teal and orange" }
];
var STAGGER = { key: "stagger", label: "Stagger", type: "number", min: 0, max: 1, step: 5e-3, unit: "s" };
var RHYTHM = {
  key: "rhythm",
  label: "Rhythm",
  type: "select",
  options: [{ value: "natural", label: "Natural (uneven gaps)" }, { value: "even", label: "Even" }, { value: "spoken", label: "Spoken (each word when the voice-over says it)" }]
};
var BY = {
  key: "by",
  label: "Animate by",
  type: "select",
  options: [{ value: "chars", label: "Letter" }, { value: "words", label: "Word" }]
};
var SIDE = {
  key: "from",
  label: "From",
  type: "select",
  options: [
    { value: "left", label: "Left" },
    { value: "right", label: "Right" },
    { value: "top", label: "Top" },
    { value: "bottom", label: "Bottom" }
  ]
};
var ALL = ["text", "shape", "image", "video", "model", "group", "path", "flow", "diagram", "code", "captions", "repeat", "cursor"];
var PRESET_CATALOG = [
  // ---- Text ----
  {
    id: "text-rise",
    label: "Rise",
    category: "text",
    appliesTo: ["text"],
    description: "Letters or words rise into place one after another, from behind an invisible mask.",
    defaultEase: "power4.out",
    defaultDuration: 0.9,
    defaults: { direction: "in", by: "chars", stagger: 0.03, rhythm: "natural", distance: 130, mask: true },
    fields: [DIRECTION, BY, STAGGER, RHYTHM, { key: "distance", label: "Distance", type: "number", min: 0, max: 400, step: 5, unit: "%" }, { key: "mask", label: "Mask", type: "boolean" }]
  },
  {
    id: "text-slam",
    label: "Slam",
    category: "text",
    appliesTo: ALL,
    description: "Lands from a large, blurred scale, as if thrown at the screen.",
    defaultEase: "expo.out",
    defaultDuration: 0.8,
    defaults: { direction: "in", scale: 2.4, blur: 1.2 },
    fields: [DIRECTION, { key: "scale", label: "Start scale", type: "number", min: 1, max: 8, step: 0.1 }, { key: "blur", label: "Blur", type: "number", min: 0, max: 5, step: 0.1 }]
  },
  {
    id: "text-stretch",
    label: "Stretch",
    category: "text",
    appliesTo: ["text"],
    description: "Letters grow out of a line, squashed, then spring to full size.",
    defaultEase: "expo.out",
    defaultDuration: 0.9,
    defaults: { direction: "in", axis: "y", stagger: 0.04, rhythm: "natural", squash: 1.8 },
    fields: [DIRECTION, { key: "axis", label: "Axis", type: "select", options: [{ value: "y", label: "Vertical" }, { value: "x", label: "Horizontal" }] }, STAGGER, RHYTHM, { key: "squash", label: "Squash", type: "number", min: 1, max: 4, step: 0.1 }]
  },
  {
    id: "text-scramble",
    label: "Scramble",
    category: "text",
    appliesTo: ["text"],
    description: "Letters flicker through random characters and settle on the real text, left to right.",
    defaultEase: "none",
    defaultDuration: 1.1,
    defaults: { charset: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&*+=/", fps: 24 },
    fields: [{ key: "charset", label: "Characters", type: "text" }, { key: "fps", label: "Flicker rate", type: "number", min: 1, max: 60, step: 1, unit: "/s" }]
  },
  {
    id: "text-typewriter",
    label: "Typewriter",
    category: "text",
    appliesTo: ["text"],
    description: "Letters appear one at a time, as if being typed. Caret adds a typing cursor that blinks once the line is done (a prompt box, a search field).",
    defaultEase: "none",
    defaultDuration: 1.2,
    defaults: { direction: "in", caret: false },
    fields: [DIRECTION, { key: "caret", label: "Caret", type: "boolean" }]
  },
  {
    id: "text-blur",
    label: "Blur in",
    category: "text",
    appliesTo: ["text"],
    description: "Letters or words sharpen out of a soft blur, one after another.",
    defaultEase: "power2.out",
    defaultDuration: 1,
    defaults: { direction: "in", by: "chars", stagger: 0.03, rhythm: "natural", blur: 0.8 },
    fields: [DIRECTION, BY, STAGGER, RHYTHM, { key: "blur", label: "Blur", type: "number", min: 0, max: 4, step: 0.1 }]
  },
  {
    id: "text-flip",
    label: "Flip",
    category: "text",
    appliesTo: ["text"],
    description: "Letters or words flip up into place in 3D, like a departure board.",
    defaultEase: "power3.out",
    defaultDuration: 0.9,
    defaults: { direction: "in", by: "chars", stagger: 0.04, rhythm: "natural" },
    fields: [DIRECTION, BY, STAGGER, RHYTHM]
  },
  {
    id: "text-tracking",
    label: "Tracking",
    category: "text",
    appliesTo: ["text"],
    description: "Letter spacing opens out (or closes in) as the text fades in.",
    defaultEase: "power3.out",
    defaultDuration: 1.2,
    defaults: { direction: "in", from: -0.4 },
    fields: [DIRECTION, { key: "from", label: "Start spacing", type: "number", min: -1, max: 2, step: 0.05, unit: "em" }]
  },
  {
    id: "text-wave",
    label: "Wave",
    category: "emphasis",
    appliesTo: ["text"],
    description: "A ripple runs through the letters: each one hops and settles.",
    defaultEase: "sine.inOut",
    defaultDuration: 1,
    defaults: { height: 30, stagger: 0.05, rhythm: "natural" },
    fields: [{ key: "height", label: "Height", type: "number", min: 0, max: 200, step: 5, unit: "%" }, STAGGER, RHYTHM]
  },
  // ---- Reveal and exit ----
  {
    id: "fade",
    label: "Fade",
    category: "reveal",
    appliesTo: ALL,
    description: "Fades in or out with a small drift, optionally scaling or blurring as it goes.",
    defaultEase: "softLand",
    defaultDuration: 0.5,
    defaults: { direction: "in", x: 0, y: 12, scale: 1, blur: 0 },
    fields: [DIRECTION, { key: "x", label: "Drift X", type: "number", min: -200, max: 200, step: 5, unit: "%" }, { key: "y", label: "Drift Y", type: "number", min: -200, max: 200, step: 5, unit: "%" }, { key: "scale", label: "Scale", type: "number", min: 0, max: 4, step: 0.05 }, { key: "blur", label: "Blur", type: "number", min: 0, max: 5, step: 0.1 }]
  },
  {
    id: "wipe",
    label: "Wipe",
    category: "reveal",
    appliesTo: ALL,
    description: "Reveals or hides behind a straight edge sweeping across.",
    defaultEase: "power3.inOut",
    defaultDuration: 0.8,
    defaults: { direction: "in", from: "left" },
    fields: [DIRECTION, { ...SIDE, options: [...SIDE.options, { value: "center", label: "Centre" }] }]
  },
  {
    id: "iris",
    label: "Iris",
    category: "reveal",
    appliesTo: ALL,
    description: "Opens (or closes) through a growing circle.",
    defaultEase: "power3.inOut",
    defaultDuration: 0.9,
    defaults: { direction: "in", x: 50, y: 50 },
    fields: [DIRECTION, { key: "x", label: "Centre X", type: "number", min: 0, max: 100, step: 1, unit: "%" }, { key: "y", label: "Centre Y", type: "number", min: 0, max: 100, step: 1, unit: "%" }]
  },
  {
    id: "slide",
    label: "Slide",
    category: "reveal",
    appliesTo: ALL,
    description: "Slides in from a side (or out to one) while fading. Motion blur smears it along the move while it is fast, so a quick move reads as speed.",
    defaultEase: "softLand",
    defaultDuration: 0.6,
    defaults: { direction: "in", from: "bottom", distance: 60, motionBlur: 0 },
    fields: [DIRECTION, SIDE, { key: "distance", label: "Distance", type: "number", min: 0, max: 400, step: 5, unit: "%" }, { key: "motionBlur", label: "Motion blur", type: "number", min: 0, max: 3, step: 0.1 }]
  },
  {
    id: "grow",
    label: "Grow",
    category: "reveal",
    appliesTo: ALL,
    description: "Draws out from one edge or the centre. Made for lines and bars.",
    defaultEase: "expo.inOut",
    defaultDuration: 0.9,
    defaults: { direction: "in", axis: "x", origin: "center" },
    fields: [DIRECTION, { key: "axis", label: "Axis", type: "select", options: [{ value: "x", label: "Horizontal" }, { value: "y", label: "Vertical" }] }, { key: "origin", label: "From", type: "select", options: [{ value: "start", label: "Start" }, { value: "center", label: "Centre" }, { value: "end", label: "End" }] }]
  },
  // ---- Move and scale ----
  {
    id: "pop",
    label: "Pop",
    category: "motion",
    appliesTo: ALL,
    description: "Scales up into place with a little overshoot (or down and away).",
    defaultEase: "popOver",
    defaultDuration: 0.5,
    defaults: { direction: "in", from: 0.5 },
    fields: [DIRECTION, { key: "from", label: "Start scale", type: "number", min: 0, max: 1, step: 0.05 }]
  },
  {
    id: "zoom",
    label: "Zoom",
    category: "motion",
    appliesTo: ALL,
    description: "Eases in from smaller (or larger) with a fade, no overshoot. A start scale above 1 lands it from close up.",
    defaultEase: "softLand",
    defaultDuration: 0.6,
    defaults: { direction: "in", scale: 0.7 },
    fields: [DIRECTION, { key: "scale", label: "Start scale", type: "number", min: 0, max: 4, step: 0.05 }]
  },
  {
    id: "spin",
    label: "Spin",
    category: "motion",
    appliesTo: ALL,
    description: "Turns into place while scaling up.",
    defaultEase: "expo.out",
    defaultDuration: 0.9,
    defaults: { direction: "in", turns: 0.5 },
    fields: [DIRECTION, { key: "turns", label: "Turns", type: "number", min: -4, max: 4, step: 0.25 }]
  },
  {
    id: "keyframes",
    label: "Keyframes",
    category: "motion",
    appliesTo: ALL,
    description: "Hand-set values at moments within the clip: position, scale, rotation, opacity and blur.",
    defaultEase: "power2.inOut",
    defaultDuration: 2,
    defaults: { frames: [{ t: 0, scale: 1 }, { t: 2, scale: 1.1 }] },
    fields: []
  },
  // ---- Emphasis ----
  {
    id: "pulse",
    label: "Pulse",
    category: "emphasis",
    appliesTo: ALL,
    description: "Swells and settles, a set number of times.",
    defaultEase: "sine.inOut",
    defaultDuration: 1.2,
    defaults: { scale: 1.12, times: 2 },
    fields: [{ key: "scale", label: "Scale", type: "number", min: 1, max: 2, step: 0.01 }, { key: "times", label: "Times", type: "number", min: 1, max: 12, step: 1 }]
  },
  {
    id: "shake",
    label: "Shake",
    category: "emphasis",
    appliesTo: ALL,
    description: "A quick, jittery side-to-side shake that dies away.",
    defaultEase: "none",
    defaultDuration: 0.6,
    defaults: { strength: 6 },
    fields: [{ key: "strength", label: "Strength", type: "number", min: 0, max: 40, step: 1, unit: "%" }]
  },
  {
    id: "float",
    label: "Float",
    category: "emphasis",
    appliesTo: ALL,
    description: "Drifts gently up and down, like it is floating.",
    defaultEase: "sine.inOut",
    defaultDuration: 3,
    defaults: { height: 6, cycles: 1 },
    fields: [{ key: "height", label: "Height", type: "number", min: 0, max: 100, step: 1, unit: "%" }, { key: "cycles", label: "Cycles", type: "number", min: 1, max: 10, step: 1 }]
  },
  {
    id: "recolor",
    label: "Recolour",
    category: "emphasis",
    appliesTo: ["text", "shape"],
    description: "Changes the text colour, or a shape\u2019s solid fill, to a new colour.",
    defaultEase: "power2.inOut",
    defaultDuration: 0.6,
    defaults: { to: "#ffffff" },
    fields: [{ key: "to", label: "Colour", type: "color" }]
  },
  // ---- Second set ----
  {
    id: "text-count",
    label: "Count up",
    category: "text",
    appliesTo: ["text"],
    description: 'The number in the text counts up to its value, keeping any prefix, separators and suffix ("$12,500+"). A clock ("0:45") counts in minutes and seconds.',
    defaultEase: "expo.out",
    defaultDuration: 1.6,
    defaults: { from: 0 },
    fields: [{ key: "from", label: "Count from", type: "number", step: 1 }]
  },
  {
    id: "text-swap",
    label: "Change text",
    category: "text",
    appliesTo: ["text"],
    description: 'Swaps the words for new ones on cue ("booting" to "ready in 45 s", "1 / 10" to "2 / 10"): the old text leaves as the new one arrives. Chain several on one layer to step through a sequence; each starts from the text the one before it left.',
    defaultEase: "power3.inOut",
    defaultDuration: 0.5,
    defaults: { to: "New text", style: "roll" },
    fields: [
      { key: "to", label: "New text", type: "text" },
      { key: "style", label: "Style", type: "select", options: [
        { value: "roll", label: "Roll up" },
        { value: "slide", label: "Slide across" },
        { value: "fade", label: "Fade" },
        { value: "blur", label: "Blur" }
      ] }
    ]
  },
  {
    id: "text-carry",
    label: "Carry in",
    category: "text",
    appliesTo: ["text"],
    description: "The first word slides in big and fast and each following word travels less, so the line arrives with momentum instead of an even stagger.",
    defaultEase: "expo.out",
    defaultDuration: 0.9,
    defaults: { from: "right", distance: 18, falloff: 0.35, stagger: 0.07 },
    fields: [
      { key: "from", label: "From", type: "select", options: [{ value: "right", label: "Right" }, { value: "left", label: "Left" }, { value: "bottom", label: "Below" }] },
      { key: "distance", label: "First word travels", type: "number", min: 0, max: 100, step: 0.5, unit: "su" },
      { key: "falloff", label: "Each next word", type: "number", min: 0.05, max: 1, step: 0.05, unit: "\xD7" },
      STAGGER
    ]
  },
  {
    id: "stack-in",
    label: "Stack",
    category: "reveal",
    appliesTo: ALL,
    description: "Drops in from just above and settles, like a card landing on a pile. Stagger several to build a stacking list.",
    defaultEase: "back.out(1.4)",
    defaultDuration: 0.55,
    defaults: { direction: "in", lift: 35 },
    fields: [DIRECTION, { key: "lift", label: "Drop from", type: "number", min: 0, max: 200, step: 5, unit: "%" }]
  },
  {
    id: "glow",
    label: "Glow",
    category: "emphasis",
    appliesTo: ALL,
    description: "A neon glow lights up around the letters (or the outline) and stays on. Flicker makes it catch like a neon tube.",
    defaultEase: "power2.out",
    defaultDuration: 0.6,
    defaults: { direction: "in", color: "#2ad38b", size: 1.2, strength: 1, flicker: false },
    fields: [DIRECTION, { key: "color", label: "Colour", type: "color" }, { key: "size", label: "Size", type: "number", min: 0.1, max: 6, step: 0.1, unit: "su" }, { key: "strength", label: "Strength", type: "number", min: 0, max: 2, step: 0.05 }, { key: "flicker", label: "Flicker", type: "boolean" }]
  },
  {
    id: "burst",
    label: "Burst",
    category: "emphasis",
    appliesTo: ALL,
    description: "A one-off burst of sparks, shards, dots or rings from the layer on a hit. Land it with a sound and the word it punctuates.",
    defaultEase: "none",
    defaultDuration: 0.7,
    defaults: { kind: "sparks", count: 14, reach: 12, color: "#ffd166", x: 50, y: 50 },
    fields: [
      { key: "kind", label: "Kind", type: "select", options: [{ value: "sparks", label: "Sparks" }, { value: "shards", label: "Shards" }, { value: "dots", label: "Dots" }, { value: "rings", label: "Rings" }] },
      { key: "count", label: "How many", type: "number", min: 1, max: 60, step: 1 },
      { key: "reach", label: "Reach", type: "number", min: 1, max: 60, step: 0.5, unit: "su" },
      { key: "color", label: "Colour", type: "color" },
      { key: "x", label: "From X", type: "number", min: -50, max: 150, step: 1, unit: "%" },
      { key: "y", label: "From Y", type: "number", min: -50, max: 150, step: 1, unit: "%" }
    ]
  },
  {
    id: "progress",
    label: "Progress bar",
    category: "motion",
    appliesTo: ["shape"],
    description: "A bar fills the shape from one value to another over the clip: the shape is the track. Use the None ease for a steady load.",
    defaultEase: "power1.inOut",
    defaultDuration: 2,
    defaults: { from: 0, to: 100, color: "#2ad38b", axis: "x" },
    fields: [
      { key: "from", label: "From", type: "number", min: 0, max: 100, step: 1, unit: "%" },
      { key: "to", label: "To", type: "number", min: 0, max: 100, step: 1, unit: "%" },
      { key: "color", label: "Bar colour", type: "color" },
      { key: "axis", label: "Fills", type: "select", options: [{ value: "x", label: "Across" }, { value: "y", label: "Upwards" }] }
    ]
  },
  {
    id: "react",
    label: "React to music",
    category: "ambient",
    appliesTo: ALL,
    description: "Breathes with the music: its loudness or its bass gently drives a glow, a slight scale or brightness. Find the music\u2019s beats first (in the music clip\u2019s settings). Use it on one or two things, never as equaliser bars.",
    defaultEase: "none",
    defaultDuration: 4,
    defaults: { source: "loud", effect: "glow", amount: 0.6, color: "#2ad38b", audio: "" },
    fields: [
      { key: "source", label: "Follows", type: "select", options: [{ value: "loud", label: "Loudness" }, { value: "bass", label: "Bass" }] },
      { key: "effect", label: "Drives", type: "select", options: [{ value: "glow", label: "Glow" }, { value: "scale", label: "Scale" }, { value: "brightness", label: "Brightness" }, { value: "opacity", label: "Presence" }] },
      { key: "amount", label: "Amount", type: "number", min: 0, max: 1, step: 0.05 },
      { key: "color", label: "Glow colour", type: "color" }
    ]
  },
  {
    id: "march",
    label: "Marching outline",
    category: "ambient",
    appliesTo: ["shape"],
    description: "The dashes of a dashed outline travel round it while something is working. Give the shape an outline and a dash length.",
    defaultEase: "none",
    defaultDuration: 3,
    defaults: { speed: 2 },
    fields: [{ key: "speed", label: "Speed", type: "number", min: 0.1, max: 20, step: 0.1, unit: "su/s" }]
  },
  {
    id: "dash-solid",
    label: "Make solid",
    category: "emphasis",
    appliesTo: ["shape"],
    description: "A dashed outline closes up into a solid one, for something becoming ready.",
    defaultEase: "power2.inOut",
    defaultDuration: 0.5,
    defaults: { direction: "in" },
    fields: [DIRECTION]
  },
  {
    id: "draw",
    label: "Draw",
    category: "reveal",
    appliesTo: ["path", "flow"],
    description: "A line (or flow lines) draws itself from its start to its end; out erases it. Arrowheads ride the tip.",
    defaultEase: "power2.inOut",
    defaultDuration: 1.2,
    defaults: { direction: "in" },
    fields: [DIRECTION]
  },
  {
    id: "morph",
    label: "Morph into",
    category: "motion",
    appliesTo: ["text", "shape", "image", "video", "model", "group", "diagram", "code"],
    description: "Glides into another layer: to its place and size (and, between two shapes, its colour and corners), then hands over to it in a short crossfade, so the same word, card or screenshot carries on into the next act instead of fading out and in again. The other layer stays hidden until the handover.",
    defaultEase: "power3.inOut",
    defaultDuration: 0.9,
    defaults: { to: "", fade: 0.3 },
    fields: [{ key: "to", label: "Into layer", type: "layer" }, { key: "fade", label: "Handover", type: "number", min: 0.05, max: 1, step: 0.05 }]
  },
  {
    id: "follow-path",
    label: "Follow path",
    category: "motion",
    appliesTo: ["text", "shape", "image", "video", "model", "group", "diagram", "code", "repeat"],
    description: "Travels along a line layer (or one of the lines of a flow layer), from one point of it to another. Turn to follow makes it face along the line; Trail leaves a fading streak behind it (a comet).",
    defaultEase: "power1.inOut",
    defaultDuration: 1.6,
    defaults: { path: "", line: 1, from: 0, to: 100, rotate: false, trail: 0, trailColor: "#ffffff", trailWidth: 0.35 },
    fields: [
      { key: "path", label: "Line or flow layer", type: "layer" },
      { key: "line", label: "Which flow line", type: "number", min: 1, max: 40, step: 1 },
      { key: "from", label: "From", type: "number", min: 0, max: 100, step: 1, unit: "%" },
      { key: "to", label: "To", type: "number", min: 0, max: 100, step: 1, unit: "%" },
      { key: "rotate", label: "Turn to follow", type: "boolean" },
      { key: "trail", label: "Trail length", type: "number", min: 0, max: 1, step: 0.05 },
      { key: "trailColor", label: "Trail colour", type: "color" },
      { key: "trailWidth", label: "Trail width", type: "number", min: 0.05, max: 3, step: 0.05, unit: "su" }
    ]
  },
  // ---- Cursor (for Cursor layers: the cursor draws itself from these clips) ----
  {
    id: "cursor-move",
    label: "Move to",
    category: "tour",
    appliesTo: ["cursor"],
    description: "The cursor travels to a layer (a point on it, in % of the layer: 50 / 50 is its centre) along a gentle curve with a pointer's easing, or to a point on the stage when no layer is given (beyond the edges to leave). Over a link or a button it turns into a pointing hand as it arrives.",
    defaultEase: "power3.inOut",
    defaultDuration: 0.9,
    defaults: { to: "", x: 50, y: 50, px: 50, py: 50, arc: 0.18, hand: "auto" },
    fields: [
      { key: "to", label: "To layer", type: "layer" },
      { key: "x", label: "Point across it", type: "number", min: 0, max: 100, step: 1, unit: "%" },
      { key: "y", label: "Point down it", type: "number", min: 0, max: 100, step: 1, unit: "%" },
      { key: "px", label: "Or stage X", type: "number", min: -50, max: 150, step: 1, unit: "%" },
      { key: "py", label: "Or stage Y", type: "number", min: -50, max: 150, step: 1, unit: "%" },
      { key: "arc", label: "Curve", type: "number", min: -0.6, max: 0.6, step: 0.02 },
      { key: "hand", label: "Pointing hand", type: "select", options: [{ value: "auto", label: "Over links" }, { value: "yes", label: "Yes" }, { value: "no", label: "No" }] }
    ]
  },
  {
    id: "cursor-click",
    label: "Click",
    category: "tour",
    appliesTo: ["cursor"],
    description: "The cursor presses: it dips, a ring ripples out from the tip and the layer under it dips too, all on the same frame. Give it a click sound, and start what the click causes on its last frame.",
    defaultEase: "none",
    defaultDuration: 0.35,
    defaults: { dip: true },
    fields: [{ key: "dip", label: "The layer under it dips", type: "boolean" }]
  },
  {
    id: "cursor-drag",
    label: "Drag",
    category: "tour",
    appliesTo: ["cursor"],
    description: "The cursor holds the button down and drags, as a crosshair, to a layer (a point on it, in % of the layer: 100 / 100 is its bottom-right corner) or a point on the stage, in a straight line. Move it to the top-left corner first and put Build: draw on that layer over the same seconds: the cursor draws the box.",
    defaultEase: "power2.inOut",
    defaultDuration: 0.7,
    defaults: { to: "", x: 100, y: 100, px: 50, py: 50 },
    fields: [
      { key: "to", label: "To layer", type: "layer" },
      { key: "x", label: "Point across it", type: "number", min: 0, max: 100, step: 1, unit: "%" },
      { key: "y", label: "Point down it", type: "number", min: 0, max: 100, step: 1, unit: "%" },
      { key: "px", label: "Or stage X", type: "number", min: -50, max: 150, step: 1, unit: "%" },
      { key: "py", label: "Or stage Y", type: "number", min: -50, max: 150, step: 1, unit: "%" }
    ]
  },
  {
    id: "cursor-type",
    label: "Type",
    category: "tour",
    appliesTo: ["cursor"],
    description: "The cursor stays where it is as a text I-beam while text is typed (put Typewriter on the text layer over the same seconds). Give it the Typing sound.",
    defaultEase: "none",
    defaultDuration: 1,
    defaults: {},
    fields: []
  },
  {
    id: "build-draw",
    label: "Build: draw",
    category: "tour",
    appliesTo: ["text", "shape", "image", "video", "model", "group", "path", "diagram", "code", "repeat", "lottie"],
    description: 'The layer is drawn as a box in a design tool: an outline grows from its top-left corner with corner handles and a live W x H badge over a grey placeholder, then the layer appears (swept in top to bottom, or faded) as the placeholder melts away. Reveal "none" leaves the layer to the next clip (Typewriter types into the drawn box). With a Cursor dragging over the drawing part it looks hand-drawn; Tools \u203A Build with cursors does it for a whole scene.',
    defaultEase: "none",
    defaultDuration: 1.2,
    defaults: { color: "#4c7dff", draw: 0.65, reveal: "sweep", fill: "grey", badge: true },
    fields: [
      { key: "color", label: "Outline colour", type: "color" },
      { key: "draw", label: "Part spent drawing", type: "number", min: 0.1, max: 0.95, step: 0.05 },
      { key: "reveal", label: "Then", type: "select", options: [{ value: "sweep", label: "Sweep in, top to bottom" }, { value: "fade", label: "Fade in" }, { value: "none", label: "Leave it to the next clip" }] },
      { key: "fill", label: "Placeholder", type: "select", options: [{ value: "grey", label: "Grey" }, { value: "none", label: "None, outline only" }] },
      { key: "badge", label: "Size badge", type: "boolean" }
    ]
  },
  {
    id: "image-swap",
    label: "Before and after",
    category: "tour",
    appliesTo: ["image"],
    description: "A second picture of the same screen takes over (the menu opened, the setting saved): cut on the frame a click lands, or a quick fade or wipe. Several on one picture step through screens.",
    defaultEase: "power2.out",
    defaultDuration: 0.25,
    defaults: { src: "", style: "cut" },
    fields: [{ key: "src", label: "Picture after (address or data URL)", type: "text" }, { key: "style", label: "Change", type: "select", options: [{ value: "cut", label: "Cut" }, { value: "fade", label: "Fade" }, { value: "wipe", label: "Wipe" }] }]
  },
  {
    id: "spotlight",
    label: "Spotlight",
    category: "tour",
    appliesTo: ALL,
    description: "Everything but this layer dims, with a rounded window around it, and stays that way until an Out clip. Follows the layer through camera moves.",
    defaultEase: "power2.inOut",
    defaultDuration: 0.5,
    defaults: { direction: "in", pad: 1.2, radius: 1.2, dim: 0.62 },
    fields: [DIRECTION, { key: "pad", label: "Room around it", type: "number", min: 0, max: 20, step: 0.1, unit: "su" }, { key: "radius", label: "Corners", type: "number", min: 0, max: 30, step: 0.1, unit: "su" }, { key: "dim", label: "Shade", type: "number", min: 0, max: 1, step: 0.05 }]
  },
  {
    id: "lift",
    label: "Magnify",
    category: "tour",
    appliesTo: ALL,
    description: "The layer comes forward, larger, on a soft shadow (with a coloured ring if you give one), and stays that way until an Out clip. Made for a piece cut out of a screenshot: the option being talked about lifts off the screen.",
    defaultEase: "power3.out",
    defaultDuration: 0.45,
    defaults: { direction: "in", scale: 1.25, shadow: true, ring: "" },
    fields: [DIRECTION, { key: "scale", label: "Size", type: "number", min: 1, max: 3, step: 0.05 }, { key: "shadow", label: "Shadow", type: "boolean" }, { key: "ring", label: "Ring colour", type: "color" }]
  },
  {
    id: "callout",
    label: "Callout",
    category: "tour",
    appliesTo: ALL,
    description: 'A labelled pill beside this layer, joined to it by a short line, saying what it is ("Save your changes here"). Stays until an Out clip.',
    defaultEase: "power3.out",
    defaultDuration: 0.45,
    defaults: { direction: "in", text: "Look here", side: "top", gap: 3, color: "#ffd166", size: 1.5 },
    fields: [
      DIRECTION,
      { key: "text", label: "Label", type: "text" },
      { key: "side", label: "Side", type: "select", options: [{ value: "top", label: "Above" }, { value: "right", label: "Right" }, { value: "bottom", label: "Below" }, { value: "left", label: "Left" }] },
      { key: "gap", label: "Distance", type: "number", min: 0, max: 30, step: 0.5, unit: "su" },
      { key: "color", label: "Colour", type: "color" },
      { key: "size", label: "Text size", type: "number", min: 0.5, max: 6, step: 0.1, unit: "su" }
    ]
  },
  // ---- Code (for Code layers: the layer draws itself from these clips) ----
  {
    id: "code-type",
    label: "Type code",
    category: "code",
    appliesTo: ["code"],
    description: "Types lines of the code in, character by character with a caret, in a natural rhythm: quick within a word, a beat at punctuation and new lines, indentation arriving with the line. The lines are hidden until typed. Several clips can type a file part by part, in step with a voice-over. Suggest shows an autocomplete popup while longer words are typed.",
    defaultEase: "none",
    defaultDuration: 3,
    defaults: { fromLine: 1, toLine: 0, suggest: false },
    fields: [
      { key: "fromLine", label: "From line", type: "number", min: 1, max: 2e3, step: 1 },
      { key: "toLine", label: "To line (0 = the end)", type: "number", min: 0, max: 2e3, step: 1 },
      { key: "suggest", label: "Autocomplete popup", type: "boolean" }
    ]
  },
  {
    id: "code-edit",
    label: "Change code",
    category: "code",
    appliesTo: ["code"],
    description: "Turns the code into a new version the way a person would edit it: each changed part is selected and deleted, then the new text is typed in its place, and lines slide to make room or close up. Give the whole new version; only what differs is touched.",
    defaultEase: "none",
    defaultDuration: 3,
    defaults: { to: "", suggest: false },
    fields: [{ key: "to", label: "New version", type: "longtext" }, { key: "suggest", label: "Autocomplete popup", type: "boolean" }]
  },
  {
    id: "code-highlight",
    label: "Highlight code",
    category: "code",
    appliesTo: ["code"],
    description: "Marks lines with a coloured band, or one word on a line with a box (give the word in Word). Stays until an Out clip for the same line.",
    defaultEase: "power2.out",
    defaultDuration: 0.4,
    defaults: { direction: "in", line: 1, toLine: 0, token: "", nth: 1, color: "#2ad38b" },
    fields: [
      DIRECTION,
      { key: "line", label: "Line", type: "number", min: 1, max: 2e3, step: 1 },
      { key: "toLine", label: "To line", type: "number", min: 0, max: 2e3, step: 1 },
      { key: "token", label: "Word", type: "text" },
      { key: "nth", label: "Which one on the line", type: "number", min: 1, max: 20, step: 1 },
      { key: "color", label: "Colour", type: "color" }
    ]
  },
  {
    id: "code-run",
    label: "Run code",
    category: "code",
    appliesTo: ["code"],
    description: "Presses the Run button and shows the output in a panel under the code, one line at a time over the clip.",
    defaultEase: "none",
    defaultDuration: 1.2,
    defaults: { output: "Hello, world", rows: 0 },
    fields: [{ key: "output", label: "Output", type: "longtext" }, { key: "rows", label: "Panel height (lines, 0 = fit)", type: "number", min: 0, max: 40, step: 1 }]
  },
  {
    id: "code-note",
    label: "Code note",
    category: "code",
    appliesTo: ["code"],
    description: 'A pill beside a line of the code, joined to it by a short dashed connector, explaining it ("sc.nextLine() reads the text into name"). Stays until an Out clip for the same line.',
    defaultEase: "power2.out",
    defaultDuration: 0.4,
    defaults: { direction: "in", line: 1, text: "What this line does", side: "right", color: "#2ad38b" },
    fields: [
      DIRECTION,
      { key: "line", label: "Line", type: "number", min: 1, max: 2e3, step: 1 },
      { key: "text", label: "Note", type: "text" },
      { key: "side", label: "Side", type: "select", options: [{ value: "right", label: "Right" }, { value: "left", label: "Left" }] },
      { key: "color", label: "Colour", type: "color" }
    ]
  },
  // ---- Short-form video effects ----
  {
    id: "gravity-drop",
    label: "Gravity drop",
    category: "text",
    appliesTo: ["text"],
    description: "Letters (or words) fall from above one after another, bounce and settle, each with a little tilt that straightens as it lands. Out, they drop away under gravity. Big, bold words suit it: a hook, the name of a thing.",
    defaultEase: "none",
    defaultDuration: 0.9,
    defaults: { direction: "in", by: "chars", height: 3, bounce: true, stagger: 0.05 },
    fields: [DIRECTION, BY, { key: "height", label: "Drop from", type: "number", min: 0.5, max: 10, step: 0.5, unit: "em" }, { key: "bounce", label: "Bounce", type: "boolean" }, STAGGER]
  },
  {
    id: "strip-in",
    label: "Fly-in strip",
    category: "reveal",
    appliesTo: ALL,
    description: "Flies in from a side and lands at a slant with a little overshoot, like a headline strip slapped on the screen. Give several tilted headline pills this, a moment apart and from alternating sides, for a headline storm.",
    defaultEase: "back.out(1.5)",
    defaultDuration: 0.45,
    defaults: { direction: "in", from: "right", tilt: -6 },
    fields: [DIRECTION, SIDE, { key: "tilt", label: "Slant", type: "number", min: -45, max: 45, step: 1, unit: "\xB0" }]
  },
  {
    id: "knockout",
    label: "Knockout",
    category: "text",
    appliesTo: ["text"],
    description: "The words are cut out of a solid block that wipes on, so the footage (or whatever is behind) shows through the letters. Knockout captions: big, heavy words over a talking head.",
    defaultEase: "power3.out",
    defaultDuration: 0.5,
    defaults: { direction: "in", fill: "#f4efe6", padding: 0.25 },
    fields: [DIRECTION, { key: "fill", label: "Block colour (light)", type: "color" }, { key: "padding", label: "Padding", type: "number", min: 0, max: 1, step: 0.05, unit: "em" }]
  },
  {
    id: "receipt",
    label: "Receipt printer",
    category: "reveal",
    appliesTo: ALL,
    description: "Prints out of a slot at the top of its box in short jerky feeds, like a receipt or a ticket: good for a slip, a card or a list arriving.",
    defaultEase: "none",
    defaultDuration: 1.2,
    defaults: { direction: "in", steps: 7 },
    fields: [DIRECTION, { key: "steps", label: "Feeds", type: "number", min: 2, max: 20, step: 1 }]
  },
  {
    id: "odometer",
    label: "Odometer",
    category: "text",
    appliesTo: ["text"],
    description: "The number in the text rolls into place like a car's odometer: every digit turns, and each only moves on when the one to its right passes 9. Write the final number in the text.",
    defaultEase: "power2.out",
    defaultDuration: 1.6,
    defaults: { from: 0 },
    fields: [{ key: "from", label: "Roll from", type: "number", step: 1 }]
  },
  {
    id: "timecode",
    label: "Running timecode",
    category: "text",
    appliesTo: ["text"],
    description: "A timecode in the text (00:00:00:00, hours to frames) runs while the clip plays, like a camera or an editor. Write a timecode in the text; the clip sets how long it runs.",
    defaultEase: "none",
    defaultDuration: 3,
    defaults: { from: 0, fps: 24 },
    fields: [{ key: "from", label: "Start at", type: "number", min: 0, step: 1, unit: "s" }, { key: "fps", label: "Frames a second", type: "number", min: 1, max: 60, step: 1 }]
  },
  {
    id: "strike",
    label: "Strike",
    category: "emphasis",
    appliesTo: ALL,
    description: 'A line is drawn through it, then it falls away, crossed out ("not this one"): an app icon struck off, a wrong answer, an old way of doing things.',
    defaultEase: "none",
    defaultDuration: 0.9,
    defaults: { direction: "in", color: "#ff3b47", thickness: 0.6, angle: -8, fall: true },
    fields: [DIRECTION, { key: "color", label: "Colour", type: "color" }, { key: "thickness", label: "Thickness", type: "number", min: 0.1, max: 3, step: 0.1, unit: "su" }, { key: "angle", label: "Angle", type: "number", min: -45, max: 45, step: 1, unit: "\xB0" }, { key: "fall", label: "Then it falls away", type: "boolean" }]
  },
  {
    id: "jiggle",
    label: "Jiggle",
    category: "emphasis",
    appliesTo: ALL,
    description: 'The phone home-screen wobble: quick, slight back-and-forth tilting, as before a delete or to say "you can change this".',
    defaultEase: "none",
    defaultDuration: 1.2,
    defaults: { angle: 2.5, speed: 7 },
    fields: [{ key: "angle", label: "Tilt", type: "number", min: 0.5, max: 12, step: 0.5, unit: "\xB0" }, { key: "speed", label: "Wobbles a second", type: "number", min: 1, max: 15, step: 0.5 }]
  },
  {
    id: "orbit-flat",
    label: "Orbit around",
    category: "motion",
    appliesTo: ALL,
    description: "Circles round its own place on a tilted ring, smaller and dimmer on the far side: icons orbiting a head, logos round a product. Place it where the centre of the orbit should be.",
    defaultEase: "none",
    defaultDuration: 3,
    defaults: { radius: 12, tilt: 0.35, turns: 1, start: 0 },
    fields: [{ key: "radius", label: "Radius", type: "number", min: 1, max: 60, step: 1, unit: "su" }, { key: "tilt", label: "Flatness", type: "number", min: 0, max: 1, step: 0.05 }, { key: "turns", label: "Turns", type: "number", min: -5, max: 5, step: 0.25 }, { key: "start", label: "Start angle", type: "number", min: 0, max: 360, step: 15, unit: "\xB0" }]
  },
  {
    id: "tick",
    label: "Tick",
    category: "emphasis",
    appliesTo: ALL,
    description: "A tick drawn in a circle beside it: a checklist item done. Give each item of a list this in turn for a checklist that ticks off.",
    defaultEase: "none",
    defaultDuration: 0.5,
    defaults: { direction: "in", side: "left", color: "#2ad38b" },
    fields: [DIRECTION, { key: "side", label: "Side", type: "select", options: [{ value: "left", label: "Left" }, { value: "right", label: "Right" }] }, { key: "color", label: "Colour", type: "color" }]
  },
  {
    id: "snap-zoom",
    label: "Snap zoom",
    category: "motion",
    appliesTo: ["video", "image", "shape", "group"],
    description: "A sharp punch-in on a point of the picture (the face, a detail), then held; out, it snaps back. On a talking head, on the punchline.",
    defaultEase: "expo.out",
    defaultDuration: 0.25,
    defaults: { direction: "in", zoom: 1.35, x: 50, y: 40 },
    fields: [DIRECTION, { key: "zoom", label: "Zoom", type: "number", min: 1, max: 4, step: 0.05, unit: "\xD7" }, { key: "x", label: "Towards (across)", type: "number", min: 0, max: 100, step: 1, unit: "%" }, { key: "y", label: "Towards (down)", type: "number", min: 0, max: 100, step: 1, unit: "%" }]
  },
  {
    id: "digital-zoom",
    label: "Digital zoom",
    category: "motion",
    appliesTo: ["video", "image"],
    description: "A camera's digital zoom: the picture steps in with a blur as the focus hunts, inside a recording frame (corners, REC, the zoom readout).",
    defaultEase: "power3.inOut",
    defaultDuration: 0.8,
    defaults: { direction: "in", zoom: 2, x: 50, y: 40 },
    fields: [DIRECTION, { key: "zoom", label: "Zoom", type: "number", min: 1, max: 6, step: 0.1, unit: "\xD7" }, { key: "x", label: "Towards (across)", type: "number", min: 0, max: 100, step: 1, unit: "%" }, { key: "y", label: "Towards (down)", type: "number", min: 0, max: 100, step: 1, unit: "%" }]
  },
  {
    id: "grade",
    label: "Colour grade",
    category: "emphasis",
    appliesTo: ["video", "image", "shape", "group"],
    description: "A colour grade fades in on the picture (not on words over it): black and white, noir, warm, cool, film, vivid, faded, teal and orange.",
    defaultEase: "power2.inOut",
    defaultDuration: 0.6,
    defaults: { direction: "in", look: "bw" },
    fields: [DIRECTION, { key: "look", label: "Look", type: "select", options: LOOK_OPTIONS }]
  },
  {
    id: "grade-wipe",
    label: "Grade wipe",
    category: "emphasis",
    appliesTo: ["video", "image", "shape", "group"],
    description: "A colour grade sweeps across behind a line with a handle, before on one side, after on the other: a grade slider (across), a mood curtain (down). It stays graded when the line has passed.",
    defaultEase: "power2.inOut",
    defaultDuration: 1.2,
    defaults: { direction: "in", look: "warm", axis: "x", labels: true },
    fields: [DIRECTION, { key: "look", label: "Look", type: "select", options: LOOK_OPTIONS }, { key: "axis", label: "Sweep", type: "select", options: [{ value: "x", label: "Across" }, { value: "y", label: "Down" }] }, { key: "labels", label: "Before and after labels", type: "boolean" }]
  },
  {
    id: "film",
    label: "Projected film",
    category: "ambient",
    appliesTo: ["video", "image", "shape", "group"],
    description: "Old projected film for as long as the clip lasts: grain, flicker, a vignette and the sprocket holes of the film strip running past (turn them off for a plain film look).",
    defaultEase: "none",
    defaultDuration: 2,
    defaults: { sprockets: true, grain: 0.35, flicker: 0.12 },
    fields: [{ key: "sprockets", label: "Sprocket holes", type: "boolean" }, { key: "grain", label: "Grain", type: "number", min: 0, max: 1, step: 0.05 }, { key: "flicker", label: "Flicker", type: "number", min: 0, max: 0.5, step: 0.01 }]
  },
  {
    id: "glass",
    label: "Liquid glass",
    category: "emphasis",
    appliesTo: ["video", "image", "shape", "group"],
    description: "A lens of liquid glass glides across the picture, blurring, brightening and saturating what is under it, with a bright rim and a slight wobble.",
    defaultEase: "power2.inOut",
    defaultDuration: 1.4,
    defaults: { size: 34, fromX: -20, fromY: 30, toX: 120, toY: 55 },
    fields: [{ key: "size", label: "Size", type: "number", min: 5, max: 100, step: 1, unit: "%" }, { key: "fromX", label: "From (across)", type: "number", min: -50, max: 150, step: 1, unit: "%" }, { key: "fromY", label: "From (down)", type: "number", min: -50, max: 150, step: 1, unit: "%" }, { key: "toX", label: "To (across)", type: "number", min: -50, max: 150, step: 1, unit: "%" }, { key: "toY", label: "To (down)", type: "number", min: -50, max: 150, step: 1, unit: "%" }]
  },
  {
    id: "portal",
    label: "Portal",
    category: "motion",
    appliesTo: ["video", "image"],
    description: "The picture shrinks into a ringed circle in a corner, picture in picture (out), or grows back out of one to fill the frame (in): make room for a demo, then come back.",
    defaultEase: "power3.inOut",
    defaultDuration: 0.7,
    defaults: { direction: "out", corner: "top-left", size: 30, color: "#ff6a2b" },
    fields: [DIRECTION, { key: "corner", label: "Corner", type: "select", options: [{ value: "top-left", label: "Top left" }, { value: "top-right", label: "Top right" }, { value: "bottom-left", label: "Bottom left" }, { value: "bottom-right", label: "Bottom right" }] }, { key: "size", label: "Circle size", type: "number", min: 10, max: 60, step: 1, unit: "%" }, { key: "color", label: "Ring colour", type: "color" }]
  },
  {
    id: "copies",
    label: "Copies",
    category: "ambient",
    appliesTo: ["video", "image"],
    description: "The picture in copies, all playing: a grid, a contact sheet filling up frame by frame, a picture dive (the frame inside the frame inside the frame, the camera diving in) or a feed of cards scrolling past.",
    defaultEase: "power1.inOut",
    defaultDuration: 1.6,
    defaults: { mode: "grid", columns: 3, rows: 3, gap: 1.5, background: "#0d0f12", hold: false, cards: 3 },
    fields: [
      { key: "mode", label: "Kind", type: "select", options: [{ value: "grid", label: "Playing grid" }, { value: "contact", label: "Contact sheet" }, { value: "dive", label: "Picture dive" }, { value: "feed", label: "Scrolling feed" }] },
      { key: "columns", label: "Columns", type: "number", min: 1, max: 8, step: 1 },
      { key: "rows", label: "Rows", type: "number", min: 1, max: 8, step: 1 },
      { key: "gap", label: "Gap", type: "number", min: 0, max: 10, step: 0.5, unit: "%" },
      { key: "background", label: "Background", type: "color" },
      { key: "hold", label: "Stay after the clip", type: "boolean" },
      { key: "cards", label: "Feed: cards scrolled", type: "number", min: 1, max: 12, step: 1 }
    ]
  },
  {
    id: "shatter",
    label: "Shatter",
    category: "transition",
    appliesTo: ["video", "image"],
    description: "The picture cracks from a point and breaks into shards that fly apart and fall (out), or fly together into place (in). With the person cut out above it, the background breaks while they stay: a frame break.",
    defaultEase: "none",
    defaultDuration: 1,
    defaults: { direction: "out", x: 50, y: 45 },
    fields: [DIRECTION, { key: "x", label: "Impact (across)", type: "number", min: 0, max: 100, step: 1, unit: "%" }, { key: "y", label: "Impact (down)", type: "number", min: 0, max: 100, step: 1, unit: "%" }]
  },
  {
    id: "follow",
    label: "Follow the face",
    category: "motion",
    appliesTo: ["text", "shape", "image", "model", "group", "path", "cursor", "captions"],
    description: "Keeps the layer on the face in a piece of footage while the clip runs: a circle drawn round it (live markup), a label above the head, captions below it, icons orbiting it. The footage needs its face found first (Footage, Follow the face, in the AI Dev Kit).",
    defaultEase: "none",
    defaultDuration: 3,
    defaults: { layer: "", at: "face", gap: 0.15, scale: false },
    fields: [
      { key: "layer", label: "Footage", type: "layer" },
      { key: "at", label: "Where", type: "select", options: [{ value: "face", label: "On the face" }, { value: "above", label: "Above it" }, { value: "below", label: "Below it" }, { value: "left", label: "Left of it" }, { value: "right", label: "Right of it" }] },
      { key: "gap", label: "Gap", type: "number", min: 0, max: 2, step: 0.05, unit: "\xD7 face" },
      { key: "scale", label: "Grow and shrink with the face", type: "boolean" }
    ]
  },
  {
    id: "sticker",
    label: "Sticker outline",
    category: "emphasis",
    appliesTo: ["video", "image", "shape", "text", "model", "group"],
    description: "A white outline grows round the shape with a soft shadow and a slight pop, like a cut-out sticker: a person cut out of footage on a coloured backdrop (paper cut-out), a logo, an icon.",
    defaultEase: "back.out(1.6)",
    defaultDuration: 0.4,
    defaults: { direction: "in", width: 0.8, color: "#ffffff" },
    fields: [DIRECTION, { key: "width", label: "Outline", type: "number", min: 0.1, max: 3, step: 0.1, unit: "su" }, { key: "color", label: "Colour", type: "color" }]
  },
  // ---- Scene transitions (for groups: an "out" on the scene leaving, an "in" on the next) ----
  {
    id: "tr-tear",
    label: "Paper tear",
    category: "transition",
    appliesTo: ALL,
    description: "The sheet tears across the stage with a pale ragged edge; the next scene is revealed behind the rip.",
    defaultEase: "softInOut",
    defaultDuration: 0.7,
    defaults: { direction: "in", rough: 3, edge: true, color: "#fbf7ee" },
    fields: [DIRECTION, { key: "rough", label: "Ragged edge", type: "number", min: 0.5, max: 8, step: 0.5 }, { key: "edge", label: "Torn edge", type: "boolean" }, { key: "color", label: "Edge colour", type: "color" }]
  },
  {
    id: "tr-page",
    label: "Page turn",
    category: "transition",
    appliesTo: ALL,
    description: "The scene turns like a page from its left edge, with a soft shadow, uncovering the next one.",
    defaultEase: "power2.inOut",
    defaultDuration: 0.8,
    defaults: { direction: "in" },
    fields: [DIRECTION]
  },
  {
    id: "tr-tape",
    label: "Tape pull",
    category: "transition",
    appliesTo: ALL,
    description: "A strip of masking tape is pulled across the stage, taking the old picture with it.",
    defaultEase: "power2.inOut",
    defaultDuration: 0.6,
    defaults: { direction: "in", color: "#e6d39a" },
    fields: [DIRECTION, { key: "color", label: "Tape colour", type: "color" }]
  },
  {
    id: "tr-slash",
    label: "Slash",
    category: "transition",
    appliesTo: ALL,
    description: "A glowing diagonal line sweeps across the stage; the scene appears (or disappears) behind it.",
    defaultEase: "softInOut",
    defaultDuration: 0.6,
    defaults: { direction: "in", angle: 25, color: "#e9ff3b", glow: true },
    fields: [DIRECTION, { key: "angle", label: "Slant", type: "number", min: -60, max: 60, step: 1, unit: "\xB0" }, { key: "color", label: "Line colour", type: "color" }, { key: "glow", label: "Glowing line", type: "boolean" }]
  },
  {
    id: "tr-flash",
    label: "Flash",
    category: "transition",
    appliesTo: ALL,
    description: "A burst of light: the scene cuts at its brightest moment.",
    defaultEase: "none",
    defaultDuration: 0.5,
    defaults: { direction: "in", color: "#ffffff", strength: 100 },
    fields: [DIRECTION, { key: "color", label: "Colour", type: "color" }, { key: "strength", label: "Strength", type: "number", min: 10, max: 100, step: 5, unit: "%" }]
  },
  {
    id: "tr-dip",
    label: "Dip to colour",
    category: "transition",
    appliesTo: ALL,
    description: "The screen fills with a colour, holds a beat, and opens on the next scene.",
    defaultEase: "none",
    defaultDuration: 0.8,
    defaults: { direction: "in", color: "#000000" },
    fields: [DIRECTION, { key: "color", label: "Colour", type: "color" }]
  },
  {
    id: "tr-whip",
    label: "Whip pan",
    category: "transition",
    appliesTo: ALL,
    description: "One fast camera swing: the scene speeds away with a blur along the move and the next arrives from the same side at the same speed, settling into place. Light streak flares across the screen on the cut to hide the join.",
    defaultEase: "none",
    defaultDuration: 0.5,
    defaults: { direction: "in", from: "right", distance: 100, blur: 1.6, streak: false, color: "#ffffff" },
    fields: [DIRECTION, SIDE, { key: "distance", label: "Distance", type: "number", min: 10, max: 150, step: 5, unit: "%" }, { key: "blur", label: "Blur", type: "number", min: 0, max: 4, step: 0.1 }, { key: "streak", label: "Light streak", type: "boolean" }, { key: "color", label: "Streak colour", type: "color" }]
  },
  {
    id: "tr-zoom",
    label: "Zoom through",
    category: "transition",
    appliesTo: ALL,
    description: "The scene rushes past the camera, or approaches from the distance.",
    defaultEase: "softInOut",
    defaultDuration: 0.6,
    defaults: { direction: "in", scale: 4, blur: 0.8 },
    fields: [DIRECTION, { key: "scale", label: "Zoom", type: "number", min: 1.2, max: 10, step: 0.1, unit: "\xD7" }, { key: "blur", label: "Blur", type: "number", min: 0, max: 4, step: 0.1 }]
  },
  {
    id: "tr-streak",
    label: "Light streak",
    category: "transition",
    appliesTo: ALL,
    description: "A horizontal flare of light races across the screen and the scenes swap at its brightest.",
    defaultEase: "none",
    defaultDuration: 0.5,
    defaults: { direction: "in", color: "#7cc4ff", from: "left" },
    fields: [DIRECTION, { key: "color", label: "Colour", type: "color" }, { key: "from", label: "Sweeps from", type: "select", options: [{ value: "left", label: "Left" }, { value: "right", label: "Right" }] }]
  },
  {
    id: "tr-glitch",
    label: "Glitch",
    category: "transition",
    appliesTo: ALL,
    description: "Slices jump and colours split for a few frames, then the cut, like a broken signal.",
    defaultEase: "none",
    defaultDuration: 0.45,
    defaults: { direction: "in", intensity: 60 },
    fields: [DIRECTION, { key: "intensity", label: "Intensity", type: "number", min: 10, max: 100, step: 5, unit: "%" }]
  },
  {
    id: "soft-wipe",
    label: "Soft wipe",
    category: "reveal",
    appliesTo: ALL,
    description: "A wipe with a feathered edge: the layer fades in (or out) along a moving soft line.",
    defaultEase: "softInOut",
    defaultDuration: 0.7,
    defaults: { direction: "in", from: "left", feather: 25 },
    fields: [DIRECTION, SIDE, { key: "feather", label: "Feather", type: "number", min: 1, max: 80, step: 1, unit: "%" }]
  },
  {
    id: "blinds",
    label: "Blinds",
    category: "reveal",
    appliesTo: ALL,
    description: "Revealed (or hidden) in strips, one after another, like a stair wipe.",
    defaultEase: "softLand",
    defaultDuration: 0.8,
    defaults: { direction: "in", from: "top", count: 6, stagger: 0.5 },
    fields: [DIRECTION, { key: "from", label: "From", type: "select", options: [{ value: "top", label: "Top" }, { value: "bottom", label: "Bottom" }, { value: "left", label: "Left" }, { value: "right", label: "Right" }] }, { key: "count", label: "Strips", type: "number", min: 2, max: 24, step: 1 }, { key: "stagger", label: "Stagger", type: "number", min: 0, max: 0.9, step: 0.05 }]
  },
  {
    id: "turn",
    label: "Turn",
    category: "motion",
    appliesTo: ALL,
    description: "Turns into place in 3D, around the vertical or horizontal axis, as if on a hinge through its middle.",
    defaultEase: "softLand",
    defaultDuration: 0.7,
    defaults: { direction: "in", axis: "y", angle: 90, perspective: 900 },
    fields: [DIRECTION, { key: "axis", label: "Axis", type: "select", options: [{ value: "y", label: "Vertical" }, { value: "x", label: "Horizontal" }] }, { key: "angle", label: "Angle", type: "number", min: -180, max: 180, step: 5, unit: "\xB0" }, { key: "perspective", label: "Depth", type: "number", min: 200, max: 3e3, step: 50, unit: "px" }]
  },
  {
    id: "sheen",
    label: "Sheen",
    category: "emphasis",
    appliesTo: ["shape", "image", "video"],
    description: "A band of light sweeps across once. Best after the layer has settled.",
    defaultEase: "softInOut",
    defaultDuration: 0.9,
    defaults: { angle: 110, width: 22, strength: 0.45, color: "#ffffff" },
    fields: [{ key: "angle", label: "Angle", type: "number", min: 0, max: 360, step: 5, unit: "\xB0" }, { key: "width", label: "Width", type: "number", min: 5, max: 60, step: 1, unit: "%" }, { key: "strength", label: "Strength", type: "number", min: 0, max: 1, step: 0.05 }, { key: "color", label: "Colour", type: "color" }]
  },
  {
    id: "select-box",
    label: "Select box",
    category: "emphasis",
    appliesTo: ["text"],
    description: "Draws a coloured box with square corner handles around one word (or a few) of the text, like a selected object in a design tool, and tints the word to match. The key word of a headline.",
    defaultEase: "back.out(1.6)",
    defaultDuration: 0.6,
    defaults: { direction: "in", word: 1, words: 1, color: "#3b82f6", tint: true, handles: true, padding: 0.2, stroke: 0.18 },
    fields: [
      DIRECTION,
      { key: "word", label: "Word", type: "number", min: 1, max: 200, step: 1 },
      { key: "words", label: "How many words", type: "number", min: 1, max: 20, step: 1 },
      { key: "color", label: "Colour", type: "color" },
      { key: "tint", label: "Tint the words", type: "boolean" },
      { key: "handles", label: "Corner handles", type: "boolean" },
      { key: "padding", label: "Padding", type: "number", min: 0, max: 1, step: 0.01, unit: "em" },
      { key: "stroke", label: "Line width", type: "number", min: 0.05, max: 1, step: 0.01 }
    ]
  },
  {
    id: "scroll",
    label: "Scroll",
    category: "motion",
    appliesTo: ["image"],
    description: "Scrolls a tall screenshot inside its frame (or pans a wide one across), from one point to another. Make the frame shorter than the picture. Repeat makes it endless: the picture follows on from itself, and 0 to 100 is one full pass, so a looping ending joins up seamlessly (use the None ease for a steady speed).",
    defaultEase: "power1.inOut",
    defaultDuration: 6,
    defaults: { from: 0, to: 100, axis: "y", repeat: false },
    fields: [{ key: "from", label: "From", type: "number", min: 0, max: 100, step: 1, unit: "%" }, { key: "to", label: "To", type: "number", min: 0, max: 1e3, step: 1, unit: "%" }, { key: "axis", label: "Direction", type: "select", options: [{ value: "y", label: "Down" }, { value: "x", label: "Across" }] }, { key: "repeat", label: "Repeat (endless)", type: "boolean" }]
  },
  {
    id: "drift",
    label: "Drift",
    category: "ambient",
    appliesTo: ALL,
    description: "A slow, steady move and scale creep that keeps a held frame alive.",
    defaultEase: "cruise",
    defaultDuration: 3,
    defaults: { x: 4, y: -3, scale: 1.04, rotate: 0 },
    fields: [{ key: "x", label: "Move X", type: "number", min: -100, max: 100, step: 1, unit: "%" }, { key: "y", label: "Move Y", type: "number", min: -100, max: 100, step: 1, unit: "%" }, { key: "scale", label: "Scale to", type: "number", min: 0.5, max: 2, step: 0.01 }, { key: "rotate", label: "Rotate", type: "number", min: -45, max: 45, step: 1, unit: "\xB0" }]
  },
  {
    id: "gradient-flow",
    label: "Gradient flow",
    category: "ambient",
    appliesTo: ["shape"],
    description: "A shape\u2019s gradient fill flows across it and back. Give the shape a gradient fill.",
    defaultEase: "none",
    defaultDuration: 4,
    defaults: { axis: "x", cycles: 1 },
    fields: [{ key: "axis", label: "Direction", type: "select", options: [{ value: "x", label: "Across" }, { value: "y", label: "Up and down" }, { value: "diagonal", label: "Diagonal" }] }, { key: "cycles", label: "Cycles", type: "number", min: 1, max: 10, step: 1 }]
  },
  {
    id: "particles",
    label: "Particles",
    category: "ambient",
    appliesTo: ["shape"],
    description: "A field of small dots rising, falling or drifting inside the shape. Clear the shape\u2019s fill to show the particles on their own.",
    defaultEase: "none",
    defaultDuration: 4,
    defaults: { count: 28, size: 1.2, speed: 0.12, direction: "up", color: "#ffffff", twinkle: true },
    fields: [{ key: "count", label: "Count", type: "number", min: 1, max: 150, step: 1 }, { key: "size", label: "Size", type: "number", min: 0.2, max: 10, step: 0.1, unit: "%" }, { key: "speed", label: "Speed", type: "number", min: 0, max: 2, step: 0.01, unit: "/s" }, { key: "direction", label: "Direction", type: "select", options: [{ value: "up", label: "Rise" }, { value: "down", label: "Fall" }, { value: "drift", label: "Drift" }] }, { key: "color", label: "Colour", type: "color" }, { key: "twinkle", label: "Twinkle", type: "boolean" }]
  },
  // ---- 3D (3D layers only: they turn the object and move the camera) ----
  {
    id: "spin-3d",
    label: "Spin 3D",
    category: "3d",
    appliesTo: ["model"],
    description: "The object turns around one of its axes, a set number of times.",
    defaultEase: "softInOut",
    defaultDuration: 2,
    defaults: { axis: "y", turns: 1 },
    fields: [{ key: "axis", label: "Axis", type: "select", options: [{ value: "y", label: "Upright (Y)" }, { value: "x", label: "Forward (X)" }, { value: "z", label: "Flat (Z)" }] }, { key: "turns", label: "Turns", type: "number", min: -10, max: 10, step: 0.25 }]
  },
  {
    id: "tumble-in",
    label: "Tumble in",
    category: "3d",
    appliesTo: ["model"],
    description: "The object tumbles into its pose from a turned, smaller start (or tumbles away).",
    defaultEase: "snapSettle",
    defaultDuration: 1.1,
    defaults: { direction: "in", turn: 140, tilt: -50, scale: 0.4 },
    fields: [DIRECTION, { key: "turn", label: "Turn", type: "number", min: -720, max: 720, step: 5, unit: "\xB0" }, { key: "tilt", label: "Tilt", type: "number", min: -180, max: 180, step: 5, unit: "\xB0" }, { key: "scale", label: "Start scale", type: "number", min: 0, max: 3, step: 0.05 }]
  },
  {
    id: "orbit-3d",
    label: "Orbit",
    category: "3d",
    appliesTo: ["model"],
    description: "The camera circles the object, rising or dipping as it goes.",
    defaultEase: "softInOut",
    defaultDuration: 3,
    defaults: { angle: 50, tilt: 10 },
    fields: [{ key: "angle", label: "Around", type: "number", min: -360, max: 360, step: 5, unit: "\xB0" }, { key: "tilt", label: "Rise", type: "number", min: -60, max: 60, step: 1, unit: "\xB0" }]
  },
  {
    id: "camera-push",
    label: "Camera push",
    category: "3d",
    appliesTo: ["model"],
    description: "The camera moves in from further away (or pulls back out).",
    defaultEase: "softLand",
    defaultDuration: 1.4,
    defaults: { direction: "in", distance: 2.2 },
    fields: [DIRECTION, { key: "distance", label: "Start distance", type: "number", min: 0.3, max: 8, step: 0.1, unit: "\xD7" }]
  },
  {
    id: "code",
    label: "Custom code",
    category: "motion",
    appliesTo: ALL,
    description: "Your own GSAP code, for an effect no preset covers. It only runs where the page allows custom code (the Studio, downloaded pages and embeds; in WordPress, pages by authors trusted with unfiltered HTML).",
    defaultEase: "none",
    defaultDuration: 1,
    defaults: { code: "tl.fromTo(el, { rotation: 0 }, { rotation: 360, duration: duration, ease: 'power2.inOut' }, at);" },
    fields: [{ key: "code", label: "Code", type: "code" }],
    aiExcluded: true
  },
  // ---- Looks for motion-design styles (hand-drawn, liquid, pixel art, paint, print, VHS, text looks) ----
  {
    id: "sketch",
    label: "Hand-drawn",
    category: "ambient",
    appliesTo: ["shape"],
    description: "The shape is redrawn with wobbly pencil lines and a scribbled fill. It holds for the rest of the layer; each shape keeps its own scribble, on every play and export.",
    defaultEase: "none",
    defaultDuration: 3,
    defaults: { style: "hachure", roughness: 1.4, bowing: 1, weight: 1.6, gap: 6, angle: -41, fps: 0 },
    fields: [{ key: "style", label: "Fill", type: "select", options: [{ value: "hachure", label: "Scribble" }, { value: "cross-hatch", label: "Cross-hatch" }, { value: "zigzag", label: "Zigzag" }, { value: "dots", label: "Dots" }, { value: "solid", label: "Solid" }, { value: "none", label: "Outline only" }] }, { key: "roughness", label: "Roughness", type: "number", min: 0, max: 5, step: 0.1 }, { key: "bowing", label: "Bowing", type: "number", min: 0, max: 5, step: 0.1 }, { key: "weight", label: "Line weight", type: "number", min: 0.5, max: 6, step: 0.1 }, { key: "gap", label: "Scribble gap", type: "number", min: 2, max: 20, step: 0.5 }, { key: "angle", label: "Scribble angle", type: "number", min: -90, max: 90, step: 1, unit: "\xB0" }, { key: "color", label: "Line colour", type: "color" }, { key: "fill", label: "Fill colour", type: "color" }, { key: "fps", label: "Redraws per second", type: "number", min: 0, max: 12, step: 1 }]
  },
  {
    id: "paper",
    label: "Cut paper",
    category: "ambient",
    appliesTo: ALL,
    description: "Construction paper: a hand-cut edge, a fine grain and a shadow lifting it off the layer below. It holds for the rest of the layer. On text with a pill it makes a torn paper tag.",
    defaultEase: "none",
    defaultDuration: 3,
    defaults: { rough: 2.5, grain: 0.3, lift: 1, fps: 0 },
    fields: [{ key: "rough", label: "Rough edge", type: "number", min: 0, max: 12, step: 0.5 }, { key: "grain", label: "Paper grain", type: "number", min: 0, max: 1, step: 0.05 }, { key: "lift", label: "Shadow", type: "number", min: 0, max: 4, step: 0.1 }, { key: "fps", label: "Re-cuts per second", type: "number", min: 0, max: 12, step: 1 }]
  },
  {
    id: "boil",
    label: "Line boil",
    category: "ambient",
    appliesTo: ALL,
    description: "Hand-drawn cel animation: the outlines wobble a little on every drawing, redrawn a few times a second, for as long as the clip lasts.",
    defaultEase: "none",
    defaultDuration: 3,
    defaults: { amount: 2.5, fps: 8 },
    fields: [{ key: "amount", label: "Wobble", type: "number", min: 0.5, max: 10, step: 0.5 }, { key: "fps", label: "Drawings per second", type: "number", min: 2, max: 24, step: 1 }]
  },
  {
    id: "liquid",
    label: "Liquid blob",
    category: "ambient",
    appliesTo: ["shape", "image", "video"],
    description: "The shape flows from one organic blob into the next, as if it were poured: liquid and morph styles.",
    defaultEase: "none",
    defaultDuration: 4,
    defaults: { speed: 1 },
    fields: [{ key: "speed", label: "Speed", type: "number", min: 0.2, max: 4, step: 0.1 }]
  },
  {
    id: "pixelate",
    label: "Pixelate",
    category: "reveal",
    appliesTo: ALL,
    description: "Pixel art: the layer resolves out of big square pixels (or breaks up into them, out).",
    defaultEase: "steps(8)",
    defaultDuration: 0.8,
    defaults: { direction: "in", size: 24 },
    fields: [DIRECTION, { key: "size", label: "Biggest pixel", type: "number", min: 2, max: 80, step: 1, unit: "px" }]
  },
  {
    id: "brush",
    label: "Brush strokes",
    category: "reveal",
    appliesTo: ALL,
    description: "Watercolour and ink: the layer paints on in a few brush strokes, row after row, each with a ragged end.",
    defaultEase: "power1.inOut",
    defaultDuration: 1.2,
    defaults: { direction: "in", strokes: 4, from: "left" },
    fields: [DIRECTION, { key: "strokes", label: "Strokes", type: "number", min: 1, max: 8, step: 1 }, { key: "from", label: "From", type: "select", options: [{ value: "left", label: "Left" }, { value: "right", label: "Right" }] }]
  },
  {
    id: "halftone",
    label: "Risograph",
    category: "emphasis",
    appliesTo: ["image", "video", "shape", "text", "group"],
    description: "Risograph print: halftone dots over the layer and a second ink printed slightly out of register.",
    defaultEase: "power2.out",
    defaultDuration: 0.6,
    defaults: { direction: "in", dot: 1.2, ink: "#ff4f8b", offset: 0.5 },
    fields: [DIRECTION, { key: "dot", label: "Dot size", type: "number", min: 0.4, max: 4, step: 0.1, unit: "cqw" }, { key: "ink", label: "Second ink", type: "color" }, { key: "offset", label: "Misregistration", type: "number", min: 0, max: 2, step: 0.05, unit: "cqw" }]
  },
  {
    id: "scanlines",
    label: "VHS / CRT",
    category: "ambient",
    appliesTo: ["image", "video", "shape", "text", "group"],
    description: "An old tape or tube for as long as the clip lasts: scanlines, colour bleeding into red and blue fringes, a vignette, a jittering frame and a tracking band rolling down.",
    defaultEase: "none",
    defaultDuration: 3,
    defaults: { bleed: 0.35, jitter: 0.25, tracking: true },
    fields: [{ key: "bleed", label: "Colour bleed", type: "number", min: 0, max: 1.5, step: 0.05 }, { key: "jitter", label: "Jitter", type: "number", min: 0, max: 1, step: 0.05 }, { key: "tracking", label: "Tracking band", type: "boolean" }]
  },
  {
    id: "text-outline",
    label: "Outline",
    category: "text",
    appliesTo: ["text"],
    description: "The fill drains out of the letters, leaving their outline (in the text colour, or one you choose).",
    defaultEase: "power2.out",
    defaultDuration: 0.6,
    defaults: { direction: "in", width: 0.12, color: "" },
    fields: [DIRECTION, { key: "width", label: "Line", type: "number", min: 0.03, max: 0.6, step: 0.01, unit: "cqw" }, { key: "color", label: "Colour", type: "color" }]
  },
  {
    id: "text-3d",
    label: "3D offset",
    category: "text",
    appliesTo: ["text"],
    description: "Solid layers stack up under the letters, growing out diagonally as if the type were extruded.",
    defaultEase: "power3.out",
    defaultDuration: 0.7,
    defaults: { direction: "in", depth: 6, step: 0.12, color: "" },
    fields: [DIRECTION, { key: "depth", label: "Depth", type: "number", min: 1, max: 14, step: 1 }, { key: "step", label: "Step", type: "number", min: 0.04, max: 0.5, step: 0.01, unit: "cqw" }, { key: "color", label: "Shadow colour", type: "color" }]
  },
  {
    id: "text-gradient",
    label: "Gradient letters",
    category: "text",
    appliesTo: ["text"],
    description: "A gradient fills the letters and travels slowly through them while the clip plays.",
    defaultEase: "none",
    defaultDuration: 3,
    defaults: { from: "#ff5f6d", to: "#ffc371", angle: 90 },
    fields: [{ key: "from", label: "From", type: "color" }, { key: "to", label: "To", type: "color" }, { key: "angle", label: "Angle", type: "number", min: 0, max: 360, step: 5, unit: "\xB0" }]
  },
  {
    id: "text-skew",
    label: "Skew",
    category: "text",
    appliesTo: ["text"],
    description: "The letters lean into the motion (or straighten up again, out).",
    defaultEase: "power3.out",
    defaultDuration: 0.5,
    defaults: { direction: "in", angle: -12 },
    fields: [DIRECTION, { key: "angle", label: "Lean", type: "number", min: -30, max: 30, step: 1, unit: "\xB0" }]
  }
];
var PRESET_IDS = PRESET_CATALOG.map((p) => p.id);
var presetMeta = Object.fromEntries(PRESET_CATALOG.map((p) => [p.id, p]));

// apps/studio/src/lib/swarm.ts
var SWARM_DEFAULTS = {
  cursors: 0,
  at: 0,
  speed: 1,
  sound: true,
  maxLayers: 30,
  names: ["Ana", "Kai", "Mia", "Leo", "Zoe", "Sam", "Ivy", "Max"],
  colors: ["#00b295", "#ff4d5e", "#4c7dff", "#f5a623", "#a855f7", "#0ea5e9", "#f97316", "#ec4899"]
};
var PREFIX = "swarm-";
var r2 = (v) => Math.round(v * 100) / 100;
var clamp = (v, a, b) => Math.max(a, Math.min(b, v));
var BUILDABLE = /* @__PURE__ */ new Set(["text", "shape", "image", "video", "model", "group", "path", "diagram", "code", "repeat", "lottie"]);
function stageAspect(scene) {
  const a = scene.stage.breakpoints[0]?.aspect ?? [16, 9];
  return a[0] / a[1];
}
function rectOf(layer, aspect) {
  const b = layer.box;
  if (!b) return null;
  let w = typeof b.w === "number" ? b.w : 0;
  let h = typeof b.ratio === "number" && b.ratio > 0 ? w / b.ratio * aspect : typeof b.h === "number" ? b.h : 0;
  if (layer.type === "text") {
    const size = layer.style?.fontSize ?? 4;
    const lines = layer.text.split("\n");
    const longest = Math.max(...lines.map((l) => l.replace(/\*/g, "").length));
    if (!w) w = Math.min(100, Math.max(size, longest * size * 0.55));
    if (!h) h = size * 1.25 * lines.length * aspect;
  }
  if (!w) w = 20;
  if (!h) h = 12;
  const a = b.anchor ?? "center";
  const x = b.x - (/left/.test(a) ? 0 : /right/.test(a) ? w : w / 2);
  const y = b.y - (/top/.test(a) ? 0 : /bottom/.test(a) ? h : h / 2);
  return { x, y, w, h };
}
function isEntrance(c) {
  const m = presetMeta[c.preset];
  if (!m) return false;
  const dir = c.params?.direction ?? m.defaults?.direction;
  if (dir === "out") return false;
  if (dir === "in") return true;
  return m.category === "reveal" || m.category === "transition";
}
function shiftLayer(layer, from, by) {
  const out = { ...layer };
  const startStays = !(typeof out.start === "number" && out.start > from);
  if (!startStays) out.start = r2(out.start + by);
  if (typeof out.end === "number" && out.end > from) out.end = r2(out.end + by);
  out.clips = layer.clips.map((c) => c.start >= from ? { ...c, start: r2(c.start + by) } : c);
  if (out.type === "group" && startStays) {
    const local = Math.max(0, from - (out.start ?? 0));
    out.layers = out.layers.map((child) => shiftLayer(child, local, by));
    if (typeof out.duration === "number") out.duration = r2(out.duration + by);
  }
  return out;
}
function buildWithCursors(scene, options = {}) {
  if (scene.layers.some((l) => l.id.startsWith(PREFIX))) {
    throw new Error("This scene already has a cursor build. Undo it (or start from the scene before it) to build again.");
  }
  const o = { ...SWARM_DEFAULTS, ...options };
  const at = Math.max(0, o.at ?? 0);
  const speed = clamp(o.speed || 1, 0.5, 3);
  const aspect = stageAspect(scene);
  const portrait = aspect < 1;
  const k = 1 / speed;
  const opening = (l) => {
    if ((l.start ?? 0) > at + 0.05 || l.end !== void 0 && l.end <= at + 0.5) return false;
    const first = [...l.clips].sort((x, y) => x.start - y.start)[0];
    return !first || !isEntrance(first) || first.start <= at + 2;
  };
  const targets = scene.layers.filter((l) => BUILDABLE.has(l.type) && opening(l) && (l.opacity ?? 1) > 0.02 && !l.pin).map((l) => ({ layer: l, rect: rectOf(l, aspect) })).filter((t) => !!t.rect).sort((a, b) => {
    const big = (t) => t.rect.w * t.rect.h >= 2500 ? 0 : 1;
    return big(a) - big(b) || a.rect.y - b.rect.y || a.rect.x - b.rect.x;
  }).slice(0, Math.max(1, o.maxLayers));
  if (!targets.length) throw new Error("Nothing to build: no layers are on the stage at that moment.");
  const count = o.cursors && o.cursors > 0 ? clamp(Math.round(o.cursors), 1, 8) : clamp(Math.round(targets.length / 3), 3, 6);
  const names = o.names ?? SWARM_DEFAULTS.names;
  const colors = o.colors?.length ? o.colors : SWARM_DEFAULTS.colors;
  const cw = portrait ? 5.4 : 2.6;
  const cursors = Array.from({ length: count }, (_, i) => {
    const px = count === 1 ? 50 : -6 + 112 * i / (count - 1);
    const py = i % 2 ? 112 : 106;
    return { i, free: at + 0.08 * i, px, py, clips: [], first: true };
  });
  const built = {};
  let seq = 0;
  const id = () => `${PREFIX}${++seq}`;
  let end = at;
  for (const { layer, rect } of targets) {
    const cur = cursors.reduce((a, b) => b.free < a.free ? b : a);
    const color = colors[cur.i % colors.length];
    const move = r2((cur.first ? 0.8 : 0.45) * k);
    const area = rect.w * rect.h / 1e4;
    const drag = r2(clamp(0.38 + area * 0.9, 0.4, 1.05) * k);
    const s = r2(cur.free);
    cur.first = false;
    cur.clips.push({ id: id(), preset: "cursor-move", start: s, duration: move, ease: "power3.inOut", params: { to: layer.id, x: 0, y: 0 } });
    const d0 = r2(s + move);
    cur.clips.push({
      id: id(),
      preset: "cursor-drag",
      start: d0,
      duration: drag,
      ease: "power2.inOut",
      params: { to: layer.id, x: 100, y: 100 },
      ...o.sound ? { sound: { name: "click", volume: 0.3 } } : {}
    });
    const clips = [];
    if (layer.type === "text") {
      const hold = r2(0.22 * k);
      clips.push({
        id: id(),
        preset: "build-draw",
        start: d0,
        duration: r2(drag + hold),
        ease: "none",
        params: { color, draw: r2(drag / (drag + hold)), reveal: "none", fill: "none", badge: true }
      });
      const chars = layer.text.replace(/\*/g, "").length;
      const type = r2(clamp(chars * 0.045, 0.35, 2.4) * k);
      const t0 = r2(d0 + drag + 0.12 * k);
      const firstLine = r2(50 / Math.max(1, layer.text.split("\n").length));
      cur.clips.push({ id: id(), preset: "cursor-move", start: r2(d0 + drag), duration: r2(0.12 * k), ease: "power2.out", params: { to: layer.id, x: 0, y: firstLine } });
      cur.clips.push({
        id: id(),
        preset: "cursor-type",
        start: t0,
        duration: type,
        ease: "none",
        ...o.sound ? { sound: { name: "typing", volume: 0.35 } } : {}
      });
      clips.push({ id: id(), preset: "text-typewriter", start: t0, duration: type, ease: "none", params: { direction: "in", caret: false } });
      cur.free = r2(t0 + type + 0.05);
    } else {
      const reveal = r2(0.42 * k);
      clips.push({
        id: id(),
        preset: "build-draw",
        start: d0,
        duration: r2(drag + reveal),
        ease: "none",
        params: { color, draw: r2(drag / (drag + reveal)), reveal: "sweep", fill: "grey", badge: true }
      });
      cur.free = r2(d0 + drag + 0.06);
    }
    built[layer.id] = clips;
    end = Math.max(end, cur.free, ...clips.map((c) => c.start + c.duration));
  }
  const leave = r2(end + 0.15);
  cursors.forEach((c, i) => {
    c.clips.push({ id: id(), preset: "cursor-move", start: r2(leave + 0.06 * i), duration: r2(0.7 * k), ease: "power2.in", params: { px: c.px < 50 ? -12 : 112, py: 30 + i * 37 % 60 } });
  });
  const length = r2(leave + 0.7 * k + 0.06 * count - at);
  const shifted = scene.layers.map((l) => {
    const moved = shiftLayer(l, at, length);
    const mine = built[l.id];
    if (!mine) return moved;
    const keep = moved.clips.filter((c) => !(isEntrance(c) && c.start >= at + length - 0.01 && c.start <= at + length + 2.5));
    return { ...moved, clips: [...mine, ...keep].sort((a, b) => a.start - b.start) };
  });
  const cursorLayers = cursors.map((c) => ({
    id: `${PREFIX}cursor-${c.i + 1}`,
    type: "cursor",
    name: `Cursor ${names[c.i] ?? c.i + 1}`,
    box: { x: r2(c.px), y: r2(c.py), w: cw, ratio: 0.7 },
    color: colors[c.i % colors.length],
    ...names.length ? { label: names[c.i % names.length] } : {},
    clips: c.clips
  }));
  const next = {
    ...scene,
    duration: r2(scene.duration + length),
    layers: [...shifted, ...cursorLayers],
    ...scene.markers ? { markers: scene.markers.map((m) => m.t >= at ? { ...m, t: r2(m.t + length) } : m) } : {},
    ...scene.audio ? { audio: scene.audio.map((a) => a.start >= at ? { ...a, start: r2(a.start + length) } : a) } : {},
    ...scene.camera ? { camera: { ...scene.camera, keys: scene.camera.keys.map((key) => key.t > at ? { ...key, t: r2(key.t + length) } : key) } } : {},
    ...typeof scene.playback?.posterTime === "number" && scene.playback.posterTime >= at ? { playback: { ...scene.playback, posterTime: r2(scene.playback.posterTime + length) } } : {},
    ...scene.steps ? { steps: scene.steps.map((st) => typeof st.at === "number" && st.at >= at ? { ...st, at: r2(st.at + length) } : st) } : {}
  };
  return { scene: next, layers: targets.length, cursors: count, seconds: length };
}
export {
  SWARM_DEFAULTS,
  buildWithCursors
};
