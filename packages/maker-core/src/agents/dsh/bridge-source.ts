/** Runtime-only Cordis plugin. It owns Cindy's JSON-RPC session boundary. */
export const DSH_BRIDGE_SOURCE = String.raw`import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

export const name = 'cindy-dsh-bridge';
export const inject = ['agents', 'agentPresets', 'permissionPresets', 'sessionPersistence'];

export async function apply(ctx) {
  const moduleUrl = process.env.DSH_AGENT_MODULE_URL;
  if (!moduleUrl) throw new Error('DSH_AGENT_MODULE_URL is required');
  const { installModelSelection } = await import(moduleUrl);
  const handles = new Map();
  const selections = new Map();
  let route = null;
  let shuttingDown = false;
  const disposers = [];
  const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
  const notify = (method, params) => send({ method, params });

  disposers.push(ctx.on('session/event', (session, event) => {
    notify('session.event', { sessionId: String(session.id), event });
  }));
  disposers.push(ctx.on('agent/status', ({ agent, status }) => {
    notify('session.status', { sessionId: String(agent.session.id), status });
  }));

  const agentOptions = () => ({
    provider: route.provider,
    model: route.model,
    ...(route.maxTokens === undefined ? {} : { maxTokens: route.maxTokens }),
  });
  const sessionPreset = (inspection) => {
    for (let index = inspection.events.length - 1; index >= 0; index -= 1) {
      const event = inspection.events[index];
      if (event?.type === 'agent-preset/selected') return event.data.agentPreset;
    }
    return inspection.meta.agentPreset;
  };
  const composePreset = async (presetId) => {
    const resolved = (await ctx.agentPresets.resolve(presetId)).id;
    return {
      id: resolved,
      setup: async (agentCtx) => {
        const selection = {
          current: {
            provider: route.provider,
            model: route.model,
            ...(route.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: route.reasoningEffort }),
          },
          assembled: undefined,
        };
        installModelSelection(agentCtx, selection);
        selections.set(agentCtx.agent, selection);
        await ctx.agentPresets.mount(agentCtx, resolved);
      },
    };
  };
  const applyPermission = (handle) => {
    ctx.permissionPresets.set(handle.agent.session, route.permissionPreset);
  };
  const createSession = async (sessionId) => {
    const composition = await composePreset(route.agentPreset);
    const handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: route.cwd, agentPreset: composition.id },
      agentOptions: agentOptions(),
      setup: composition.setup,
    });
    applyPermission(handle);
    return handle;
  };
  const resumeSession = async (sessionId) => {
    const inspection = await ctx.sessionPersistence.inspect(sessionId);
    const composition = await composePreset(sessionPreset(inspection) ?? route.agentPreset);
    const handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: agentOptions(),
      setup: composition.setup,
    });
    applyPermission(handle);
    return handle;
  };
  const getOrCreate = async (sessionId) => {
    if (shuttingDown) throw new Error('dsh bridge is shutting down');
    const known = handles.get(sessionId);
    if (known) return known;
    const handle = await createSession(sessionId);
    handles.set(sessionId, handle);
    return handle;
  };

  const request = async (method, params) => {
    if (method === 'initialize') {
      if (route) throw new Error('dsh bridge does not support reinitialize');
      if (!params || typeof params.cwd !== 'string' || typeof params.provider !== 'string'
        || typeof params.model !== 'string' || typeof params.permissionPreset !== 'string'
        || (params.agentPreset !== undefined && typeof params.agentPreset !== 'string')) {
        throw new Error('invalid initialize params');
      }
      const requestedPreset = params.agentPreset ?? ctx.agentPresets.defaultId;
      const resolvedPreset = await ctx.agentPresets.resolve(requestedPreset);
      route = { ...params, agentPreset: resolvedPreset.id };
      ctx.permissionPresets.resolve(route.permissionPreset);
      return { serverInfo: { name: 'cindy-dsh-bridge', version: '0.2.0' } };
    }
    if (!route) throw new Error('initialize must be called first');
    if (method === 'session/prompt') {
      const handle = await getOrCreate(params.sessionId);
      const message = {
        id: randomUUID(),
        role: 'user',
        content: params.contentBlocks,
        source: { kind: 'user' },
      };
      handle.agent.followup(message);
      return { messageId: message.id };
    }
    if (method === 'preset/list') {
      const presets = await ctx.agentPresets.list();
      return {
        defaultPreset: ctx.agentPresets.defaultId,
        presets: presets.map(({ id, name, description, trust, broken }) => ({
          id,
          ...(name === undefined ? {} : { name }),
          ...(description === undefined ? {} : { description }),
          trust,
          ...(broken === undefined ? {} : { broken }),
        })),
      };
    }
    if (method === 'session/resume') {
      const id = params.sessionId;
      if (handles.has(id)) return { sessionId: id };
      const handle = await resumeSession(id);
      handles.set(id, handle);
      return { sessionId: id };
    }
    if (method === 'session/setPermissionPreset') {
      ctx.permissionPresets.resolve(params.permissionPreset);
      route.permissionPreset = params.permissionPreset;
      const handle = handles.get(params.sessionId);
      if (handle) applyPermission(handle);
      return { permissionPreset: route.permissionPreset };
    }
    if (method === 'session/setEffort') {
      if (!['low', 'high', 'max'].includes(params.reasoningEffort)) {
        throw new Error('unsupported DSH reasoning effort: ' + params.reasoningEffort);
      }
      route.reasoningEffort = params.reasoningEffort;
      const handle = handles.get(params.sessionId);
      const selection = handle ? selections.get(handle.agent) : undefined;
      if (selection) {
        selection.current = {
          provider: route.provider,
          model: route.model,
          reasoningEffort: route.reasoningEffort,
        };
      }
      return { reasoningEffort: route.reasoningEffort };
    }
    if (method === 'session/cancel') {
      const handle = handles.get(params.sessionId);
      if (!handle) return { accepted: false, wasRunning: false };
      const wasRunning = handle.agent.status === 'running';
      await handle.agent.cancel({ kind: 'user' }, { keepInbox: false });
      return { accepted: true, wasRunning };
    }
    if (method === 'shutdown') {
      shuttingDown = true;
      for (const dispose of disposers.splice(0)) dispose();
      const all = [...handles.values()];
      handles.clear();
      selections.clear();
      await Promise.allSettled(all.map((handle) => handle.dispose()));
      return {};
    }
    throw new Error('unknown dsh bridge method: ' + method);
  };

  const decoder = new StringDecoder('utf8');
  let buffer = '';
  const onData = (chunk) => {
    buffer += decoder.write(chunk);
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      if (!frame || typeof frame.id !== 'string' || typeof frame.method !== 'string') continue;
      Promise.resolve(request(frame.method, frame.params)).then(
        (result) => {
          send({ id: frame.id, result });
          if (frame.method === 'shutdown') {
            setImmediate(() => { void ctx.root.fiber.dispose().finally(() => process.exit(0)); });
          }
        },
        (error) => send({
          id: frame.id,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        }),
      );
    }
  };
  process.stdin.on('data', onData);
  process.stdin.resume();
  ctx.effect(() => () => {
    process.stdin.off('data', onData);
    for (const dispose of disposers.splice(0)) dispose();
  }, 'cindy-dsh-bridge');
}`;
