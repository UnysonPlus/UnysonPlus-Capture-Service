// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Blender for Kinetic Scenes: an AI agent writes Blender Python (bpy), and the kit runs it in Blender in the background
// (no window, no add-on, nothing to start) and brings the result into a scene:
//   - blenderModel: whatever the script builds becomes a glTF model (GLB) for a 3D layer. The objects are centred and
//     sized to a 2-unit cube, modifiers applied, textures packed, and four views are rendered so the agent can look.
//   - blenderRender: an animated shot (simulations, particles, smoke, a camera flight… anything glTF can't carry) is
//     rendered with a transparent background to a WebM for a footage layer, with a few frames to look at.
// Simple objects built from boxes, spheres and rings are quicker with studio-object3d.mjs; this is for everything else.
// For hands-on work in a live Blender window, the official Blender connector (Claude Desktop / Claude Code) is the tool.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const FFMPEG = () => process.env.FFMPEG || 'ffmpeg';
const r2 = (x) => Math.round(x * 100) / 100;

/** Where Blender is: BLENDER, then the usual install places (newest first), then `blender` on the PATH. */
export function findBlender() {
  if (process.env.BLENDER && existsSync(process.env.BLENDER)) return process.env.BLENDER;
  const roots = process.platform === 'win32'
    ? [join(process.env.ProgramFiles || 'C:/Program Files', 'Blender Foundation')]
    : process.platform === 'darwin' ? ['/Applications'] : ['/opt', '/usr/local'];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const dirs = readdirSync(root).filter((d) => /blender/i.test(d)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const d of dirs) {
      const exe = process.platform === 'win32' ? join(root, d, 'blender.exe') : process.platform === 'darwin' ? join(root, d, 'Contents/MacOS/Blender') : join(root, d, 'blender');
      if (existsSync(exe)) return exe;
    }
  }
  return 'blender';
}

function run(cmd, args, { timeout = 600000 } = {}) {
  return new Promise((ok, bad) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const keep = (d) => { out = (out + d).slice(-400000); };
    p.stdout.on('data', keep);
    p.stderr.on('data', keep);
    const timer = setTimeout(() => { p.kill(); bad(new Error(`${basename(cmd)} took longer than ${timeout / 1000} s`)); }, timeout);
    p.on('error', (e) => { clearTimeout(timer); bad(e.code === 'ENOENT' ? new Error('Blender was not found. Install Blender 4.2 or later (blender.org), or set BLENDER to its path.') : e); });
    p.on('exit', (c) => { clearTimeout(timer); ok({ code: c, out }); });
  });
}

/** The Python that wraps the agent's script: a clean scene, the script, then the kit's own steps. */
function wrapper({ script, after }) {
  return `
import bpy, math, json, sys, traceback, mathutils
for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
REPORT = {}
def hex_color(h, alpha=1.0):
    """A web colour ('#00B295') as Blender's linear RGBA, so brand colours come out as given."""
    h = h.lstrip('#'); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple((x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4) for x in c) + (alpha,)
try:
    exec(compile(${JSON.stringify(script)}, 'agent-script.py', 'exec'), globals())
except Exception:
    print('UPW_SCRIPT_ERROR ' + json.dumps(traceback.format_exc()[-3000:]))
    sys.exit(3)

def bounds(objs):
    lo = [1e9] * 3; hi = [-1e9] * 3
    dg = bpy.context.evaluated_depsgraph_get()
    for o in objs:
        if o.type not in ('MESH', 'CURVE', 'SURFACE', 'META', 'FONT'): continue
        ev = o.evaluated_get(dg)
        for c in ev.bound_box:
            w = ev.matrix_world @ mathutils.Vector(c)
            for i in range(3): lo[i] = min(lo[i], w[i]); hi[i] = max(hi[i], w[i])
    return lo, hi

def add_light_rig(target_size):
    if any(o.type == 'LIGHT' for o in bpy.data.objects): return
    for name, loc, energy in (('Key', (3, -3, 4), 500), ('Fill', (-4, -2, 2), 150), ('Rim', (0, 4, 3), 350)):
        d = bpy.data.lights.new(name, 'AREA'); d.energy = energy * target_size; d.size = 3
        o = bpy.data.objects.new(name, d); o.location = loc; bpy.context.collection.objects.link(o)
        o.rotation_euler = (mathutils.Vector((0, 0, 0)) - mathutils.Vector(loc)).to_track_quat('-Z', 'Y').to_euler()

${after}
`;
}

