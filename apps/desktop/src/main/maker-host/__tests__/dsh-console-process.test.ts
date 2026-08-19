import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  DshConsoleProcess,
  type DshConsoleChild,
  type DshConsoleProcessDeps,
} from '../dsh-console-process.js';

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 1234;
  readonly kill = vi.fn(() => {
    queueMicrotask(() => this.emit('exit', 0));
    return true;
  });
}

function createHarness(overrides: Partial<DshConsoleProcessDeps> = {}) {
  const children: FakeChild[] = [];
  const spawn = vi.fn((_workerPath: string, _cliPath: string, _options: Electron.ForkOptions) => {
    const child = new FakeChild();
    children.push(child);
    return child as unknown as DshConsoleChild;
  });
  const controller = new DshConsoleProcess({
    cliPath: 'C:\\dsh\\lib\\bin.js',
    workerPath: 'C:\\app\\dshConsoleWorkerProcess.js',
    cwd: 'C:\\Users\\test',
    env: {
      PATH: 'C:\\Windows',
      DSH_HOME: 'C:\\Users\\test\\.dsh',
      DEEPSEEK_API_KEY: 'must-not-leak',
    },
    logger: { info: vi.fn(), warn: vi.fn() },
    spawn,
    readyTimeoutMs: 100,
    shutdownTimeoutMs: 20,
    ...overrides,
  });
  return { children, controller, spawn };
}

describe('DshConsoleProcess', () => {
  it('starts lazily, shares concurrent startup, and reuses the ready process', async () => {
    const { children, controller, spawn } = createHarness();
    expect(spawn).not.toHaveBeenCalled();

    const first = controller.ensureStarted();
    const second = controller.ensureStarted();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[2].execArgv).toEqual(['--expose-internals']);
    expect(spawn.mock.calls[0]?.[2].env).toEqual({
      PATH: 'C:\\Windows',
      DSH_HOME: 'C:\\Users\\test\\.dsh',
    });

    children[0]!.stdout.write('dsh web: http://127.0.0.1:54321\n');
    await expect(Promise.all([first, second])).resolves.toEqual([
      'http://127.0.0.1:54321/',
      'http://127.0.0.1:54321/',
    ]);
    await expect(controller.ensureStarted()).resolves.toBe('http://127.0.0.1:54321/');
    expect(spawn).toHaveBeenCalledTimes(1);

    await controller.dispose();
    expect(children[0]!.kill).toHaveBeenCalledTimes(1);
  });

  it('ignores non-loopback or invalid readiness and times out', async () => {
    const { children, controller } = createHarness({ readyTimeoutMs: 20 });
    const startup = controller.ensureStarted();
    children[0]!.stdout.write('dsh web: http://0.0.0.0:1234\n');
    children[0]!.stdout.write('dsh web: http://127.0.0.1:70000\n');
    await expect(startup).rejects.toThrow('did not become ready');
    expect(children[0]!.kill).toHaveBeenCalledTimes(1);
  });

  it('clears a crashed process so the next click can retry', async () => {
    const { children, controller, spawn } = createHarness();
    const first = controller.ensureStarted();
    children[0]!.emit('exit', 1);
    await expect(first).rejects.toThrow('exited');

    const retry = controller.ensureStarted();
    expect(spawn).toHaveBeenCalledTimes(2);
    children[1]!.stdout.write('dsh web: http://127.0.0.1:43210\n');
    await expect(retry).resolves.toBe('http://127.0.0.1:43210/');
    await controller.dispose();
  });
});
