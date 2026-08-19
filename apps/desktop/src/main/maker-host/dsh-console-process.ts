import { createRequire } from 'node:module';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';
import { utilityProcess } from 'electron';

const HOST_ENV_KEYS = [
  'PATH',
  'SystemRoot',
  'WINDIR',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'SHELL',
  'COMSPEC',
  'PATHEXT',
  'DSH_HOME',
] as const;

const READY_LINE = /^dsh web: (http:\/\/127\.0\.0\.1:(\d+))\/?\s*$/;
const MAX_LINE_BUFFER_CHARS = 256 * 1024;
const runtimeRequire = createRequire(import.meta.url);

export interface DshConsoleChild {
  readonly stdout?: NodeJS.ReadableStream | null;
  readonly stderr?: NodeJS.ReadableStream | null;
  readonly pid?: number;
  kill(): boolean;
  on(event: 'error', listener: (error: unknown) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  once(event: 'exit', listener: (code: number) => void): this;
  removeListener(event: 'exit', listener: (code: number) => void): this;
}

export interface DshConsoleProcessDeps {
  cliPath: string;
  workerPath: string;
  cwd: string;
  env: Record<string, string | undefined>;
  logger: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
  spawn?: (workerPath: string, cliPath: string, options: Electron.ForkOptions) => DshConsoleChild;
  readyTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

function consoleEnvironment(source: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of HOST_ENV_KEYS) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

function attachLineReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): () => void {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  const onData = (chunk: Buffer | string): void => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    if (buffer.length > MAX_LINE_BUFFER_CHARS) buffer = '';
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      onLine(line);
    }
  };
  const onEnd = (): void => {
    buffer += decoder.end();
    if (buffer) onLine(buffer.replace(/\r$/, ''));
    buffer = '';
  };
  stream.on('data', onData);
  stream.on('end', onEnd);
  return () => {
    stream.removeListener('data', onData);
    stream.removeListener('end', onEnd);
  };
}

function defaultSpawn(
  workerPath: string,
  cliPath: string,
  options: Electron.ForkOptions,
): DshConsoleChild {
  return utilityProcess.fork(workerPath, [cliPath], options) as DshConsoleChild;
}

export class DshConsoleProcess {
  private child: DshConsoleChild | null = null;
  private readyUrl: string | null = null;
  private startupPromise: Promise<string> | null = null;
  private disposed = false;

  constructor(private readonly deps: DshConsoleProcessDeps) {}

  ensureStarted(): Promise<string> {
    if (this.disposed) return Promise.reject(new Error('DSH console process is disposed'));
    if (this.readyUrl && this.child) return Promise.resolve(this.readyUrl);
    if (this.startupPromise) return this.startupPromise;

    const startup = this.start();
    const tracked = startup.finally(() => {
      if (this.startupPromise === tracked) this.startupPromise = null;
    });
    this.startupPromise = tracked;
    return tracked;
  }

  private start(): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = (this.deps.spawn ?? defaultSpawn)(this.deps.workerPath, this.deps.cliPath, {
        cwd: this.deps.cwd,
        env: consoleEnvironment(this.deps.env),
        execArgv: ['--expose-internals'],
        stdio: ['ignore', 'pipe', 'pipe'],
        serviceName: 'cindy-dsh-console',
        ...(process.platform === 'darwin' ? { disclaim: true } : {}),
      });
      this.child = child;

      const stdout = child.stdout;
      const stderr = child.stderr;
      if (!stdout || !stderr) {
        this.child = null;
        child.kill();
        reject(new Error('DSH console utility process has no stdout/stderr'));
        return;
      }

      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (error?: Error, url?: string): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (error) reject(error);
        else resolve(url!);
      };

      // Keep both readers attached after readiness. Besides preserving post-start
      // diagnostics, Electron's piped utility-process streams must stay drained
      // for the lifetime of the HTTP server.
      attachLineReader(stdout, (line) => {
        const match = READY_LINE.exec(line.trim());
        if (!match || settled) return;
        const port = Number(match[2]);
        if (!Number.isInteger(port) || port < 1 || port > 65_535) return;
        const url = `http://127.0.0.1:${port}/`;
        this.readyUrl = url;
        this.deps.logger.info('DSH console ready', { port });
        finish(undefined, url);
      });
      attachLineReader(stderr, (line) => {
        if (!line.trim()) return;
        this.deps.logger.warn('DSH console stderr', {
          line: redactSensitiveText(line).slice(0, 2_000),
        });
      });

      const onFailure = (reason: string): void => {
        if (this.child === child) {
          this.child = null;
          this.readyUrl = null;
        }
        finish(new Error(reason));
      };
      child.on('error', (error) =>
        onFailure(`DSH console process error: ${redactSensitiveText(String(error))}`),
      );
      child.on('exit', (code) => onFailure(`DSH console process exited (code=${code})`));

      timer = setTimeout(() => {
        if (this.child === child) {
          this.child = null;
          this.readyUrl = null;
        }
        try {
          child.kill();
        } catch {
          // The utility process may already have exited.
        }
        finish(new Error('DSH console did not become ready'));
      }, this.deps.readyTimeoutMs ?? 30_000);
      timer.unref?.();
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed && !this.child) return;
    this.disposed = true;
    const child = this.child;
    this.child = null;
    this.readyUrl = null;
    if (!child) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener('exit', onExit);
        resolve();
      };
      const onExit = (): void => finish();
      child.once('exit', onExit);
      const timer = setTimeout(() => {
        if (child.pid !== undefined) {
          try {
            process.kill(child.pid, 'SIGKILL');
          } catch {
            // The utility process may already have exited.
          }
        }
        finish();
      }, this.deps.shutdownTimeoutMs ?? 1_000);
      timer.unref?.();
      try {
        if (!child.kill()) finish();
      } catch {
        finish();
      }
    });
  }
}

export function resolveDshConsoleCliPath(): string {
  const packageJson = runtimeRequire.resolve('@deepseek-ai/dsh/package.json');
  return path.join(path.dirname(packageJson), 'lib', 'bin.js');
}