const MODEL_AFTER = (glb, previewDir) => `
objs = [o for o in bpy.data.objects if o.type in ('MESH', 'CURVE', 'SURFACE', 'META', 'FONT', 'EMPTY')]
meshes = [o for o in objs if o.type != 'EMPTY']
if not meshes:
    print('UPW_SCRIPT_ERROR ' + json.dumps('The script made no mesh objects.')); sys.exit(3)
lo, hi = bounds(meshes)
size = max(hi[i] - lo[i] for i in range(3)) or 1
center = [(lo[i] + hi[i]) / 2 for i in range(3)]
root = bpy.data.objects.new('Model', None); bpy.context.collection.objects.link(root)
for o in objs:
    if o.parent is None and o is not root: o.parent = root
root.location = (-center[0] * 2 / size, -center[1] * 2 / size, -center[2] * 2 / size)
root.scale = (2 / size,) * 3
bpy.context.view_layer.update()
tris = 0
dg = bpy.context.evaluated_depsgraph_get()
for o in meshes:
    if o.type == 'MESH':
        m = o.evaluated_get(dg).to_mesh(); m.calc_loop_triangles(); tris += len(m.loop_triangles); o.evaluated_get(dg).to_mesh_clear()
bpy.ops.export_scene.gltf(filepath=${JSON.stringify(glb)}, export_format='GLB', use_selection=False, export_apply=True, export_yup=True, export_cameras=False, export_lights=False, export_animations=True)
print('UPW_STATS ' + json.dumps({'tris': tris, 'objects': len(meshes), 'materials': len({s.material.name for o in meshes for s in o.material_slots if s.material})}))
# Four views for the agent to look at.
add_light_rig(1)
sc = bpy.context.scene
sc.render.engine = 'BLENDER_EEVEE_NEXT'
sc.render.resolution_x = sc.render.resolution_y = 512
sc.render.film_transparent = True
sc.view_settings.view_transform = 'Standard'
sc.render.image_settings.file_format = 'PNG'
sc.render.image_settings.color_mode = 'RGBA'
w = bpy.data.worlds.new('W'); sc.world = w; w.use_nodes = True; w.node_tree.nodes['Background'].inputs[1].default_value = 0.6
cam_d = bpy.data.cameras.new('Cam'); cam_d.lens = 50; cam = bpy.data.objects.new('Cam', cam_d); bpy.context.collection.objects.link(cam); sc.camera = cam
for i, (name, az, el) in enumerate((('front', 0, 12), ('three-quarter', 40, 22), ('side', 90, 10), ('above', 200, 48))):
    r = 4.3; a = math.radians(az); e = math.radians(el)
    cam.location = (r * math.sin(a) * math.cos(e), -r * math.cos(a) * math.cos(e), r * math.sin(e))
    cam.rotation_euler = (mathutils.Vector((0, 0, 0)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    sc.render.filepath = ${JSON.stringify(previewDir.replace(/\\/g, '/'))} + '/view-' + str(i) + '-' + name + '.png'
    bpy.ops.render.render(write_still=True)
print('UPW_DONE')
`;

