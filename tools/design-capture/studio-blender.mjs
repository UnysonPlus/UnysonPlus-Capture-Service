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
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
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
    // Newest first, but a 4.x before a 5.x: Blender 5's Eevee renders about three times slower in the background
    // (measured 2026-11-25 on a GTX 1660 Ti: 3.5 s a frame against 1.3 s on 4.2). BLENDER picks one by hand.
    const major = (d) => Number((/(\d+)\.\d+/.exec(d) || [])[1]) || 0;
    const dirs = readdirSync(root).filter((d) => /blender/i.test(d))
      .sort((a, b) => (major(a) === 4 ? 0 : 1) - (major(b) === 4 ? 0 : 1) || b.localeCompare(a, undefined, { numeric: true }));
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
    // UPW_BLENDER_LOG=<file>: also write Blender's own output there as it runs (for finding out why a run stalls).
    const logTo = process.env.UPW_BLENDER_LOG;
    const keep = (d) => { out = (out + d).slice(-400000); if (logTo) { try { appendFileSync(logTo, d); } catch { /* the log is optional */ } } };
    p.stdout.on('data', keep);
    p.stderr.on('data', keep);
    const timer = setTimeout(() => { p.kill(); bad(new Error(`${basename(cmd)} took longer than ${timeout / 1000} s`)); }, timeout);
    p.on('error', (e) => { clearTimeout(timer); bad(e.code === 'ENOENT' ? new Error('Blender was not found. Install Blender 4.2 or later (blender.org), or set BLENDER to its path.') : e); });
    p.on('exit', (c) => { clearTimeout(timer); ok({ code: c, out }); });
  });
}

