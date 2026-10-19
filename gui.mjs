import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng } from './native.mjs';

const exec = promisify(execFile);
export const MENUS = ['File', 'Edit', 'Trim', 'Timeline', 'Clip', 'Mark', 'View', 'Playback', 'Fusion', 'Color', 'Fairlight', 'Workspace', 'Help'];
export function validateGui(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected GUI parameters');
  const { action = 'status', menu, window_id } = input;
  if (!['status', 'screenshot', 'menu'].includes(action)) throw new Error('Unsupported GUI action');
  const keys = action === 'menu' ? ['action', 'menu'] : action === 'screenshot' ? ['action', 'window_id'] : ['action'];
  if (Object.keys(input).some(k => !keys.includes(k))) throw new Error('Unexpected GUI parameter');
  if (action === 'menu' && !MENUS.includes(menu)) throw new Error('Only allowlisted top-level menus can be opened');
  if (window_id !== undefined && (!Number.isSafeInteger(window_id) || window_id < 1)) throw new Error('Invalid window ID');
  return { action, ...(menu === undefined ? {} : { menu }), ...(window_id === undefined ? {} : { window_id }) };
}
export class ResolveGui {
  constructor() { this.closed = false; this.jobs = new Map(); }
  start() { this.closed = false; }
  async shutdown() {
    this.closed = true;
    for (const c of this.jobs.keys()) c.abort(new Error('Resolve GUI stopped'));
    await Promise.allSettled([...this.jobs.values()]);
  }
  async run(input, externalSignal) {
    const args = validateGui(input);
    if (this.closed) throw new Error('Resolve GUI stopped');
    if (process.platform !== 'darwin') throw new Error('Resolve GUI requires macOS');
    const controller = new AbortController();
    const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
    signal.throwIfAborted();
    if (this.jobs.size) throw new Error('Resolve GUI action already in progress; do not queue stale clicks');
    const work = this.perform(args, signal);
    this.jobs.set(controller, work);
    try { return await work; } finally { this.jobs.delete(controller); }
  }
  async perform(args, signal) {
    let dir;
    try {
      if (args.action === 'screenshot') dir = await mkdtemp(join(tmpdir(), 'pi-resolve-window-'));
      signal.throwIfAborted();
      const request = { ...args, ...(dir ? { output: join(dir, 'window.png') } : {}) };
      const child = exec('/usr/bin/swift', [fileURLToPath(new URL('./resolve-gui.swift', import.meta.url))], { signal, timeout: 20000, maxBuffer: 128 * 1024, encoding: 'utf8' });
      child.child.stdin.end(JSON.stringify(request));
      const { stdout } = await child;
      signal.throwIfAborted();
      if (this.closed) throw new Error('Stale GUI result discarded');
      const data = JSON.parse(stdout);
      if (!dir) return data;
      const png = await readPng(join(dir, 'window.png'));
      signal.throwIfAborted();
      if (this.closed) throw new Error('Stale GUI result discarded');
      return { ...data, width: png.width, height: png.height, sha256: png.sha256, image: { type: 'image', mimeType: 'image/png', data: png.data }, privacy: 'Resolve window sent to current model provider; may include dialogs and filenames' };
    } finally { if (dir) await rm(dir, { recursive: true, force: true }); }
  }
}
