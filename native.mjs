import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, open, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { makeScript, validateRequest } from './templates.mjs';

const DEFAULT_BINARY = '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Applications/ResolveMCP';
export const QUALIFIED_SCHEMA = 'de1fec8e214ee913fb3b25a3926c36b1c5b403a2292f0cd4af7bd2085086f7fa';
const MAX_TEXT = 128 * 1024;
const MAX_IMAGE = 8 * 1024 * 1024;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export function schemaHash(tools) {
  const selected = tools.filter(t => ['get_resolve_status', 'run_script'].includes(t.name))
    .map(t => ({ name: t.name, inputSchema: t.inputSchema })).sort((a, b) => a.name.localeCompare(b.name));
  return createHash('sha256').update(JSON.stringify(canonical(selected))).digest('hex');
}

export function unpack(reply, script = false) {
  if (reply.isError) throw new Error('Resolve MCP returned an error (no automatic retry)');
  const text = (reply.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  if (!text || Buffer.byteLength(text) > MAX_TEXT) throw new Error('Missing/oversized Resolve result');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Invalid Resolve JSON result'); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.error) throw new Error('Invalid/error Resolve result');
  if (script) {
    if (!data.result || typeof data.result !== 'object' || Array.isArray(data.result)) throw new Error('Missing script result');
    return data.result;
  }
  return data;
}

async function cancellable(work, signal) {
  signal.throwIfAborted();
  let onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('Aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

export async function readPng(path) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size < 24 || stat.size > MAX_IMAGE) throw new Error('Invalid/oversized preview file');
    // Bounded even if a writer grows the file after fstat.
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await fd.read(bytes, count, bytes.length - count, null);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count !== stat.size) throw new Error('Preview changed while reading');
    const data = bytes.subarray(0, count);
    const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
    if (!data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || data.toString('ascii', 12, 16) !== 'IHDR' || width < 1 || height < 1 || width > 8192 || height > 8192) throw new Error('Unsupported preview image');
    return { data: data.toString('base64'), width, height, sha256: createHash('sha256').update(data).digest('hex') };
  } finally { await fd.close(); }
}

export class NativeResolve {
  // No processes/timers/files at construction; each request owns one short-lived MCP.
  constructor() { this.closed = false; this.generation = 0; this.jobs = new Map(); }
  start() { this.closed = false; this.generation++; }
  async shutdown() {
    this.closed = true;
    this.generation++;
    for (const controller of this.jobs.keys()) controller.abort(new Error('Resolve extension stopped'));
    await Promise.allSettled([...this.jobs.values()]);
  }
  async run(mode, input = {}, externalSignal) {
    const args = mode === 'status' ? validateRequest('summary', input) : validateRequest(mode, input);
    externalSignal?.throwIfAborted();
    if (this.closed) throw new Error('Resolve extension is stopped');
    if (process.platform !== 'darwin') throw new Error('Native Resolve backend is currently qualified only on macOS');
    const binary = process.env.RESOLVE_MCP_PATH || DEFAULT_BINARY;
    if (!isAbsolute(binary)) throw new Error('RESOLVE_MCP_PATH must be absolute');
    const controller = new AbortController();
    const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal;
    const generation = this.generation;
    const timeout = setTimeout(() => controller.abort(new Error('Resolve timeout; no automatic retry')), 30000);
    const work = this.perform(binary, mode, args, signal).then(result => {
      signal.throwIfAborted();
      if (this.closed || generation !== this.generation) throw new Error('Stale Resolve result discarded');
      return result;
    });
    this.jobs.set(controller, work);
    try { return await work; }
    finally { clearTimeout(timeout); this.jobs.delete(controller); }
  }
  async perform(binary, mode, args, signal) {
    const stat = await lstat(binary);
    signal.throwIfAborted();
    if (!stat.isFile() || !(stat.mode & 0o111)) throw new Error('ResolveMCP must be a regular executable');
    const client = new Client({ name: 'pi-davinci-resolve', version: '0.2.0' });
    const transport = new StdioClientTransport({ command: binary, env: { BMD_IS_MCPB: '1' }, stderr: 'pipe', maxBufferSize: 1024 * 1024 });
    transport.stderr?.resume(); // Never forward native stderr or potential private paths into the transcript.
    let dir;
    try {
      await cancellable(client.connect(transport), signal);
      signal.throwIfAborted();
      const tools = await client.listTools({}, { signal, timeout: 10000 });
      if (tools.nextCursor) throw new Error('Unexpected paginated tool schema');
      const schema = schemaHash(tools.tools);
      const version = client.getServerVersion();
      const status = unpack(await client.callTool({ name: 'get_resolve_status', arguments: {} }, undefined, { signal, timeout: 10000 }));
      if (typeof status.running !== 'boolean') throw new Error('Invalid Resolve status');
      const qualified = version?.name === 'davinci_resolve' && version?.version === '21.1.1' && schema === QUALIFIED_SCHEMA;
      if (mode === 'status') return { ...status, server: version, schema_sha256: schema, recipes_enabled: qualified, scope: 'fixed recipes; GUI navigation; copy/markers only via operator-approved command; no arbitrary scripts' };
      if (!qualified) throw new Error('Resolve version/schema changed; status only until requalification');
      if (!status.running) throw new Error('Open Resolve manually; automatic launch is disabled');
      if (mode === 'preview') dir = await mkdtemp(join(tmpdir(), 'pi-resolve-preview-'));
      signal.throwIfAborted();
      const script = makeScript(mode, dir ? { ...args, output: join(dir, 'frame.png') } : args);
      const data = unpack(await client.callTool({ name: 'run_script', arguments: { script, timeout: 10 } }, undefined, { signal, timeout: 15000 }), true);
      signal.throwIfAborted();
      if (mode !== 'preview') return data;
      if (data.exported !== true || data.snapshot?.project_id !== args.project_id || data.snapshot?.timeline_id !== args.timeline_id) throw new Error('Preview export failed or context changed');
      const image = await readPng(join(dir, 'frame.png'));
      return { ...data, width: image.width, height: image.height, sha256: image.sha256, image: { type: 'image', mimeType: 'image/png', data: image.data } };
    } finally {
      // Closing only our MCP transport never quits Resolve. In-flight native export may still finish.
      await transport.close();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  }
}
