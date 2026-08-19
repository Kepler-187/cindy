/**
 * dshCindyMcpHost — DSH 会话专属的 Cindy ghost MCP streamable-http loopback 端点。
 *
 * 为什么不用 codexHttpBridge：DSH 的 MCP client（@deepseek-ai/dsh-mcp-client）
 * 由 Cindy overlay 的 `mcp-cindy` 行激活，工具面经 loopback URL + per-session
 * bearer token 进入 DSH 进程；codex 桥的 thread/query 路由机制与 DSH 无关。
 * 这里只保留同一威胁模型的安全子集：loopback-only、随机端口、per-session
 * token、未知 token 一律 401（与 codexHttpBridge / remoteMcpBridgeToken 同款）。
 *
 * token 不落盘：DshAgent.startSession 把 token 放进 CINDY_DSH_MCP_TOKEN env，
 * overlay 的 headers.Authorization 是 `!!js` 表达式，cordis 装载时读 env 求值；
 * token 明文不出现在 cordis.yml。
 *
 * 生命周期：
 *   - 会话启动（maker-host lifecycleHooks.prepareStartOptions 的 dsh 分支）注册；
 *   - 会话关闭（lifecycleHooks.onClose）注销，带 expectedToken 代际守卫——
 *     同 sessionId 重建后旧 close 迟到不会误删新注册；
 *   - 最后一个会话注销后关闭 HTTP server；
 *   - SSH 远端会话绝不注册（fail-closed，docs/dsh-cindy-plugin-channel.md §4.5）。
 * 残留本身有界（per-session 随机 token 随 Main 重启全部失效），但正常路径
 * 不依赖重启兜底。
 */

import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { runWithLiziMcpSessionContext, type LiziMcpSessionContext } from '@cindy/mcps';

import {
  getCindyGhostsMcpDeps,
  type CindyGhostsHostDeps,
} from './ghost.js';
import { createCindyGhostsMcpServer } from 'cindy-tools';
import { createLogger } from '../logger.js';

const log = createLogger('mcp/dsh-cindy');

const MCP_PATH = '/mcp';
const SERVER_HEADER = 'Cindy_DSH_MCP/1.0';
const INIT_BODY_MAX_BYTES = 1 * 1024 * 1024;

export interface DshCindyMcpRegistration {
  url: string;
  token: string;
}

export interface DshCindyMcpHostDeps {
  /** ghost server 的 host 注入依赖（与 mcp-providers 的 cindy provider 同源）。 */
  hostDeps?: CindyGhostsHostDeps;
  /**
   * 现读活跃 Maker Session 的 instance 代号。tool-call 时解析并放进 ALS 语境，
   * 供 getLiveSessionGrantState / 视觉桥按「sessionId + instanceId」校验
   * （与 getLiveSessionGrantState 同口径）。会话尚未创建或已拆离 → undefined，
   * 权限读取方自行 fail closed。
   */
  getLiveSessionInstanceId?: (sessionId: string) => string | undefined;
  /** 测试注入：替换 ghost server 工厂（生产实现为 createCindyGhostsMcpServer）。 */
  createServer?: (session: { sessionId: string; workingDir: string }) => McpServer;
}

export interface DshCindyMcpHost {
  registerSession(sessionId: string, workingDir: string): Promise<DshCindyMcpRegistration>;
  /** 幂等注销。expectedToken 命中才删除（代际守卫）；未命中 = 旧 close 迟到，跳过。 */
  unregisterSession(sessionId: string, expectedToken?: string): void;
  /** 关闭全部 mcp transport 与 HTTP server（应用退出兜底）。 */
  shutdown(): Promise<void>;
  url(): string | null;
}

interface DshCindyMcpSession {
  generation: number;
  sessionId: string;
  workingDir: string;
  token: string;
  mcpTransports: Map<string, { transport: StreamableHTTPServerTransport }>;
}