/** The Python that wraps the agent's script: a clean scene, the script, then the kit's own steps. */
function wrapper({ script, after, clear = true }) {
  return `
import bpy, math, json, sys, traceback, mathutils
${clear ? 'for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)' : '# An opened .blend file: its objects stay.'}
REPORT = {}
# Eevee's name: BLENDER_EEVEE_NEXT in Blender 4.2 to 4.x, BLENDER_EEVEE again from 5.0.
EEVEE = 'BLENDER_EEVEE_NEXT' if 'BLENDER_EEVEE_NEXT' in {e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items} else 'BLENDER_EEVEE'
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
# Model checks: what reads wrong on the web even when the four views look fine.
import bmesh
qa = []
PROC = {'ShaderNodeTexNoise', 'ShaderNodeTexVoronoi', 'ShaderNodeTexWave', 'ShaderNodeTexMagic', 'ShaderNodeTexGradient',
        'ShaderNodeTexBrick', 'ShaderNodeTexChecker', 'ShaderNodeTexMusgrave', 'ShaderNodeValToRGB', 'ShaderNodeBevel', 'ShaderNodeAmbientOcclusion'}
proc_mats, bare, bevelled, smooth_faces, all_faces = set(), [], False, 0, 0
for o in meshes:
    if o.type != 'MESH':
        continue
    if any(md.type in ('BEVEL', 'SUBSURF') for md in o.modifiers):
        bevelled = True
    if not any(s.material for s in o.material_slots):
        bare.append(o.name)
    for s in o.material_slots:
        if s.material and s.material.use_nodes and any(n.bl_idname in PROC for n in s.material.node_tree.nodes):
            proc_mats.add(s.material.name)
    me = o.evaluated_get(dg).to_mesh()
    bm = bmesh.new(); bm.from_mesh(me)
    # Imported files (glTF above all) split vertices along seams: weld them on this copy so seams don't count as holes.
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    all_faces += len(bm.faces); smooth_faces += sum(1 for f in bm.faces if f.smooth)
    open_e = sum(1 for e in bm.edges if e.is_boundary)
    loose = sum(1 for v in bm.verts if not v.link_edges)
    tiny = sum(1 for f in bm.faces if f.calc_area() < 1e-12)
    n_edges = len(bm.edges)
    closed = n_edges > 0 and open_e == 0 and all(e.is_manifold for e in bm.edges)
    vol = bm.calc_volume(signed=True) if closed else 0
    bm.free(); o.evaluated_get(dg).to_mesh_clear()
    # A flat part (a plane, a label) is open on purpose; a part with depth and open edges has a hole, and on the web
    # faces are one-sided, so its inside is invisible through it.
    if open_e and min(o.dimensions) > 1e-6:
        qa.append(f'"{o.name}" has {open_e} open edges (a hole): on the web its inside is invisible through the hole. Close it, or give a thin sheet a Solidify modifier.')
    if closed and vol < 0:
        qa.append(f'"{o.name}" is inside out (its normals point inwards): it renders dark or see-through. Recalculate the normals outside (bmesh.ops.recalc_face_normals).')
    if loose:
        qa.append(f'"{o.name}" has {loose} loose vertices: remove them (merge by distance, delete loose).')
    if tiny:
        qa.append(f'"{o.name}" has {tiny} faces with no area: merge by distance 0.0001.')
if bare:
    qa.append('No material on ' + ', '.join(f'"{n}"' for n in bare[:6]) + ': it shows plain white. Give every part a Principled BSDF material.')
if proc_mats:
    qa.append('Procedural texture nodes in ' + ', '.join(f'"{n}"' for n in sorted(proc_mats)[:6]) + " won't reach the GLB (the web gets the plain Principled values). Use flat colours per part, vertex colours, or an image texture instead.")
if not bevelled and tris < 60000 and not REPORT.get('imported'):
    qa.append('Note: no Bevel modifier on any part. Hard edges with no bevel catch no light and read as computer-made: a Bevel (about 1% of the size, 2-3 segments, limit by angle) on the hard parts helps.')
if all_faces and smooth_faces == 0:
    qa.append('Note: every face is flat-shaded. Curved parts look faceted: shade them smooth (shade_smooth, or smooth by angle at 30-40 degrees for hard surfaces) unless a low-poly look is wanted.')
print('UPW_QA ' + json.dumps(qa))
# Four views for the agent to look at.
add_light_rig(1)
sc = bpy.context.scene
sc.render.engine = EEVEE
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
sc.render.engine = EEVEE
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

async function runBlender(py, timeout, blend = null) {
  const file = join(tmpdir(), `upw-blender-${Date.now()}-${Math.random().toString(36).slice(2)}.py`);
  writeFileSync(file, py);
  try {
    const r = await run(findBlender(), ['-b', '--factory-startup', ...(blend ? [blend] : []), '--python-exit-code', '4', '--python', file], { timeout });
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
export async function blenderModel({ script, out, project = null, name = 'Blender model', timeout = 300000, blend = null }) {
  if (!script || typeof script !== 'string') throw new Error('Give the Blender Python (bpy) that builds the object.');
  const glb = resolve(out || join(tmpdir(), `blender-model-${Date.now()}.glb`));
  mkdirSync(join(glb, '..'), { recursive: true });
  const prev = join(tmpdir(), `upw-bl-prev-${Date.now()}`);
  mkdirSync(prev, { recursive: true });
  const log = await runBlender(wrapper({ script, after: MODEL_AFTER(glb.replace(/\\/g, '/'), prev), clear: !blend }), timeout, blend);
  const stats = JSON.parse((log.match(/UPW_STATS (.+)/) || [, '{}'])[1]);
  stats.bytes = statSync(glb).size;
  const views = readdirSync(prev).filter((f) => f.endsWith('.png')).sort().map((f) => join(prev, f));
  const preview = await sheet(views, glb.replace(/\.glb$/i, '') + '.preview.png', 512, 512);
  rmSync(prev, { recursive: true, force: true });
  const warnings = [];
  if (stats.tris > 150000) warnings.push(`${stats.tris.toLocaleString()} triangles is heavy for a web page: aim for under 100,000 (a Decimate modifier in the script).`);
  if (stats.bytes > 6e6) warnings.push(`The file is ${(stats.bytes / 1e6).toFixed(1)} MB: large for a web page. Smaller textures (1024 px) or fewer triangles help.`);
  // The model checks (holes, inside-out parts, missing materials, procedural textures the GLB drops, no bevels…).
  try { warnings.push(...JSON.parse((log.match(/UPW_QA (.+)/) || [, '[]'])[1])); } catch { /* an older Blender printed nothing usable */ }
  const src = await intoProject(glb, project);
  const layer = { id: `blender-${Date.now().toString(36)}`, name, type: 'model', model: { kind: 'gltf', src }, box: { x: 50, y: 50, w: 40, h: 60 }, pose: { rx: -8, ry: 25, rz: 0, scale: 1 }, light: 1.1, alt: name, clips: [] };
  return { glb, src, layer, stats, warnings, preview };
}

/**
 * A path-traced still of a 3D layer: the GLB rendered in Cycles at exactly the pose and camera the player draws it with
 * (same normalising, resting pose, 3D state, 22° lens and fitting distance), on a transparent film the size of the
 * layer's 3D canvas (its box plus 35% bleed on each side), so the picture lines up with the live layer.
 * state: the player's State3D at the moment; pose: the layer's resting pose; canvas: { w, h } in pixels; light: the
 * layer's light (1 = normal); samples: Cycles samples (denoised).
 */
export async function blenderStill({ glb, state = {}, pose = {}, canvas, light = 1, samples = 48, out, timeout = 300000 }) {
  if (!glb || !existsSync(glb)) throw new Error(`No model at ${glb}.`);
  if (!canvas || !(canvas.w > 0) || !(canvas.h > 0)) throw new Error('Give the canvas size in pixels ({ w, h }).');
  const png = resolve(out || join(tmpdir(), `blender-still-${Date.now()}.png`));
  mkdirSync(join(png, '..'), { recursive: true });
  const P = { glb: resolve(glb).replace(/\\/g, '/'), png: png.replace(/\\/g, '/'), state, pose, w: Math.round(canvas.w), h: Math.round(canvas.h), light, samples: Math.max(8, Math.min(1024, samples | 0)) };
  const script = `
P = json.loads(${JSON.stringify(JSON.stringify(P))})
from mathutils import Matrix, Vector, Euler
bpy.ops.import_scene.gltf(filepath=P['glb'])
for o in list(bpy.data.objects):
    if o.type in ('CAMERA', 'LIGHT'): bpy.data.objects.remove(o, do_unlink=True)
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
if not meshes: raise RuntimeError('The model has no meshes.')
D = math.pi / 180
# three.js is y-up, Blender z-up: the glTF importer maps (x, y, z) to (x, -z, y). C does the same for transforms.
C = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1))); Ci = C.inverted()
def box(M):
    # three's Box3.setFromObject: each mesh's own bounding box, its 8 corners moved by the full transform.
    lo = [1e9] * 3; hi = [-1e9] * 3
    for o in meshes:
        for c in o.bound_box:
            w = M @ o.matrix_world @ Vector(c)
            for i in range(3): lo[i] = min(lo[i], w[i]); hi[i] = max(hi[i], w[i])
    return Vector(lo), Vector(hi)
