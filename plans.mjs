import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, open, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { validateRequest, makeScript } from './templates.mjs';

const hash = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const uiLabel = text => String(text).replace(/[\x00-\x1f\x7f]/g, '?').slice(0, 160);
export class ResolvePlans {
  constructor(native, directory = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'pi-davinci-resolve')) {
    if (!isAbsolute(directory)) throw new Error('State directory must be absolute');
    this.native = native; this.directory = directory; this.plans = new Map(); this.closed = false; this.busy = false;
  }
  start() { this.closed = false; }
  shutdown() { this.closed = true; this.plans.clear(); }
  async stateDirectory() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const s = await lstat(this.directory);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o077)) throw new Error('Runtime directory must be owned, private and not a symlink');
    return this.directory;
  }
  async pending() {
    try {
      const directory = await lstat(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || (directory.mode & 0o077)) throw new Error('Unsafe runtime directory');
      const f = await open(join(this.directory, 'pending.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      try { const s = await f.stat(); if (!s.isFile() || s.size > 4096) throw new Error('Invalid pending record; stop writes'); return JSON.parse(await f.readFile('utf8')); }
      finally { await f.close(); }
    } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async plan(input, signal) {
    if (this.closed) throw new Error('Resolve plans stopped');
    if (!input || Object.keys(input).some(k => !['project_id', 'timeline_id', 'markers'].includes(k))) throw new Error('Unexpected plan parameter');
    const ids = validateRequest('state', { project_id: input.project_id, timeline_id: input.timeline_id });
    const before = await this.native.run('state', ids, signal);
    if (this.closed) throw new Error('Stale plan discarded');
    const operation_id = randomUUID();
    const copy = validateRequest('copy', { ...ids, expected: before.shape, operation_id, name: `Pi working ${operation_id}`, markers: input.markers ?? [] });
    const plan = { ...copy, created: Date.now(), template_sha256: hash(makeScript('copy', {})), project_name: before.project_name, source_name: before.timeline_name, effects: 'EXPERIMENTAL native recipe. Create copy, activate it, add relative-frame Blue markers, SAVE the current project (including pre-existing unsaved work). Never delete or overwrite. Copy does not isolate shared media/grades.' };
    const digest = hash(plan);
    // Store immutable bytes, not the returned object which a caller could mutate.
    if (this.plans.size >= 8) this.plans.delete(this.plans.keys().next().value);
    this.plans.set(digest, JSON.stringify(plan));
    return { digest, project_id: plan.project_id, source_timeline_id: plan.timeline_id, source_name: plan.source_name, copy_name: plan.name, markers: plan.markers, effects: plan.effects, expires_in_seconds: 600, apply: `/resolve apply ${digest}`, qualification: 'Experimental copy/marker recipe; requires native mutation qualification before production promotion' };
  }
  async apply(digest, ctx) {
    // Only the slash-command handler calls this; there is intentionally no model apply tool.
    if (this.closed || this.busy) throw new Error('Resolve plans stopped or writer busy');
    if (!ctx.hasUI) throw new Error('Operator UI confirmation required; headless writes disabled');
    if (!/^[a-f0-9]{64}$/.test(digest) || !this.plans.has(digest)) throw new Error('Unknown plan digest; make a fresh plan');
    const plan = JSON.parse(this.plans.get(digest));
    if (Date.now() - plan.created > 600000) { this.plans.delete(digest); throw new Error('Plan expired'); }
    this.busy = true;
    try {
      if (await this.pending()) throw new Error('Pending/unknown operation blocks writes; inspect and reconcile manually, never retry automatically');
      const before = await this.native.run('state', { project_id: plan.project_id, timeline_id: plan.timeline_id }, ctx.signal);
      if (hash(before.shape) !== hash(plan.expected)) throw new Error('Plan stale; make a fresh plan');
      const approved = await ctx.ui.confirm('Resolve: create working copy and SAVE project?', `Project: ${uiLabel(plan.project_name)} (${plan.project_id})\nSource: ${uiLabel(plan.source_name)} (${plan.timeline_id})\nTarget: ${plan.name}\nMarkers: ${plan.markers.length}\nDigest: ${digest}\n${plan.effects}\nPause manual edits until completion. Unknown outcomes stop further writes.`, { timeout: 120000 });
      if (!approved) return { cancelled: true, digest };
      ctx.signal?.throwIfAborted();
      if (this.closed || !this.plans.has(digest) || Date.now() - plan.created > 600000) throw new Error('Plan invalidated while waiting for approval');
      this.plans.delete(digest); // one human approval, one dispatch attempt
      const directory = await this.stateDirectory();
      const lockPath = join(directory, 'pending.json');
      let lock;
      try { lock = await open(lockPath, 'wx', 0o600); }
      catch (e) { if (e.code === 'EEXIST') throw new Error('Another/pending writer owns Resolve; no TTL stealing'); throw e; }
      const record = { operation_id: plan.operation_id, digest, pid: process.pid, process_started: new Date(Date.now() - process.uptime() * 1000).toISOString(), project_id: plan.project_id, source_timeline_id: plan.timeline_id, copy_name: plan.name, template_sha256: plan.template_sha256, state: 'dispatched_or_unknown', at: new Date().toISOString() };
      try {
        // Durable conservative marker precedes any native attempt; even not_sent failures block.
        await lock.writeFile(JSON.stringify(record)); await lock.sync();
        const dir = await open(directory, 'r');
        try { await dir.sync(); } finally { await dir.close(); }
        const { created, template_sha256, project_name, source_name, effects, ...args } = plan;
        const result = await this.native.run('copy', args, ctx.signal);
        if (!result.verified || !result.saved || result.project_id !== plan.project_id || result.source_timeline_id !== plan.timeline_id || typeof result.working_timeline_id !== 'string' || result.working_timeline_id === plan.timeline_id || result.name !== plan.name || result.markers_added !== plan.markers.length) throw new Error('Copy receipt mismatch');
        const receipt = await open(join(directory, `${plan.operation_id}.json`), 'wx', 0o600);
        try { await receipt.writeFile(JSON.stringify({ ...record, state: 'verified', result })); await receipt.sync(); }
        finally { await receipt.close(); }
        await unlink(lockPath);
        return { digest, ...result };
      } catch (e) {
        throw new Error(`Copy outcome unknown/partial; pending record retained, do not retry. ${e.message}`);
      } finally { await lock.close(); }
    } finally { this.busy = false; }
  }
}