function isLocalhost(remote: string): boolean {
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

function prefixId(value: string | undefined): string | null {
  if (!value) return null;
  return value.length <= 8 ? value : `${value.slice(0, 8)}…`;
}

async function readJsonBody(
  req: http.IncomingMessage,
  maxBytes = Number.POSITIVE_INFINITY,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    received += buf.length;
    if (received > maxBytes) {
      req.destroy();
      throw new Error('BODY_TOO_LARGE');
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return undefined;
  return JSON.parse(text);
}

export function createDshCindyMcpHost(deps: DshCindyMcpHostDeps = {}): DshCindyMcpHost {
  const sessions = new Map<string, DshCindyMcpSession>();
  let httpServer: http.Server | null = null;
  let baseUrl: string | null = null;
  let nextGeneration = 0;

  const defaultCreateServer = (session: DshCindyMcpSession): McpServer =>
    createCindyGhostsMcpServer(
      getCindyGhostsMcpDeps(
        {
          agentKind: 'dsh',
          sessionId: session.sessionId,
          workingDir: session.workingDir,
        },
        deps.hostDeps,
      ),
    );
  const createServer = (session: DshCindyMcpSession): McpServer =>
    deps.createServer?.(session) ?? defaultCreateServer(session);

  // ALS 语境按请求现算:sessionInstanceId 由 host 回调现读活跃 Session,
  // 覆盖 Full Access 自动交接 / 视觉桥的 instance identity 校验。
  const liveCtx = (session: DshCindyMcpSession): LiziMcpSessionContext => {
    const sessionInstanceId = deps.getLiveSessionInstanceId?.(session.sessionId);
    return {
      agentKind: 'dsh',
      sessionId: session.sessionId,
      workingDir: session.workingDir,
      ...(sessionInstanceId ? { sessionInstanceId } : {}),
    };
  };

  const handleRequest = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> => {
    res.setHeader('Server', SERVER_HEADER);
    try {
      // 防御：bind 已经在 127.0.0.1，理论上不会有外网请求；保留检查作为
      // depth-in-defense（req.socket.remoteAddress 偶尔是 ::ffff:127.0.0.1）。
      const remote = req.socket.remoteAddress ?? '';
      if (!isLocalhost(remote)) {
        res.statusCode = 403;
        res.end();
        log.warn('rejected non-localhost request', { remote, url: req.url });
        return;
      }
      if (req.url !== MCP_PATH) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const auth = req.headers['authorization'];
      const presented =
        typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null;
      let session: DshCindyMcpSession | undefined;
      if (presented) {
        for (const candidate of sessions.values()) {
          if (candidate.token === presented) {
            session = candidate;
            break;
          }
        }
      }
      if (!session) {
        res.statusCode = 401;
        res.setHeader('WWW-Authenticate', 'Bearer');
        res.end();
        log.warn('rejected unauthenticated request', { url: req.url });
        return;
      }

      const sessionIdHeader = req.headers['mcp-session-id'];
      const mcpSessionId = typeof sessionIdHeader === 'string' ? sessionIdHeader : undefined;
      if (mcpSessionId) {
        const existing = session.mcpTransports.get(mcpSessionId);
        if (!existing) {
          res.statusCode = 404;
          res.end('Unknown session');
          return;
        }
        const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
        await runWithLiziMcpSessionContext(liveCtx(session), () =>
          existing.transport.handleRequest(req, res, body),
        );
        return;
      }

      // 无 mcp-session-id：必须是 initialize 请求（streamable-http 有状态模式）。
      if (req.method !== 'POST') {
        res.statusCode = 400;
        res.end('Missing mcp-session-id');
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req, INIT_BODY_MAX_BYTES);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn('init body read failed', { message });
        if (message === 'BODY_TOO_LARGE') {
          res.statusCode = 413;
          res.end('Init body too large');
        } else {
          res.statusCode = 400;
          res.end('Invalid init body');
        }
        return;
      }
      if (!isInitializeRequest(body)) {
        res.statusCode = 400;
        res.end('Expected initialize request');
        return;
      }

      // 新 mcp session：transport 与 server 1:1 绑定（McpServer 实例不允许
      // 重复 connect）。roster 快照在 server 装配时经闭包 ctx 取一次,与三
      // harness 相同的「会话装配时求值、会话内恒定」语义。
      const mcpServer = createServer(session);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newId) => {
          session.mcpTransports.set(newId, { transport });
          log.debug('dsh cindy MCP session initialized', {
            sessionId: prefixId(session.sessionId),
            mcpSessionId: prefixId(newId),
          });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) session.mcpTransports.delete(transport.sessionId);
      };
      try {
        await mcpServer.connect(transport);
        await runWithLiziMcpSessionContext(liveCtx(session), () =>
          transport.handleRequest(req, res, body),
        );
      } catch (error) {
        try {
          await transport.close();
        } catch {
          /* ignore cleanup failure; original error is more useful */
        }
        throw error;
      }
    } catch (error) {
      log.error('dsh cindy MCP request handler threw', {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        url: req.url,
      });
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    }
  };

  const ensureServer = async (): Promise<string> => {
    if (httpServer && baseUrl) return baseUrl;
    const server = http.createServer(handleRequest);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    httpServer = server;
    baseUrl = `http://127.0.0.1:${address.port}${MCP_PATH}`;
    return baseUrl;
  };

  const closeServer = async (): Promise<void> => {
    const server = httpServer;
    httpServer = null;
    baseUrl = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // 已建立 keep-alive 连接不会被 close 立即回收,补一把兜底。
      setTimeout(resolve, 2_000).unref?.();
    });
  };

  return {
    async registerSession(sessionId, workingDir) {
      const token = randomBytes(32).toString('hex');
      nextGeneration += 1;
      sessions.set(sessionId, {
        generation: nextGeneration,
        sessionId,
        workingDir,
        token,
        mcpTransports: new Map(),
      });
      const url = await ensureServer();
      log.info('dsh cindy MCP session registered', {
        sessionId: prefixId(sessionId),
        workingDir,
      });
      return { url, token };
    },
    unregisterSession(sessionId, expectedToken) {
      const existing = sessions.get(sessionId);
      if (!existing) return;
      if (expectedToken !== undefined && existing.token !== expectedToken) {
        // 同 sessionId 已重建并换发新 token,旧 close 迟到——不动新注册。
        log.info('dsh cindy MCP unregister skipped (token generation mismatch)', {
          sessionId: prefixId(sessionId),
        });
        return;
      }
      sessions.delete(sessionId);
      for (const { transport } of existing.mcpTransports.values()) {
        void transport.close().catch(() => undefined);
      }
      existing.mcpTransports.clear();
      if (sessions.size === 0) void closeServer();
    },
    async shutdown() {
      for (const session of sessions.values()) {
        for (const { transport } of session.mcpTransports.values()) {
          await transport.close().catch(() => undefined);
        }
        session.mcpTransports.clear();
      }
      sessions.clear();
      await closeServer();
    },
    url() {
      return baseUrl;
    },
  };
}
