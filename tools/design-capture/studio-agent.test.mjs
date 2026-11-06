// The agent's snapshots: a run can always be put back, and only the project's own snapshots can be restored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'upw-agent-test-'));
process.env.KINETIC_WORKSPACE = root;
const { workspaceRoot } = await import('./studio-workspace.mjs');
const { restoreSnapshot, snapshotScene } = await import('./studio-agent.mjs');
const usable = workspaceRoot() === root;
const dir = join(root, 'Reel');
const scene = (t) => writeFileSync(join(dir, 'scene.json'), JSON.stringify({ title: t }));

test('a snapshot puts the scene back after a run', { skip: !usable }, () => {
  mkdirSync(dir, { recursive: true });
  scene('before');
  const name = snapshotScene('Reel');
  scene('after');
  restoreSnapshot('Reel', name);
  assert.equal(JSON.parse(readFileSync(join(dir, 'scene.json'), 'utf8')).title, 'before');
});

test('only the last ten snapshots stay', { skip: !usable }, async () => {
  for (let i = 0; i < 13; i++) { snapshotScene('Reel'); await new Promise((r) => setTimeout(r, 3)); }
  assert.equal(readdirSync(join(dir, 'snapshots')).length, 10);
});

test('a name that is not a snapshot is refused', { skip: !usable }, () => {
  for (const bad of ['../scene.json', 'notes.md', 'scene-1.json.exe', '']) assert.throws(() => restoreSnapshot('Reel', bad), /Not a snapshot/);
  assert.throws(() => restoreSnapshot('Reel', 'scene-2020-01-01.json'), /no longer kept/);
  assert.throws(() => snapshotScene('../outside'), /Not a project name|No project/);
});

test.after(() => { if (existsSync(root)) rmSync(root, { recursive: true, force: true }); });