def yxz(rx, ry, rz):
    # three's Euler order 'YXZ': R = Ry Rx Rz.
    return (Matrix.Rotation(ry * D, 4, 'Y') @ Matrix.Rotation(rx * D, 4, 'X') @ Matrix.Rotation(rz * D, 4, 'Z'))
lo, hi = box(Matrix.Identity(4))
size = max(hi[i] - lo[i] for i in range(3)) or 1
centre = (lo + hi) / 2
W = Matrix.Scale(1 / size, 4) @ Matrix.Translation(-centre)               # normalised: largest side 1, centred (Blender axes)
pose = P['pose']; st = P['state']
POSED = yxz(pose.get('rx', 0), pose.get('ry', 0), pose.get('rz', 0)) @ Matrix.Scale(pose.get('scale', 1), 4)
PIVOT = Matrix.Translation((st.get('px', 0), st.get('py', 0), 0)) @ yxz(st.get('rx', 0), st.get('ry', 0), st.get('rz', 0)) @ Matrix.Scale(max(0.0001, st.get('s', 1)), 4)
# Half extents in the resting pose (three's axes), for the camera's fitting distance.
plo, phi = box(C @ POSED @ Ci @ W)
hb = (phi - plo) / 2
half = (hb.x, hb.z, hb.y)
M = C @ PIVOT @ POSED @ Ci @ W
root = bpy.data.objects.new('Still', None); bpy.context.collection.objects.link(root)
for o in list(bpy.data.objects):
    if o.parent is None and o is not root:
        o.parent = root; o.matrix_parent_inverse = Matrix.Identity(4)
