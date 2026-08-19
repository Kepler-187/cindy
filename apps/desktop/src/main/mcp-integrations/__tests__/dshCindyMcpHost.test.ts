import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getLiziMcpSessionContext } from '@cindy/mcps';

import {
  createDshCindyMcpHost,
  type DshCindyMcpHost,
  type DshCindyMcpHostDeps,
} from '../dshCindyMcpHost.js';

async function readRpcResponse(resp: Response): Promise<unknown> {
  const text = await resp.text();
  const eventPayload = text
    .split(/\r?\n/)
    .find((line) => line.startsWith('data: '))
    ?.slice('data: '.length);
  return JSON.parse(eventPayload ?? text);
}

/** 探针 server:回显 ALS 会话语境,验证 tool-call 的身份路由。 */
function createProbeServer(): McpServer {
  const server = new McpServer({ name: 'cindy', version: '1.0.0' });
  server.tool(
    'current_context',
    'Echo the active lizi MCP session context.',
    {},
    async () => {
      const ctx = getLiziMcpSessionContext();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              agentKind: ctx?.agentKind ?? null,
              sessionId: ctx?.sessionId ?? null,
              sessionInstanceId: ctx?.sessionInstanceId ?? null,
              workingDir: ctx?.workingDir ?? null,
            }),
          },
        ],
      };
    },
  );
  return server;
}

function buildHost(overrides: Partial<DshCindyMcpHostDeps> = {}): DshCindyMcpHost {
  return createDshCindyMcpHost({
    getLiveSessionInstanceId: (sessionId) => `instance-of-${sessionId}`,
    createServer: () => createProbeServer(),
    ...overrides,
  });
}

const INIT_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'dsh-test-client', version: '1.0.0' },
  },
});

async function initSession(
  url: string,
  token: string,
): Promise<{ status: number; mcpSessionId: string | null; body: string }> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: INIT_BODY,
  });
  const body = await resp.text();
  return { status: resp.status, mcpSessionId: resp.headers.get('mcp-session-id'), body };
}

async function callTool(
  url: string,
  token: string,
  mcpSessionId: string,
  id: number,
): Promise<{ status: number; payload: unknown }> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-session-id': mcpSessionId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'current_context', arguments: {} },
    }),
  });
  if (resp.status !== 200) {
    await resp.text();
    return { status: resp.status, payload: null };
  }
  return { status: resp.status, payload: await readRpcResponse(resp) };
}

describe('dshCindyMcpHost', () => {
  let host: DshCindyMcpHost | null = null;

  afterEach(async () => {
    await host?.shutdown();
    host = null;
  });

  it('rejects requests without a registered bearer token (401) and non-/mcp paths (404)', async () => {
    host = buildHost();
    const { url, token } = await host.registerSession('session-1', '/repo');

    const noAuth = await fetch(url, { method: 'POST', body: INIT_BODY });
    expect(noAuth.status).toBe(401);

    const badToken = await initSession(url, 'wrong-token');
    expect(badToken.status).toBe(401);

    const otherPath = await fetch(url.replace('/mcp', '/other'), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: INIT_BODY,
    });
    expect(otherPath.status).toBe(404);

    const good = await initSession(url, token);
    expect(good.status).toBe(200);
    expect(good.mcpSessionId).toBeTruthy();
  });

  it('runs tool calls under the registered session context (agentKind/workingDir/live instance)', async () => {
    host = buildHost();
    const { url, token } = await host.registerSession('session-ctx', '/repo/dsh');

    const init = await initSession(url, token);
    expect(init.status).toBe(200);
    expect(init.mcpSessionId).toBeTruthy();

    const call = await callTool(url, token, init.mcpSessionId!, 2);
    expect(call.status).toBe(200);
    expect(call.payload).toMatchObject({
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              agentKind: 'dsh',
              sessionId: 'session-ctx',
              sessionInstanceId: 'instance-of-session-ctx',
              workingDir: '/repo/dsh',
            }),
          },
        ],
      },
    });
  });

  it('keeps concurrent sessions isolated by per-session tokens', async () => {
    host = buildHost();
    const a = await host.registerSession('session-a', '/repo/a');
    const b = await host.registerSession('session-b', '/repo/b');
    expect(a.url).toBe(b.url);
    expect(a.token).not.toBe(b.token);

    const initA = await initSession(a.url, a.token);
    const initB = await initSession(b.url, b.token);
    expect(initA.status).toBe(200);
    expect(initB.status).toBe(200);

    const callA = await callTool(a.url, a.token, initA.mcpSessionId!, 2);
    expect(callA.payload).toMatchObject({
      result: { content: [{ type: 'text', text: expect.stringContaining('"sessionId":"session-a"') }] },
    });
    const callB = await callTool(b.url, b.token, initB.mcpSessionId!, 3);
    expect(callB.payload).toMatchObject({
      result: { content: [{ type: 'text', text: expect.stringContaining('"sessionId":"session-b"') }] },
    });
  });

  it('unregisters only on the matching token generation (late close cannot clobber a rebuild)', async () => {
    host = buildHost();
    const first = await host.registerSession('session-rebuild', '/repo');
    // 同 sessionId 重建:换发新 token(新代际)。
    const rebuilt = await host.registerSession('session-rebuild', '/repo');
    // 第三个会话保持 server 存活,便于观察「已注销会话的 401」而不是关服。
    const keepalive = await host.registerSession('session-keepalive', '/repo');
    expect(rebuilt.token).not.toBe(first.token);

    // 旧实例迟到的注销:token 不匹配 → 跳过,新注册保持可用。
    host.unregisterSession('session-rebuild', first.token);
    const stillAlive = await initSession(rebuilt.url, rebuilt.token);
    expect(stillAlive.status).toBe(200);

    // 正确代际注销 → 该会话 token 立即 401(keepalive 使 server 不关)。
    host.unregisterSession('session-rebuild', rebuilt.token);
    const dead = await initSession(rebuilt.url, rebuilt.token);
    expect(dead.status).toBe(401);
    const other = await initSession(keepalive.url, keepalive.token);
    expect(other.status).toBe(200);
  });

  it('closes the HTTP server after the last session unregisters and can be re-registered', async () => {
    host = buildHost();
    const first = await host.registerSession('session-close', '/repo');
    host.unregisterSession('session-close', first.token);

    // 服务已关:请求应当连接失败(而不是 401)。
    await expect(fetch(first.url, { method: 'POST', body: INIT_BODY })).rejects.toThrow();

    // 重新注册 → 新端点重新可用。
    const second = await host.registerSession('session-close-2', '/repo');
    const init = await initSession(second.url, second.token);
    expect(init.status).toBe(200);
  });

  it('requires a valid mcp-session-id after initialization', async () => {
    host = buildHost();
    const { url, token } = await host.registerSession('session-strict', '/repo');
    const init = await initSession(url, token);
    expect(init.status).toBe(200);

    const stale = await callTool(url, token, 'unknown-mcp-session', 2);
    expect(stale.status).toBe(404);
  });
});
