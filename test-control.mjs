import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = process.env.PI_TEST_ENTRY ? dirname(process.env.PI_TEST_ENTRY) : dirname(fileURLToPath(import.meta.url));
const { ResolvePlans } = await import(pathToFileURL(join(root, 'plans.mjs')));
const { validateGui, MENUS } = await import(pathToFileURL(join(root, 'gui.mjs')));
const { makeScript, validateRequest } = await import(pathToFileURL(join(root, 'templates.mjs')));
const state = { project_id: 'p', timeline_id: 't', project_name: 'Synthetic', timeline_name: 'Source', shape: { start: 216000, end: 216600, fps: '60', width: '1920', height: '1080', tracks: [], markers: {} } };
function backend() {
  return { copies: 0, state: structuredClone(state), async run(mode, args) {
    if (mode === 'state') return structuredClone(this.state);
    assert.equal(mode, 'copy'); this.copies++;
    if (this.failure) throw new Error('simulated timeout after dispatch');
    if (this.wait) await this.wait();
    return { verified: true, saved: true, project_id: 'p', source_timeline_id: 't', working_timeline_id: 'working', name: args.name, markers_added: args.markers.length };
  } };
}
const context = approved => ({ hasUI: true, ui: { confirm: async () => approved } });
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-resolve-plan-test-')); await chmod(dir, 0o700);
  const native = backend(); const plans = new ResolvePlans(native, dir);
  try { await fn(plans, native, dir); } finally { plans.shutdown(); await rm(dir, { recursive: true, force: true }); }
}
const draft = plans => plans.plan({ project_id: 'p', timeline_id: 't', markers: [{ frame: 2, name: '😀 marker', note: 'Review' }] });

await test('public skill matches the shipped tools and preserves operator consent', async () => {
  const skill = await readFile(join(root, 'skills/resolve-edit/SKILL.md'), 'utf8');
  const description = skill.match(/^description: (.+)$/m)?.[1];
  assert.ok(description);
  for (const tool of ['resolve_inspect', 'resolve_preview', 'resolve_control', 'resolve_plan']) assert.ok(skill.includes(tool));
  assert.match(skill, /Only the human operator/);
  assert.match(skill, /Never simulate approval/);
  assert.match(skill, /Never bypass the compatibility gate/);
  assert.match(skill, /does not install a general Resolve scripting MCP/);
  assert.doesNotMatch(skill, /The owner explicitly selected autonomous operation/);
  if (process.env.PI_TEST_SDK_ROOT) {
    const sdk = await import(pathToFileURL(join(process.env.PI_TEST_SDK_ROOT, 'dist/index.js')));
    const loaded = sdk.loadSkillsFromDir({ dir: join(root, 'skills'), source: 'resolve-regression' });
    assert.deepEqual(loaded.diagnostics, []);
    assert.equal(loaded.skills.length, 1);
    assert.equal(loaded.skills[0].name, 'ayla-resolve');
    assert.equal(loaded.skills[0].description, description);
  }
});

