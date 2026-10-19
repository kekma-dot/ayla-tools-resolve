import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, chmod, rm, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { NativeResolve, unpack, readPng } from './native.mjs';
import { makeScript, validateRequest } from './templates.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const fake = join(root, 'test-fixture.mjs');
const entry = process.env.PI_TEST_ENTRY || join(root, 'index.ts');
await chmod(fake, 0o700);

async function fixture(mode, run) {
  const home = await mkdtemp(join(tmpdir(), 'pi-resolve-test-'));
  const before = { HOME: process.env.HOME, RESOLVE_MCP_PATH: process.env.RESOLVE_MCP_PATH };
  process.env.HOME = home; process.env.RESOLVE_MCP_PATH = fake;
  const native = new NativeResolve();
  try {
    await writeFile(join(home, 'fixture-mode'), mode);
    return await run(native, home);
  } finally {
    await native.shutdown();
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
}
async function waitFile(file) {
  for (let i = 0; i < 200; i++) {
    try { return await readFile(file, 'utf8'); } catch { await new Promise(r => setTimeout(r, 10)); }
  }
  throw new Error('Fixture did not start');
}

await test('strict parameter boundaries, unsupported modes and prototype keys', () => {
  for (const mode of ['run_script', 'run_script_unsafe', 'constructor', '__proto__']) assert.throws(() => validateRequest(mode));
  assert.throws(() => validateRequest('summary', { script: 'anything' }));
  assert.throws(() => validateRequest('preview', { project_id: '../x', timeline_id: 't' }));
  assert.throws(() => validateRequest('preview', { project_id: 'p', timeline_id: 't', output: '/tmp/override' }));
  for (const limit of [-1, 0, 101, NaN, 1.5]) assert.throws(() => validateRequest('track', { project_id: 'p', timeline_id: 't', track_type: 'video', track_index: 1, limit }));
  assert.equal(validateRequest('track', { project_id: 'p', timeline_id: 't', track_type: 'video', track_index: 1 }).limit, 50);
});

await test('serialized hostile text remains data in actual Python', () => {
  const payload = { text: '\"\nraise Exception(\"injected\")\n#\\\u2028привет', yes: true, none: null };
  payload.astral = '😀';
  const script = makeScript('summary', payload).split('p = resolve.')[0] + '\nassert len(args["astral"]) == 1\nprint(json.dumps(args))\n';
  const result = spawnSync(process.env.PYTHON || 'python3', ['-c', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), payload);
});

await test('parsing refuses error/missing/oversized results', () => {
  assert.throws(() => unpack({ isError: true }));
  for (const text of ['broken', 'null', '[]', '{"error":"bad"}', 'x'.repeat(131073)]) assert.throws(() => unpack({ content: [{ type: 'text', text }] }));
  assert.throws(() => unpack({ content: [{ type: 'text', text: '{}' }] }, true));
});

await test('fake native: qualified status and summary, exact tool allowlist', { skip: process.platform !== 'darwin' }, () => fixture('normal', async (native, home) => {
  assert.equal((await native.run('status')).recipes_enabled, true);
  assert.equal((await native.run('summary')).project.name, 'Synthetic');
  const calls = (await readFile(join(home, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.every(c => !c.name || ['get_resolve_status', 'run_script'].includes(c.name)));
  assert.equal(calls.filter(c => c.name === 'run_script').length, 1);
  const script = await readFile(join(home, 'script.py'), 'utf8');
  assert.ok(!/\b(Set\w*|Save\w*|Create\w*|Delete\w*|Launch\w*)\(/.test(script));
}));

await test('fake native: preview inline PNG and private temp cleanup; symlink rejected', { skip: process.platform !== 'darwin' }, () => fixture('normal', async (native, home) => {
  const data = await native.run('preview', { project_id: 'p', timeline_id: 't' });
  assert.equal(data.image.type, 'image'); assert.equal(data.width, 1); assert.equal(data.height, 1);
  const path = await readFile(join(home, 'preview-path'), 'utf8');
  await assert.rejects(access(dirname(path)));
  await writeFile(join(home, 'image.png'), Buffer.from(data.image.data, 'base64'));
  await symlink(join(home, 'image.png'), join(home, 'link.png'));
  await assert.rejects(readPng(join(home, 'link.png')));
  await writeFile(join(home, 'bad.png'), Buffer.alloc(24));
  await assert.rejects(readPng(join(home, 'bad.png')));
  await writeFile(join(home, 'oversized.png'), Buffer.alloc(8 * 1024 * 1024 + 1));
  await assert.rejects(readPng(join(home, 'oversized.png')), /oversized/);
}));

await test('fake native: new version is status-only; no scripts dispatched', { skip: process.platform !== 'darwin' }, () => fixture('new-version', async (native, home) => {
  assert.equal((await native.run('status')).recipes_enabled, false);
  await assert.rejects(native.run('summary'), /version\/schema/);
  assert.ok(!(await readFile(join(home, 'calls.jsonl'), 'utf8')).includes('run_script'));
}));

await test('fake native: stopped Resolve and server errors are failures', { skip: process.platform !== 'darwin' }, async () => {
  await fixture('not-running', async native => { await assert.rejects(native.run('summary'), /Open Resolve manually/); });
  await fixture('error', async native => { await assert.rejects(native.run('summary'), /returned an error/); });
});

await test('fake native: cancel after dispatch does not retry and closes only owned child', { skip: process.platform !== 'darwin' }, () => fixture('stall-script', async (native, home) => {
  const controller = new AbortController();
  const outcome = native.run('summary', {}, controller.signal).then(() => null, e => e);
  await waitFile(join(home, 'pid'));
  await waitFile(join(home, 'calls.jsonl')); // PID is written before the first request log.
  for (let i = 0; i < 200; i++) {
    if ((await readFile(join(home, 'calls.jsonl'), 'utf8')).includes('run_script')) break;
    await new Promise(r => setTimeout(r, 10));
  }
  controller.abort(new Error('test cancellation'));
  assert.match((await outcome).message, /test cancellation/);
  const calls = await readFile(join(home, 'calls.jsonl'), 'utf8');
  assert.equal(calls.split('\n').filter(l => l.includes('run_script')).length, 1);
  const pid = Number(await readFile(join(home, 'pid'), 'utf8'));
  assert.throws(() => process.kill(pid, 0));
}));

await test('fake native: pending initialize → shutdown → restart; no late publication', { skip: process.platform !== 'darwin' }, () => fixture('stall-init', async (native, home) => {
  const result = native.run('summary').then(() => null, e => e);
  await waitFile(join(home, 'pid'));
  await native.shutdown();
  assert.match((await result).message, /stopped/);
  await assert.rejects(native.run('summary'), /stopped/);
  await writeFile(join(home, 'fixture-mode'), 'normal');
  native.start();
  assert.equal((await native.run('summary')).project.name, 'Synthetic');
  assert.equal(native.jobs.size, 0);
}));

await test('actual Pi resource loader, isolated HOME, unique tools and no factory subprocess', { skip: !process.env.PI_TEST_SDK_ROOT }, () => fixture('normal', async (_native, home) => {
  const sdk = await import(pathToFileURL(resolve(process.env.PI_TEST_SDK_ROOT, 'dist/index.js')).href);
  const settingsManager = sdk.SettingsManager.inMemory({});
  const loader = new sdk.DefaultResourceLoader({ cwd: home, agentDir: join(home, 'agent'), settingsManager, additionalExtensionPaths: [entry], noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  assert.deepEqual([...extension.tools.keys()], ['resolve_inspect', 'resolve_preview', 'resolve_control', 'resolve_plan']);
  assert.deepEqual([...extension.commands.keys()], ['resolve']);
  await assert.rejects(access(join(home, 'pid'))); // factory must not start MCP.
  const tool = extension.tools.get('resolve_inspect').definition;
  if (process.platform === 'darwin') {
    const data = await tool.execute('test', { mode: 'summary' }, new AbortController().signal, () => {}, {});
    assert.equal(data.structuredContent.project.name, 'Synthetic');
    assert.equal(JSON.parse(data.content[0].text).project.name, 'Synthetic');
  } else {
    await assert.rejects(tool.execute('test', { mode: 'summary' }, undefined, undefined, {}), /only on macOS/);
    await assert.rejects(access(join(home, 'pid')));
  }
  for (const handler of extension.handlers.get('session_shutdown')) await handler({ type: 'session_shutdown', reason: 'quit' }, {});
  await assert.rejects(tool.execute('test', {}, new AbortController().signal, () => {}, {}), /stopped/);
  const pkg = JSON.parse(await readFile(resolve(process.env.PI_TEST_SDK_ROOT, 'package.json'), 'utf8'));
  console.log(JSON.stringify({ node: process.version, sdk: pkg.version, sdkRoot: process.env.PI_TEST_SDK_ROOT, entry, loader: 'PASS', syntheticBackend: true, securityPipeline: 'NOT_TESTED by direct executor check' }));
}));

await test('actual SDK session: allow/deny hooks, image propagation and shutdown', { skip: !process.env.PI_TEST_SDK_ROOT || process.platform !== 'darwin' }, () => fixture('normal', async (_native, home) => {
  const sdk = await import(pathToFileURL(resolve(process.env.PI_TEST_SDK_ROOT, 'dist/index.js')).href);
  const ai = await import(pathToFileURL(resolve(process.env.PI_TEST_SDK_ROOT, '../pi-ai/dist/index.js')).href);
  const modelRuntime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(home, 'models-cache.json'), refreshOnCreate: false });
  const faux = ai.fauxProvider({ provider: 'resolve-tests', models: [{ id: 'fixture', input: ['text', 'image'] }], tokensPerSecond: 100000 });
  modelRuntime.registerNativeProvider(faux.provider);
  let denied = true;
  let seen = 0;
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' });
  const loader = new sdk.DefaultResourceLoader({ cwd: home, agentDir: join(home, 'agent'), settingsManager, additionalExtensionPaths: [entry], noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [pi => {
    pi.on('tool_call', event => {
      if (event.toolName.startsWith('resolve_')) { seen++; if (denied) return { block: true, reason: 'Synthetic deny' }; }
    });
  }] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await sdk.createAgentSession({ cwd: home, agentDir: join(home, 'agent'), modelRuntime, model: faux.getModel(), thinkingLevel: 'off', settingsManager, resourceLoader: loader, tools: ['resolve_inspect', 'resolve_preview', 'resolve_control', 'resolve_plan'], sessionManager: sdk.SessionManager.inMemory(home) });
  try {
    await session.bindExtensions({ mode: 'json', shutdownHandler: () => {} });
    assert.deepEqual(session.getActiveToolNames().sort(), ['resolve_control', 'resolve_inspect', 'resolve_plan', 'resolve_preview']);
    faux.setResponses([
      ai.fauxAssistantMessage(ai.fauxToolCall('resolve_inspect', {}, { id: 'deny' }), { stopReason: 'toolUse' }),
      context => {
        const result = context.messages.find(m => m.role === 'toolResult' && m.toolCallId === 'deny');
        assert.equal(result?.isError, true);
        return ai.fauxAssistantMessage('Denied as expected');
      },
    ]);
    await session.prompt('Run the read-only inspect test');
    await assert.rejects(access(join(home, 'pid')));
    faux.setResponses([
      ai.fauxAssistantMessage(ai.fauxToolCall('resolve_plan', { project_id: 'p', timeline_id: 't' }, { id: 'deny-plan' }), { stopReason: 'toolUse' }),
      context => {
        assert.equal(context.messages.find(m => m.role === 'toolResult' && m.toolCallId === 'deny-plan')?.isError, true);
        return ai.fauxAssistantMessage('Plan blocked before native call');
      },
    ]);
    await session.prompt('Run denied plan boundary test');
    await assert.rejects(access(join(home, 'pid')));
    faux.setResponses([
      ai.fauxAssistantMessage(ai.fauxToolCall('resolve_control', { action: 'page', project_id: 'p', timeline_id: 't', page: 'edit' }, { id: 'deny-control' }), { stopReason: 'toolUse' }),
      context => {
        assert.equal(context.messages.find(m => m.role === 'toolResult' && m.toolCallId === 'deny-control')?.isError, true);
        return ai.fauxAssistantMessage('Control blocked before executor');
      },
    ]);
    await session.prompt('Run denied control boundary test');
    await assert.rejects(access(join(home, 'pid')));
    denied = false;
    faux.setResponses([
      ai.fauxAssistantMessage(ai.fauxToolCall('resolve_inspect', {}, { id: 'allow' }), { stopReason: 'toolUse' }),
      context => {
        const result = context.messages.find(m => m.role === 'toolResult' && m.toolCallId === 'allow');
        assert.equal(result?.isError, false);
        assert.equal(JSON.parse(result.content[0].text).project.name, 'Synthetic');
        return ai.fauxAssistantMessage('Readback verified');
      },
    ]);
    await session.prompt('Run the allowed inspect test');
    faux.setResponses([
      ai.fauxAssistantMessage(ai.fauxToolCall('resolve_preview', { project_id: 'p', timeline_id: 't' }, { id: 'image' }), { stopReason: 'toolUse' }),
      context => {
        const result = context.messages.find(m => m.role === 'toolResult' && m.toolCallId === 'image');
        assert.equal(result?.isError, false);
        assert.ok(result.content.some(c => c.type === 'image' && c.mimeType === 'image/png' && c.data.length > 0));
        return ai.fauxAssistantMessage('Synthetic image received');
      },
    ]);
    await session.prompt('Run the synthetic preview test');
    faux.setResponses([
      ai.fauxAssistantMessage(ai.fauxToolCall('resolve_plan', { project_id: 'p', timeline_id: 't' }, { id: 'allowed-plan' }), { stopReason: 'toolUse' }),
      context => {
        const result = context.messages.find(m => m.role === 'toolResult' && m.toolCallId === 'allowed-plan');
        assert.equal(result?.isError, false);
        assert.match(JSON.parse(result.content[0].text).digest, /^[a-f0-9]{64}$/);
        return ai.fauxAssistantMessage('Draft only, operator command required');
      },
    ]);
    await session.prompt('Draft a synthetic plan, never apply');
    const scripts = await readFile(join(home, 'script.py'), 'utf8');
    assert.ok(!scripts.includes('DuplicateTimeline'));
    assert.equal(seen, 6);
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    console.log(JSON.stringify({ sdkSession: 'PASS', actualHookDeny: 'PASS', nativeCallsOnDeny: 0, imageInNextProviderContext: 'PASS', backend: 'synthetic', livePreview: 'NOT_TESTED' }));
  } finally { session.dispose(); }
}));
