#!/usr/bin/env node
// Synthetic stdio MCP for tests only. Never included in the package artifact.
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const home = process.env.HOME;
const mode = readFileSync(join(home, 'fixture-mode'), 'utf8');
writeFileSync(join(home, 'pid'), String(process.pid));
const tools = [
  { name: 'get_resolve_status', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'run_script', inputSchema: { type: 'object', properties: { script: { type: 'string', description: 'Python script to execute' }, timeout: { type: 'integer', description: 'Timeout in seconds (default: 10, max: 60)' } }, required: ['script'] } },
];
function send(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (!Object.hasOwn(msg, 'id')) return;
  appendFileSync(join(home, 'calls.jsonl'), JSON.stringify({ method: msg.method, name: msg.params?.name }) + '\n');
  if (msg.method === 'initialize') {
    if (mode === 'stall-init') return;
    return send(msg.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'davinci_resolve', version: mode === 'new-version' ? '22.0' : '21.1.1' } });
  }
  if (msg.method === 'tools/list') return send(msg.id, { tools });
  if (msg.method === 'tools/call') {
    if (msg.params.name === 'get_resolve_status') return send(msg.id, { content: [{ type: 'text', text: JSON.stringify({ running: mode !== 'not-running', version: '21.1.1' }) }] });
    if (msg.params.name !== 'run_script') throw new Error('Forbidden tool');
    if (mode === 'stall-script') return;
    if (mode === 'error') return send(msg.id, { isError: true, content: [{ type: 'text', text: 'fixture error' }] });
    const script = msg.params.arguments.script;
    const args = JSON.parse(JSON.parse(script.match(/^args = json.loads\((.+)\)$/m)[1]));
    writeFileSync(join(home, 'script.py'), script);
    let result = { product: 'DaVinci Resolve Studio', project: { name: 'Synthetic', id: 'project-1', timeline_count: 0 }, timeline: null };
    if (script.includes('def structure(') && !args.expected) result = { project_id: args.project_id, timeline_id: args.timeline_id, project_name: 'Synthetic', timeline_name: 'Source', shape: { start: 216000, end: 216600, fps: '60', width: '1920', height: '1080', tracks: [], markers: {} } };
    if (args.output) {
      writeFileSync(join(home, 'preview-path'), args.output);
      writeFileSync(args.output, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
      result = { exported: true, provenance: 'synthetic-fixture', snapshot: { project_id: args.project_id, timeline_id: args.timeline_id, timecode: '01:00:00:00' } };
    }
    return send(msg.id, { content: [{ type: 'text', text: JSON.stringify({ result }) }] });
  }
  throw new Error('Unexpected method');
});