root.matrix_world = M
# The player's camera: a 22° vertical lens, at the distance that fits the resting object in 80% of the box.
FOV = 22; BLEED = 0.35; aspect = P['w'] / P['h']
v = FOV / 2 * D; hv = math.atan(math.tan(v) * aspect); k = 1 + 2 * BLEED
fit = max(half[1] * k / math.tan(v), half[0] * k / math.tan(hv)) * 1.25 + half[2]
d = fit * max(0.05, st.get('dolly', 1)); o_ = st.get('orbit', 0) * D; t_ = st.get('tilt', 0) * D
cam_t = Vector((math.sin(o_) * math.cos(t_) * d, math.sin(t_) * d, math.cos(o_) * math.cos(t_) * d))
cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); bpy.context.collection.objects.link(cam)
cam.location = (C @ cam_t.to_4d()).to_3d()
cam.rotation_euler = (-cam.location).to_track_quat('-Z', 'Y').to_euler()
cam.data.sensor_fit = 'VERTICAL'; cam.data.angle_y = FOV * D; cam.data.clip_start = 0.01; cam.data.clip_end = 100
sc = bpy.context.scene; sc.camera = cam
`;
  const after = `
# Light like the player's studio (a soft room, a key light up and to the right), only path-traced.
L = P['light']
world = bpy.data.worlds.new('Room'); sc.world = world; world.use_nodes = True
bg = world.node_tree.nodes['Background']; bg.inputs['Color'].default_value = (0.8, 0.8, 0.82, 1); bg.inputs['Strength'].default_value = 0.4 * L
def area(name, loc, energy, size):
    ld = bpy.data.lights.new(name, 'AREA'); ld.energy = energy * L; ld.size = size
    ob = bpy.data.objects.new(name, ld); bpy.context.collection.objects.link(ob)
    ob.location = (C @ Vector(loc).to_4d()).to_3d(); ob.rotation_euler = (-ob.location).to_track_quat('-Z', 'Y').to_euler()
area('Key', (2, 3, 4), 190, 3)
area('Fill', (-4, 1, 3), 55, 4)
area('Rim', (0, 2, -4), 70, 3)
sc.render.engine = 'CYCLES'
sc.cycles.samples = P['samples']; sc.cycles.use_denoising = True
# A time limit, so a still always arrives: when the graphics card is busy (a browser drawing live 3D on a small card)
# Blender falls back to the processor, where the samples would take minutes; it stops at the limit and denoises.
sc.cycles.time_limit = P.get('limit', 45); sc.cycles.use_adaptive_sampling = True
try:
    prefs = bpy.context.preferences.addons['cycles'].preferences
    for kind in ('OPTIX', 'CUDA', 'HIP', 'METAL', 'ONEAPI'):
        try:
            prefs.compute_device_type = kind; prefs.get_devices()
        except Exception:
            continue
        if any(dv.type == kind for dv in prefs.devices):
            for dv in prefs.devices: dv.use = dv.type == kind
            sc.cycles.device = 'GPU'
            print('UPW_DEVICE ' + kind)
            break
