import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { NativeResolve } from './native.mjs';
import { ResolveGui, MENUS } from './gui.mjs';
import { ResolvePlans } from './plans.mjs';

const id = Type.String({ pattern: '^[a-zA-Z0-9_-]{1,128}$', maxLength: 128 });
const outputSchema = Type.Object({}, { additionalProperties: true });

export default function (pi: ExtensionAPI) {
  const native = new NativeResolve();
  const gui = new ResolveGui();
  const plans = new ResolvePlans(native);
  pi.on('session_start', async () => { native.start(); gui.start(); plans.start(); });
  pi.on('session_shutdown', async () => { plans.shutdown(); await Promise.allSettled([native.shutdown(), gui.shutdown()]); });

  pi.registerTool(defineTool({
    name: 'resolve_inspect',
    label: 'Resolve inspect',
    description: 'Read the current local Resolve Studio project. Start with summary (default) for IDs/settings; status diagnoses connection without launching Resolve; track reads up to 100 clips from one track using exact project/timeline IDs. No edits, source paths, media scanning or transcription. Frame positions are vendor API values, not a qualified edit-range convention.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    parameters: Type.Object({
      mode: Type.Optional(Type.Union([Type.Literal('status'), Type.Literal('summary'), Type.Literal('track')])),
      project_id: Type.Optional(id), timeline_id: Type.Optional(id),
      track_type: Type.Optional(Type.Union([Type.Literal('video'), Type.Literal('audio'), Type.Literal('subtitle')])),
      track_index: Type.Optional(Type.Integer({ minimum: 1, maximum: 1024 })),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }, { additionalProperties: false }),
    outputSchema,
    async execute(_id, params, signal) {
      const { mode = 'summary', ...args } = params;
      const data = await native.run(mode, args, signal);
      return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data, structuredContent: data };
    },
  }));

  pi.registerTool(defineTool({
    name: 'resolve_preview',
    label: 'Resolve current frame',
    description: 'Export and show the current timeline frame through Resolve to one private temporary PNG, then remove it. Requires exact IDs from resolve_inspect and an open timeline. Does not seek, switch pages, render a movie or edit/save the project. Keep GUI/playhead still during export. No source-frame fallback; display/color/composite fidelity is not yet live-qualified. Frames are sent to the current model provider.',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    parameters: Type.Object({ project_id: id, timeline_id: id }, { additionalProperties: false }),
    outputSchema,
    async execute(_id, params, signal) {
      const { image, ...data } = await native.run('preview', params, signal);
      return { content: [{ type: 'text', text: JSON.stringify(data) }, image], details: data, structuredContent: data };
    },
  }));

  pi.registerTool(defineTool({
    name: 'resolve_control',
    label: 'Resolve interface',
    description: 'Resolve-only GUI: status reads permissions/windows; screenshot shows one verified Resolve window (never desktop); menu opens only an allowlisted TOP-LEVEL menu and reads its items, never executes a submenu command. page navigates via the official API with exact context IDs. May focus Resolve and leave a menu open. No arbitrary clicks, keys, text, shell, preferences or deletes. Screenshots go to the current model provider.',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    parameters: Type.Object({
      action: Type.Optional(Type.Union(['status', 'screenshot', 'menu', 'page'].map(v => Type.Literal(v)))),
      menu: Type.Optional(Type.Union(MENUS.map(v => Type.Literal(v)))),
      window_id: Type.Optional(Type.Integer({ minimum: 1 })),
      project_id: Type.Optional(id), timeline_id: Type.Optional(id),
      page: Type.Optional(Type.Union(['media', 'cut', 'edit', 'fusion', 'color', 'fairlight', 'deliver'].map(v => Type.Literal(v)))),
    }, { additionalProperties: false }),
    outputSchema,
    async execute(_id, params, signal) {
      if (plans.busy) throw new Error('Writer active; do not move its GUI context');
      const { action = 'status', ...args } = params;
      const data = action === 'page' ? await native.run('page', args, signal) : await gui.run({ action, ...args }, signal);
      const { image, ...meta } = data;
      return { content: [{ type: 'text', text: JSON.stringify(meta) }, ...(image ? [image] : [])], details: meta, structuredContent: meta };
    },
  }));

  pi.registerTool(defineTool({
    name: 'resolve_plan',
    label: 'Resolve working-copy plan',
    description: 'Draft an immutable, expiring plan for a named timeline copy with up to 50 Blue markers. Does not edit/save. Marker frame is an integer offset FROM TIMELINE START, not absolute frame or timecode. Original clips unchanged. Apply is ONLY an operator /resolve apply DIGEST command with a UI approval; the model cannot approve itself. Experimental native mutation recipe, not production-qualified. No cutting, trimming, audio processing or rendering.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    parameters: Type.Object({ project_id: id, timeline_id: id,
      markers: Type.Optional(Type.Array(Type.Object({ frame: Type.Integer({ minimum: 0 }), name: Type.String({ maxLength: 80 }), note: Type.String({ maxLength: 250 }) }, { additionalProperties: false }), { maxItems: 50 })),
    }, { additionalProperties: false }),
    outputSchema,
    async execute(_id, params, signal) {
      const data = await plans.plan(params, signal);
      return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data, structuredContent: data };
    },
  }));

  pi.registerCommand('resolve', {
    description: 'Resolve status | pending | apply DIGEST (operator-only confirmation; creates copy/markers and saves project)',
    handler: async (args, ctx) => {
      const words = args.trim().split(/\s+/).filter(Boolean);
      let data;
      if (!words.length || (words.length === 1 && words[0] === 'status')) data = await native.run('status', {}, ctx.signal);
      else if (words.length === 1 && words[0] === 'pending') data = { pending: await plans.pending() };
      else if (words.length === 2 && words[0] === 'apply') {
        await ctx.waitForIdle();
        data = await plans.apply(words[1], ctx);
      } else throw new Error('Use /resolve status | pending | apply DIGEST');
      pi.sendMessage({ customType: 'pi-davinci-resolve-status', content: JSON.stringify(data), display: true });
    },
  });
}
