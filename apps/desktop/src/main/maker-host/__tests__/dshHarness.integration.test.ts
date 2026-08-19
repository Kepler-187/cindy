import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DshAgent,
  type AgentDeps,
  type AgentEvent,
  type AgentSessionHandle,
} from '@cindy/maker-core';
import { describe, expect, it } from 'vitest';

const logger: AgentDeps['logger'] = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return logger;
  },
};

const desktopRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const repoRoot = path.resolve(desktopRoot, '..', '..');

function dshLauncher(): string {
  return path.resolve(desktopRoot, 'dsh', 'cindy-dsh-bin.mjs');
}

function dshWebCli(): string {
  return path.resolve(
    repoRoot,
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js',
  );
}

function dshWebPatch(): string {
  return path.resolve(desktopRoot, 'dsh', 'cindy-dsh-web.patch.yml');
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('fake DeepSeek server did not expose a TCP port');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`);
}

async function startDshWeb(dshHome: string): Promise<{
  child: ChildProcessWithoutNullStreams;
  url: string;
  stderr: () => string;
}> {
  const child = spawn(
    process.execPath,
    [
      '--expose-internals',
      dshWebCli(),
      'web',
      '--patch',
      dshWebPatch(),
      '--host',
      '127.0.0.1',
      '--port',
      '0',
    ],
    {
      cwd: desktopRoot,
      env: { ...process.env, DSH_HOME: dshHome },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const url = await withTimeout(
    new Promise<string>((resolve, reject) => {
      const readReady = (): void => {
        const match = /^dsh web: (http:\/\/127\.0\.0\.1:\d+)\/?\s*$/m.exec(stdout);
        if (match) resolve(`${match[1]}/`);
      };
      child.stdout.on('data', readReady);
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`dsh web exited (code=${code}); ${stderr}`)));
      readReady();
    }),
    30_000,
    'DSH web readiness',
  );
  return { child, url, stderr: () => stderr };
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => {
      setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 2_000).unref?.();
      child.kill();
    }),
  ]);
}

async function callDshWebApi<T>(
  baseUrl: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const rpcId = randomUUID();
  const response = await fetch(new URL(`/api/${method}`, baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  });
  if (!response.ok) throw new Error(`${method} failed with HTTP ${response.status}`);
  const envelope = (await response.json()) as {
    rpcId: string;
    result: { ok: true; value: T } | { ok: false; error: { message: string } };
  };
  if (envelope.rpcId !== rpcId) throw new Error(`${method} returned a mismatched rpcId`);
  if (!envelope.result.ok) throw new Error(`${method} failed: ${envelope.result.error.message}`);
  return envelope.result.value;
}

describe('DSH Harness integration (bundled runtime + fake DeepSeek stream)', () => {
  it(
    'sends the selected Pro model and a text-only user message through the real Harness child process',
    { timeout: 45_000 },
    async () => {
      const requests: Array<{ authorization?: string; body: Record<string, unknown> }> = [];
      const server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));

        if (req.method !== 'POST' || req.url !== '/chat/completions') {
          res.writeHead(404).end();
          return;
        }

        requests.push({
          authorization: req.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        });
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'close',
        });
        res.write(
          `data: ${JSON.stringify({
            id: 'dsh-test-response',
            choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id: 'dsh-test-response',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
      });
      const endpoint = await listen(server);
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cindy-dsh-harness-'));
      const workingDir = path.join(tempRoot, 'workdir');
      const sessionRoot = path.join(tempRoot, 'sessions');
      const dshHome = path.join(tempRoot, 'home');
      const markerPath = path.join(tempRoot, 'user-plugin-loaded.txt');
      const pluginPath = path.join(tempRoot, 'user-marker.mjs');
      const dshSettingsUrl = pathToFileURL(
        path.resolve(
          repoRoot,
          'node_modules',
          '@deepseek-ai',
          'dsh-settings',
          'lib',
          'index.js',
        ),
      ).href;
      const schemasteryUrl = pathToFileURL(
        path.resolve(
          repoRoot,
          'node_modules',
          '@deepseek-ai',
          'schemastery',
          'lib',
          'index.mjs',
        ),
      ).href;
      await Promise.all([mkdir(workingDir), mkdir(sessionRoot), mkdir(dshHome)]);
      await writeFile(
        pluginPath,
        `import { appendFileSync } from 'node:fs';\nimport { settingsNamespace } from ${JSON.stringify(dshSettingsUrl)};\nimport z from ${JSON.stringify(schemasteryUrl)};\nconst schema = z.object({ marker: z.string().default('initial') });\nexport default function apply(ctx, config) {\n  ctx.inject(['settings'], (settingsCtx) => {\n    const scope = settingsCtx.settings.register(settingsNamespace('cindy-integration'), schema);\n    appendFileSync(config.markerPath, 'boot:' + process.pid + ':' + scope.get().marker + '\\n', 'utf8');\n    scope.watch((next) => appendFileSync(config.markerPath, 'update:' + process.pid + ':' + next.marker + '\\n', 'utf8'));\n  });\n}\n`,
        'utf8',
      );
      await writeFile(
        path.join(dshHome, 'cordis.patch.yml'),
        `- insert:\n  - id: user-integration-marker\n    name: ${JSON.stringify(pathToFileURL(pluginPath).href)}\n    config:\n      markerPath: ${JSON.stringify(markerPath)}\n`,
        'utf8',
      );

      const originalBaseUrl = process.env.DEEPSEEK_BASE_URL;
      const originalSnapshot = process.env.DSH_SNAPSHOT;
      const originalHome = process.env.DSH_HOME;
      const originalSystemPrompt = process.env.DSH_SYSTEM_PROMPT;
      let handle: AgentSessionHandle | undefined;
      let web: Awaited<ReturnType<typeof startDshWeb>> | undefined;
      try {
        // The only network target is this loopback server. Keep every DSH file
        // (including its anonymous id) beneath the disposable test directory.
        // The Harness must receive this endpoint from the selected DSH runtime
        // configuration, not from the ambient developer environment.
        delete process.env.DEEPSEEK_BASE_URL;
        process.env.DSH_SNAPSHOT = '1';
        process.env.DSH_HOME = dshHome;
        process.env.DSH_SYSTEM_PROMPT = 'Reply with exactly OK.';

        const agent = new DshAgent({
          binaryPath: dshLauncher(),
          auth: {} as AgentDeps['auth'],
          runtimeConfig: {} as AgentDeps['runtimeConfig'],
          logger,
        });
        handle = await agent.startSession({
          sessionId: 'dsh-harness-pro-text',
          workingDir,
          model: 'deepseek-v4-pro',
          vendorOptions: {
            dshApiKey: 'dsh-harness-test-key',
            dshBaseUrl: endpoint,
            dshModels: [
              {
                id: 'deepseek-v4-pro',
                name: 'Configured Pro',
                contextWindow: 640_000,
              },
            ],
            dshReasoningEffort: 'low',
            dshSessionRoot: sessionRoot,
            dshBashLocal: false,
          },
        });

        await waitFor(
          async () => (await readFile(markerPath, 'utf8').catch(() => '')).includes('boot:'),
          10_000,
          'conversation user plugin boot',
        );
        web = await startDshWeb(dshHome);
        const described = await callDshWebApi<{
          writable: boolean;
          hasDocument: boolean;
          namespaces: Array<{
            ns: string;
            value: unknown;
            revision: number;
          }>;
        }>(web.url, 'settings.describe', {});
        const integrationSettings = described.namespaces.find(
          (entry) => entry.ns === 'cindy-integration',
        );
        expect(described).toMatchObject({ writable: true, hasDocument: true });
        expect(integrationSettings).toMatchObject({
          ns: 'cindy-integration',
          value: { marker: 'initial' },
        });
        const inventory = await callDshWebApi<{
          entries: Array<{
            entryId: string;
            enabled: boolean;
            fiberPhase: string;
          }>;
        }>(web.url, 'pluginInventory/list', { args: {} });
        expect(inventory.entries).toContainEqual(
          expect.objectContaining({
            entryId: 'include:user-integration-marker',
            enabled: true,
            fiberPhase: 'active',
          }),
        );
        expect(inventory.entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              entryId: 'include:cindy-directory-picker-browse-host',
              enabled: true,
              fiberPhase: 'active',
            }),
            expect.objectContaining({
              entryId: 'include:cindy-directory-picker-browse-client',
              enabled: true,
              fiberPhase: 'active',
            }),
          ]),
        );
        const directoryListing = await callDshWebApi<{
          path: string;
          entries: Array<{ name: string; path: string }>;
        }>(web.url, 'host.listDirectory', { path: workingDir });
        expect(directoryListing.path).toBe(workingDir);
        expect(Array.isArray(directoryListing.entries)).toBe(true);

        await callDshWebApi(web.url, 'settings.mutate', {
          ns: 'cindy-integration',
          ops: [{ op: 'set', path: ['marker'], value: 'written-through-web' }],
          expectedRevision: integrationSettings!.revision,
        });
        await waitFor(
          async () => {
            const lines = (await readFile(markerPath, 'utf8').catch(() => '')).trim().split('\n');
            const updatedPids = new Set(
              lines
                .filter((line) => line.endsWith(':written-through-web'))
                .map((line) => line.split(':')[1]),
            );
            return updatedPids.size >= 2;
          },
          10_000,
          'shared settings hot update in conversation and web processes',
        );
        expect(await readFile(path.join(dshHome, 'settings.yaml'), 'utf8')).toContain(
          'written-through-web',
        );

        const events: AgentEvent[] = [];
        const collectUntilDone = (async () => {
          for await (const event of handle!.events()) {
            events.push(event);
            if (event.type === 'error') {
              throw new Error(
                (event.data as { message?: string }).message ?? 'DSH Harness reported an error',
              );
            }
            if (event.type === 'done') return;
          }
          throw new Error('DSH event stream ended before the turn completed');
        })();

        await handle.send({
          type: 'user',
          content: [{ type: 'text', text: 'Return the word OK.' }],
        });
        await withTimeout(collectUntilDone, 30_000, 'DSH text response');

        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'text',
            source: 'dsh',
            data: expect.objectContaining({ text: 'OK' }),
          }),
        );
        expect(events.some((event) => event.type === 'done')).toBe(true);

        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ authorization: 'Bearer dsh-harness-test-key' });
        expect(requests[0].body).toMatchObject({
          model: 'deepseek-v4-pro',
          stream: true,
          thinking: { type: 'enabled' },
          reasoning_effort: 'low',
        });
        const messages = requests[0].body.messages as Array<{ role?: string; content?: unknown }>;
        expect(messages).toContainEqual({ role: 'user', content: 'Return the word OK.' });
        expect(messages.every((message) => typeof message.content === 'string')).toBe(true);
        const markerLines = (await readFile(markerPath, 'utf8')).trim().split('\n');
        expect(
          new Set(
            markerLines
              .filter((line) => line.startsWith('boot:'))
              .map((line) => line.split(':')[1]),
          ).size,
        ).toBeGreaterThanOrEqual(2);
      } finally {
        if (web) await stopChild(web.child);
        await handle?.close();
        restoreEnv('DEEPSEEK_BASE_URL', originalBaseUrl);
        restoreEnv('DSH_SNAPSHOT', originalSnapshot);
        restoreEnv('DSH_HOME', originalHome);
        restoreEnv('DSH_SYSTEM_PROMPT', originalSystemPrompt);
        await close(server);
        await rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    },
  );

  it(
    'routes the Cindy plugin channel through the DSH MCP client (env-derived bearer token, tool surface, call round trip)',
    { timeout: 60_000 },
    async () => {
      // Fake streamable-http MCP server:仅实现 initialize / tools/list /
      // tools/call,记录收到的 Authorization 头与工具调用名。
      const mcpSeenAuth: string[] = [];
      const mcpToolCalls: string[] = [];
      const mcpServer = createServer(async (req, res) => {
        const auth = req.headers['authorization'];
        if (typeof auth === 'string') mcpSeenAuth.push(auth);
        if (req.method === 'GET') {
          // SDK 客户端对 405 会退回 POST-only 流,不需要真 SSE。
          res.writeHead(405).end();
          return;
        }
        if (req.method === 'DELETE') {
          res.writeHead(200).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        let body: { method?: string; id?: unknown; params?: Record<string, unknown> } = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as typeof body;
        } catch {
          /* invalid body handled below */
        }
        const sendJson = (payload: unknown, headers: Record<string, string> = {}): void => {
          res.writeHead(200, { 'content-type': 'application/json', ...headers });
          res.end(JSON.stringify(payload));
        };
        if (body.method === 'initialize') {
          sendJson(
            {
              jsonrpc: '2.0',
              id: body.id,
              result: {
                protocolVersion: (body.params?.protocolVersion as string) ?? '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'cindy', version: '1.0.0' },
              },
            },
            { 'mcp-session-id': randomUUID() },
          );
          return;
        }
        if (body.method === 'notifications/initialized') {
          res.writeHead(202).end();
          return;
        }
        if (body.method === 'tools/list') {
          sendJson({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              tools: [
                {
                  name: 'ghost_list',
                  description: 'List installed Cindy plugins.',
                  inputSchema: { type: 'object', properties: {} },
                },
              ],
            },
          });
          return;
        }
        if (body.method === 'tools/call') {
          mcpToolCalls.push(String(body.params?.name ?? ''));
          sendJson({
            jsonrpc: '2.0',
            id: body.id,
            result: { content: [{ type: 'text', text: '[]' }], isError: false },
          });
          return;
        }
        res.writeHead(400).end();
      });
      const mcpEndpoint = await listen(mcpServer);
      const mcpToken = `${randomUUID()}-mcp-token`;

      // Fake DeepSeek 流:第一轮返回 ghost_list 工具调用,第二轮返回最终文本。
      const llmRequests: Array<{ body: Record<string, unknown> }> = [];
      const server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        if (req.method !== 'POST' || req.url !== '/chat/completions') {
          res.writeHead(404).end();
          return;
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        llmRequests.push({ body });
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'close',
        });
        if (llmRequests.length === 1) {
          res.write(
            `data: ${JSON.stringify({
              id: 'dsh-mcp-test',
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call-mcp-1',
                        type: 'function',
                        function: { name: 'mcp__cindy__ghost_list', arguments: '{}' },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({
              id: 'dsh-mcp-test',
              choices: [{ index: 0, delta: {}, finish_reason: null }],
            })}\n\n`,
          );
        } else {
          res.write(
            `data: ${JSON.stringify({
              id: 'dsh-mcp-test',
              choices: [{ index: 0, delta: { content: 'TOOL-OK' }, finish_reason: null }],
            })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({
              id: 'dsh-mcp-test',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            })}\n\n`,
          );
        }
        res.end('data: [DONE]\n\n');
      });
      const endpoint = await listen(server);
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cindy-dsh-mcp-'));
      const workingDir = path.join(tempRoot, 'workdir');
      const sessionRoot = path.join(tempRoot, 'sessions');
      const dshHome = path.join(tempRoot, 'home');
      await Promise.all([mkdir(workingDir), mkdir(sessionRoot), mkdir(dshHome)]);

      const originalBaseUrl = process.env.DEEPSEEK_BASE_URL;
      const originalSnapshot = process.env.DSH_SNAPSHOT;
      const originalHome = process.env.DSH_HOME;
      const originalToken = process.env.CINDY_DSH_MCP_TOKEN;
      let handle: AgentSessionHandle | undefined;
      try {
        delete process.env.DEEPSEEK_BASE_URL;
        process.env.DSH_SNAPSHOT = '1';
        process.env.DSH_HOME = dshHome;
        delete process.env.CINDY_DSH_MCP_TOKEN;

        const agent = new DshAgent({
          binaryPath: dshLauncher(),
          auth: {} as AgentDeps['auth'],
          runtimeConfig: {} as AgentDeps['runtimeConfig'],
          logger,
        });
        handle = await agent.startSession({
          sessionId: 'dsh-mcp-channel',
          workingDir,
          model: 'deepseek-v4-pro',
          // Full Access 预设:测试只验证 MCP 通道管线,不让 DSH 审批栈介入工具执行。
          permissionMode: 'bypassPermissions',
          vendorOptions: {
            dshApiKey: 'dsh-mcp-test-key',
            dshBaseUrl: endpoint,
            dshModels: [
              {
                id: 'deepseek-v4-pro',
                name: 'Configured Pro',
                contextWindow: 640_000,
              },
            ],
            dshReasoningEffort: 'low',
            dshSessionRoot: sessionRoot,
            dshBashLocal: false,
            dshCindyMcpUrl: mcpEndpoint,
            dshCindyMcpToken: mcpToken,
          },
        });

        const events: AgentEvent[] = [];
        const collectUntilDone = (async () => {
          for await (const event of handle!.events()) {
            events.push(event);
            if (event.type === 'error') {
              throw new Error(
                (event.data as { message?: string }).message ?? 'DSH Harness reported an error',
              );
            }
            if (event.type === 'done') return;
          }
          throw new Error('DSH event stream ended before the turn completed');
        })();

        await handle.send({
          type: 'user',
          content: [{ type: 'text', text: 'List the plugins.' }],
        });
        await withTimeout(collectUntilDone, 45_000, 'DSH MCP tool-call turn');

        // 最终文本到达 = 工具调用完成并带着结果回了第二轮模型请求。
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'text',
            source: 'dsh',
            data: expect.objectContaining({ text: 'TOOL-OK' }),
          }),
        );
        expect(events.some((event) => event.type === 'done')).toBe(true);

        // 工具面:第一轮请求的 tools 数组必须包含 mcp__cindy__ghost_list
        // (mcp-client 注册进 DSH 工具面的证据)。
        expect(llmRequests.length).toBe(2);
        const tools = llmRequests[0].body.tools as Array<{
          type?: string;
          function?: { name?: string };
        }>;
        expect(tools).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'function',
              function: expect.objectContaining({ name: 'mcp__cindy__ghost_list' }),
            }),
          ]),
        );

        // 管线证据:fake MCP server 收到 tools/list + tools/call,且 bearer token
        // 精确等于 env 注入的 per-session token(!!js env 求值链路成立)。
        expect(mcpToolCalls).toEqual(['ghost_list']);
        expect(mcpSeenAuth.length).toBeGreaterThan(0);
        expect(mcpSeenAuth.every((auth) => auth === `Bearer ${mcpToken}`)).toBe(true);

        // 第二轮请求带着工具结果(role=“tool”)回来。
        const secondMessages = llmRequests[1].body.messages as Array<{
          role?: string;
          tool_call_id?: string;
        }>;
        expect(secondMessages).toContainEqual({
          role: 'tool',
          tool_call_id: 'call-mcp-1',
          content: '[]',
        });
      } finally {
        await handle?.close();
        restoreEnv('DEEPSEEK_BASE_URL', originalBaseUrl);
        restoreEnv('DSH_SNAPSHOT', originalSnapshot);
        restoreEnv('DSH_HOME', originalHome);
        restoreEnv('CINDY_DSH_MCP_TOKEN', originalToken);
        await close(mcpServer);
        await close(server);
        await rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    },
  );
});