await test('GUI and page boundaries reject arbitrary input/keys/paths/commands', async () => {
  const swift = await readFile(join(root, 'resolve-gui.swift'), 'utf8');
  assert.deepEqual(JSON.parse(swift.match(/let allowed = (\[[^\n]+\])/)[1]), MENUS);
  assert.deepEqual(validateGui({}), { action: 'status' });
  for (const args of [{ action: 'click', x: 1 }, { action: 'menu', menu: 'Delete' }, { action: 'screenshot', output: '/tmp/override' }, { action: 'status', script: 'x' }, { action: 'screenshot', window_id: -1 }]) assert.throws(() => validateGui(args));
  assert.throws(() => validateRequest('page', { project_id: 'p', timeline_id: 't', page: 'Delete' }));
});
await test('copy plan has immutable bytes; no model approval or file paths accepted', () => fixture(async (p, n) => {
  const a = await draft(p); a.copy_name = 'mutated'; a.markers[0].name = 'mutated';
  const saved = JSON.parse(p.plans.get(a.digest)); assert.ok(saved.name.startsWith('Pi working ')); assert.equal(saved.markers[0].name, '😀 marker'); assert.equal(n.copies, 0);
  for (const extra of [{ confirm: true }, { expected: {} }, { name: 'overwrite' }]) await assert.rejects(p.plan({ project_id: 'p', timeline_id: 't', ...extra }));
  await assert.rejects(p.plan({ project_id: 'p', timeline_id: 't', markers: [{ frame: 216000, name: 'absolute!', note: '' }] }));
  await assert.rejects(p.plan({ project_id: 'p', timeline_id: 't', markers: [{ frame: 1, name: '\u001b[31m', note: '' }] }));
}));
await test('headless, denial, stale/expired plan and post-shutdown confirmation send no mutations', () => fixture(async (p, n) => {
  let a = await draft(p);
  await assert.rejects(p.apply(a.digest, { hasUI: false }), /headless/);
  assert.equal((await p.apply(a.digest, context(false))).cancelled, true);
  n.state.shape.end++; await assert.rejects(p.apply(a.digest, context(true)), /stale/); n.state = structuredClone(state);
  const old = JSON.parse(p.plans.get(a.digest)); old.created = 0; p.plans.set(a.digest, JSON.stringify(old)); await assert.rejects(p.apply(a.digest, context(true)), /expired/);
  a = await draft(p);
  await assert.rejects(p.apply(a.digest, { hasUI: true, ui: { confirm: async () => { p.shutdown(); p.start(); return true; } } }), /invalidated/);
  assert.equal(n.copies, 0);
}));
await test('operator-approved copy: one attempt, durable receipt, single-use digest', () => fixture(async (p, n, dir) => {
  const a = await draft(p); const result = await p.apply(a.digest, context(true));
  assert.equal(result.verified, true); assert.equal(n.copies, 1); assert.equal(await p.pending(), null);
  const files = await import('node:fs/promises').then(fs => fs.readdir(dir));
  assert.equal(files.length, 1); const receipt = JSON.parse(await readFile(join(dir, files[0]), 'utf8')); assert.equal(receipt.state, 'verified');
  await assert.rejects(p.apply(a.digest, context(true)), /Unknown plan/);
}));
await test('unknown outcome survives restart and blocks another real process; no retry', () => fixture(async (p, n, dir) => {
  n.failure = true; const a = await draft(p);
  await assert.rejects(p.apply(a.digest, context(true)), /unknown\/partial/);
  assert.equal(n.copies, 1); assert.equal((await p.pending()).state, 'dispatched_or_unknown');
  const script = `import {ResolvePlans} from ${JSON.stringify(pathToFileURL(join(root, 'plans.mjs')).href)}; const p = new ResolvePlans({}, ${JSON.stringify(dir)}); const s=await p.pending(); console.log(s.state);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }); assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout.trim(), 'dispatched_or_unknown');
  const other = new ResolvePlans(n, dir); const b = await draft(other); await assert.rejects(other.apply(b.digest, context(true)), /Pending\/unknown/); assert.equal(n.copies, 1);
}));
await test('two owners cannot dispatch concurrently; no automatic lock stealing', () => fixture(async (p, n, dir) => {
  let entered; const started = new Promise(r => { entered = r; }); let finish; const blocked = new Promise(r => { finish = r; }); n.wait = async () => { entered(); await blocked; };
  const other = new ResolvePlans(n, dir); const a = await draft(p); const b = await draft(other);
  const first = p.apply(a.digest, context(true)); await started;
  await assert.rejects(other.apply(b.digest, context(true)), /Pending\/unknown/); finish(); await first; assert.equal(n.copies, 1);
}));
await test('pending symlinks and permissive state directories fail closed', () => fixture(async (p, _n, dir) => {
  await writeFile(join(dir, 'target'), '{}'); await symlink(join(dir, 'target'), join(dir, 'pending.json')); await assert.rejects(p.pending());
  await chmod(dir, 0o755); await assert.rejects(p.stateDirectory(), /private/);
}));

await test('fixed copy template executed in actual Python: source unchanged, copy marker/save/readback, stale refusal', () => {
  const args = { project_id: 'p', timeline_id: 't', expected: state.shape, operation_id: 'operation', name: 'Pi working synthetic', markers: [{ frame: 2, name: '😀 marker', note: 'Review' }] };
  const prelude = `
class Timeline:
 def __init__(self, uid, name): self.uid=uid; self.name=name; self.markers={}
 def GetUniqueId(self): return self.uid
 def GetName(self): return self.name
 def GetTrackCount(self, kind): return 0
 def GetStartFrame(self): return 216000
 def GetEndFrame(self): return 216600
 def GetSetting(self,k): return {"timelineFrameRate":"60","timelineResolutionWidth":"1920","timelineResolutionHeight":"1080"}[k]
 def GetMarkers(self): return self.markers
 def DuplicateTimeline(self,name):
  w=Timeline("copy",name); p.timelines.append(w); return w
 def AddMarker(self,f,c,n,note,d,custom): self.markers[f]={"name":n,"note":note,"color":c,"duration":d,"customData":custom}; return True
class Project:
 def __init__(self): self.timelines=[Timeline("t","Source")]; self.current=self.timelines[0]
 def GetUniqueId(self): return "p"
 def GetCurrentTimeline(self): return self.current
 def GetTimelineCount(self): return len(self.timelines)
 def GetTimelineByIndex(self,i): return self.timelines[i-1]
 def SetCurrentTimeline(self,t): self.current=t; return True
class Manager:
 def GetCurrentProject(self): return p
 def SaveProject(self): return True
class Resolve:
 def GetProjectManager(self): return Manager()
p=Project(); resolve=Resolve()
`;
  const script = prelude + makeScript('copy', args) + '\nassert result["verified"]\nassert p.timelines[0].GetMarkers() == {}\nassert p.current.GetMarkers()[2]["name"] == "😀 marker"\nprint("PASS")';
  const r = spawnSync('python3', ['-c', script], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), 'PASS');
  const bad = structuredClone(args); bad.expected.end++;
  const stale = spawnSync('python3', ['-c', prelude + makeScript('copy', bad)], { encoding: 'utf8' }); assert.notEqual(stale.status, 0); assert.match(stale.stderr, /Plan stale/);
});