except Exception:
    pass
sc.render.film_transparent = True
sc.view_settings.view_transform = 'Standard'
sc.render.resolution_x = P['w']; sc.render.resolution_y = P['h']; sc.render.resolution_percentage = 100
sc.render.image_settings.file_format = 'PNG'; sc.render.image_settings.color_mode = 'RGBA'
sc.render.filepath = P['png']
bpy.ops.render.render(write_still=True)
print('UPW_DONE')
`;
  const t0 = Date.now();
  const log = await runBlender(wrapper({ script, after }), timeout);
  const device = (log.match(/UPW_DEVICE (\w+)/) || [, 'CPU'])[1];
  return { png, seconds: Math.round((Date.now() - t0) / 100) / 10, device, width: P.w, height: P.h };
}

const IMPORTERS = {
  '.glb': 'bpy.ops.import_scene.gltf(filepath=F)', '.gltf': 'bpy.ops.import_scene.gltf(filepath=F)',
  '.fbx': 'bpy.ops.import_scene.fbx(filepath=F)', '.obj': 'bpy.ops.wm.obj_import(filepath=F)',
  '.stl': 'bpy.ops.wm.stl_import(filepath=F)', '.ply': 'bpy.ops.wm.ply_import(filepath=F)',
  '.usd': 'bpy.ops.wm.usd_import(filepath=F)', '.usdz': 'bpy.ops.wm.usd_import(filepath=F)', '.usdc': 'bpy.ops.wm.usd_import(filepath=F)',
};

/**
 * Brings a model made elsewhere into a scene through the same pipeline as blenderModel: a .blend saved from a live
 * Blender session (Blender's own MCP connector, or by hand), or a GLB, FBX, OBJ, STL, PLY or USD file. It is centred
 * and sized, checked, exported as a web GLB with four views, and returned as a 3D layer. objects: keep only these
 * object names (their children come along). Objects hidden from render, cameras and lights are left out.
 */
export async function blenderImport({ file, objects = null, out, project = null, name, timeout = 300000 }) {
  if (!file || !existsSync(file)) throw new Error(`No file at ${file}.`);
  const ext = extname(file).toLowerCase();
  const isBlend = ext === '.blend';
  if (!isBlend && !IMPORTERS[ext]) throw new Error(`Can't import ${ext} files: use .blend, .glb, .gltf, .fbx, .obj, .stl, .ply or .usd (usdz, usdc).`);
  const keep = Array.isArray(objects) && objects.length ? objects : null;
  const script = `
F = ${JSON.stringify(resolve(file).replace(/\\/g, '/'))}
${isBlend ? '' : IMPORTERS[ext]}
KEEP = ${keep ? JSON.stringify(keep) : 'None'}
REPORT['imported'] = True
def wanted(o):
    if KEEP is None: return True
    while o is not None:
        if o.name in KEEP: return True
        o = o.parent
    return False
# Only what the scene would render: not other scenes, not objects hidden from render, not cameras or lights.
scene_objs = set(bpy.context.scene.objects)
for o in list(bpy.data.objects):
    if o not in scene_objs or o.hide_render or o.type in ('CAMERA', 'LIGHT', 'LIGHT_PROBE', 'SPEAKER') or not wanted(o):
        bpy.data.objects.remove(o, do_unlink=True)
if KEEP and not any(o.type == 'MESH' for o in bpy.data.objects):
    raise RuntimeError('None of these objects is in the file: ' + ', '.join(KEEP))
`;
  return blenderModel({ script, out, project, name: name || basename(file).replace(/\.[^.]+$/, ''), timeout, blend: isBlend ? resolve(file) : null });
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