const RENDER_AFTER = ({ frames, fps, width, height, dir }) => `
sc = bpy.context.scene
sc.render.fps = ${fps}
if sc.frame_end <= sc.frame_start or REPORT.get('keep_frames') is None:
    sc.frame_start = 1; sc.frame_end = ${frames}
sc.render.engine = 'BLENDER_EEVEE_NEXT'
sc.render.resolution_x = ${width}; sc.render.resolution_y = ${height}; sc.render.resolution_percentage = 100
sc.render.film_transparent = True
sc.render.image_settings.file_format = 'PNG'; sc.render.image_settings.color_mode = 'RGBA'
if sc.camera is None:
    meshes = [o for o in bpy.data.objects if o.type in ('MESH', 'CURVE', 'FONT', 'META')]
    lo, hi = bounds(meshes) if meshes else ([-1] * 3, [1] * 3)
    size = max(hi[i] - lo[i] for i in range(3)) or 2
    c = mathutils.Vector([(lo[i] + hi[i]) / 2 for i in range(3)])
    cd = bpy.data.cameras.new('Cam'); cam = bpy.data.objects.new('Cam', cd); bpy.context.collection.objects.link(cam); sc.camera = cam
    cam.location = c + mathutils.Vector((0, -size * 2.2, size * 0.6))
    cam.rotation_euler = (c - cam.location).to_track_quat('-Z', 'Y').to_euler()
if sc.world is None:
    w = bpy.data.worlds.new('W'); sc.world = w; w.use_nodes = True; w.node_tree.nodes['Background'].inputs[1].default_value = 0.3
add_light_rig(1)
sc.view_settings.view_transform = 'Standard'  # brand colours come out as given, not desaturated
sc.render.filepath = ${JSON.stringify(dir.replace(/\\/g, '/'))} + '/f'
bpy.ops.render.render(animation=True)
print('UPW_DONE')
`;

async function runBlender(py, timeout) {
  const file = join(tmpdir(), `upw-blender-${Date.now()}-${Math.random().toString(36).slice(2)}.py`);
  writeFileSync(file, py);
  try {
    const r = await run(findBlender(), ['-b', '--factory-startup', '--python-exit-code', '4', '--python', file], { timeout });
    const err = r.out.match(/UPW_SCRIPT_ERROR (.+)/);
    if (err) throw new Error(`The Blender script failed:\n${JSON.parse(err[1])}`);
    if (!/UPW_DONE/.test(r.out)) throw new Error(`Blender stopped early:\n${r.out.split('\n').filter((l) => /Error|error|Traceback/.test(l)).slice(-8).join('\n') || r.out.slice(-1200)}`);
    return r.out;
  } finally {
    rmSync(file, { force: true });
  }
}

/** Tiles PNG frames (same size) into one contact sheet, 2 columns, each 480 px wide on a neutral grey. */
async function sheet(files, out, w, h) {
  if (!files.length) return null;
  const tw = 480, th = Math.max(2, Math.round((tw * h) / w / 2) * 2);
  const parts = files.map((_, i) => `color=c=0x3a3f47:s=${tw}x${th}[c${i}];[${i}:v]scale=${tw}:${th}[s${i}];[c${i}][s${i}]overlay=format=auto,format=rgb24[t${i}]`);
  const pos = files.map((_, i) => `${(i % 2) * tw}_${Math.floor(i / 2) * th}`).join('|');
  const tail = files.length === 1 ? '[t0]null[o]' : `${files.map((_, i) => `[t${i}]`).join('')}xstack=inputs=${files.length}:layout=${pos}:fill=0x3a3f47[o]`;
  await run(FFMPEG(), ['-y', '-v', 'error', ...files.flatMap((f) => ['-i', f]), '-filter_complex', `${parts.join(';')};${tail}`, '-map', '[o]', '-frames:v', '1', out]);
  return out;
}

/** Saves a file into a workspace project's media/ when a project is given; returns the path a scene should use. */
async function intoProject(file, project) {
  if (!project) return resolve(file);
  const ws = await import('./studio-workspace.mjs');
  const id = ws.projectId(project);
  // A new project starts empty; the agent then adds the layer to its scene.json.
  try { ws.projectDir(id); } catch { ws.createProject(project, { format: 'unysonplus-scene', version: 1, title: project, duration: 6, stage: { breakpoints: [{ id: 'desktop', label: 'Desktop', minWidth: 0, aspect: [16, 9] }], background: '#0d1117' }, playback: { trigger: 'load', loop: false }, layers: [] }); }
  return ws.addMedia(id, basename(file), readFileSync(file));
}

/**
 * Builds a 3D model in Blender from an agent's bpy script. Returns the GLB path, a ready 3D layer, stats and a preview
 * sheet (four views). Options: out (the .glb), project (a workspace project to put it in), name, timeout (ms).
 */
export async function blenderModel({ script, out, project = null, name = 'Blender model', timeout = 300000 }) {
  if (!script || typeof script !== 'string') throw new Error('Give the Blender Python (bpy) that builds the object.');
  const glb = resolve(out || join(tmpdir(), `blender-model-${Date.now()}.glb`));
  mkdirSync(join(glb, '..'), { recursive: true });
  const prev = join(tmpdir(), `upw-bl-prev-${Date.now()}`);
  mkdirSync(prev, { recursive: true });
  const log = await runBlender(wrapper({ script, after: MODEL_AFTER(glb.replace(/\\/g, '/'), prev) }), timeout);
  const stats = JSON.parse((log.match(/UPW_STATS (.+)/) || [, '{}'])[1]);
  stats.bytes = statSync(glb).size;
  const views = readdirSync(prev).filter((f) => f.endsWith('.png')).sort().map((f) => join(prev, f));
  const preview = await sheet(views, glb.replace(/\.glb$/i, '') + '.preview.png', 512, 512);
  rmSync(prev, { recursive: true, force: true });
  const warnings = [];
  if (stats.tris > 150000) warnings.push(`${stats.tris.toLocaleString()} triangles is heavy for a web page: aim for under 100,000 (a Decimate modifier in the script).`);
  if (stats.bytes > 6e6) warnings.push(`The file is ${(stats.bytes / 1e6).toFixed(1)} MB: large for a web page. Smaller textures (1024 px) or fewer triangles help.`);
  const src = await intoProject(glb, project);
  const layer = { id: `blender-${Date.now().toString(36)}`, name, type: 'model', model: { kind: 'gltf', src }, box: { x: 50, y: 50, w: 40, h: 60 }, pose: { rx: -8, ry: 25, rz: 0, scale: 1 }, light: 1.1, alt: name, clips: [] };
  return { glb, src, layer, stats, warnings, preview };
}

/**
 * Renders an animated Blender shot to a transparent WebM for a footage layer. The script builds the shot (objects,
 * animation, and a camera if it wants one; otherwise the kit frames everything). Options: seconds, fps, width, height,
 * out (the .webm), project, name, timeout (ms).
 */
export async function blenderRender({ script, out, seconds = 4, fps = 30, width = 1080, height = 1080, project = null, name = 'Blender shot', timeout = 1200000 }) {
  if (!script || typeof script !== 'string') throw new Error('Give the Blender Python (bpy) that builds the animated shot.');
  const webm = resolve(out || join(tmpdir(), `blender-shot-${Date.now()}.webm`));
  mkdirSync(join(webm, '..'), { recursive: true });
  const dir = join(tmpdir(), `upw-bl-frames-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const frames = Math.max(1, Math.round(seconds * fps));
  try {
    await runBlender(wrapper({ script, after: RENDER_AFTER({ frames, fps, width: Math.round(width), height: Math.round(height), dir }) }), timeout);
    const pngs = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
    if (!pngs.length) throw new Error('Blender rendered no frames.');
    await run(FFMPEG(), ['-y', '-v', 'error', '-framerate', String(fps), '-i', join(dir, 'f%04d.png'), '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '30', '-row-mt', '1', webm]);
    const picks = [0, Math.floor(pngs.length / 3), Math.floor((2 * pngs.length) / 3), pngs.length - 1].filter((v, i, a) => a.indexOf(v) === i).map((i) => join(dir, pngs[i]));
    const preview = await sheet(picks, webm.replace(/\.webm$/i, '') + '.preview.png', width, height);
    const src = await intoProject(webm, project);
    const layer = { id: `blender-${Date.now().toString(36)}`, name, type: 'video', src, fit: 'contain', box: { x: 50, y: 50, w: 60, ratio: width / height }, alt: name, clips: [] };
    return { webm, src, layer, frames: pngs.length, seconds: r2(pngs.length / fps), preview };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
