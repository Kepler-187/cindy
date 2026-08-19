// forge-native-abi-check.ts 的单元测试：核心是「用打包同一套 Electron 的加载器
// dlopen 验证 .node 的 ABI」这一 fail-closed 判定。spawnSync 被 mock，用例覆盖：
// 通过（LOAD_OK）、ABI 不匹配（错误文本里带 NODE_MODULE_VERSION 实际/期望两个
// 数字）、无法解析的加载失败、Electron 无法启动（spawn error）、文件缺失。

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assertNativeModuleAbi } from '../../../forge-native-abi-check';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

const mockedSpawnSync = vi.mocked(spawnSync);

const FAKE_ELECTRON = 'C:/fake/electron.exe';

function mismatchOutput(actual: number, expected: number): string {
  return (
    `The module 'C:\\fake\\better_sqlite3.node'\n` +
    `was compiled against a different Node.js version using\n` +
    `NODE_MODULE_VERSION ${actual}. This version of Node.js requires\n` +
    `NODE_MODULE_VERSION ${expected}. Please try re-compiling or re-installing\n` +
    `the module.`
  );
}

function spawnResult(overrides: Partial<ReturnType<typeof spawnSync>> = {}) {
  return {
    pid: 0,
    output: [],
    stdout: null,
    stderr: null,
    status: 0,
    signal: null,
    error: undefined,
    ...overrides,
  } as unknown as ReturnType<typeof spawnSync>;
}

describe('assertNativeModuleAbi', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abi-check-test-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makeFile(name: string): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, 'dummy .node bytes');
    return p;
  }

  it('passes when the .node loads under Electron (LOAD_OK)', () => {
    const file = makeFile('ok.node');
    mockedSpawnSync.mockReturnValue(spawnResult({ status: 0, stdout: 'LOAD_OK ABI=145\n' }));

    expect(() => assertNativeModuleAbi(file, 'better-sqlite3', FAKE_ELECTRON)).not.toThrow();
    expect(mockedSpawnSync).toHaveBeenCalledWith(
      FAKE_ELECTRON,
      ['-e', expect.stringContaining('process.dlopen'), file],
      expect.objectContaining({
        env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
        windowsHide: true,
      }),
    );
  });

  it('normalizes forward-slash paths to platform separators before dlopen (win32 error 126)', () => {
    // Windows 上 uv_dlopen 对带依赖 DLL 的 addon 用 `/` 路径会报 126「The specified
    // module could not be found」（winpty.dll 依赖搜索失效）——必须归一化反斜杠。
    const file = makeFile('fwd-slash.node').replace(/\\/g, '/');
    mockedSpawnSync.mockReturnValue(spawnResult({ status: 0, stdout: 'LOAD_OK ABI=145\n' }));

    expect(() => assertNativeModuleAbi(file, 'node-pty', FAKE_ELECTRON)).not.toThrow();
    const args = mockedSpawnSync.mock.calls[0][1];
    if (process.platform === 'win32') {
      expect(args?.[2]).not.toContain('/');
    }
  });

  it('throws with both ABIs parsed when the module is built for another Node version', () => {
    const file = makeFile('bad-137.node');
    mockedSpawnSync.mockReturnValue(spawnResult({ status: 1, stderr: mismatchOutput(137, 145) }));

    expect(() => assertNativeModuleAbi(file, 'better-sqlite3', FAKE_ELECTRON)).toThrowError(
      /ABI check FAILED: better-sqlite3 is NODE_MODULE_VERSION 137.*requires NODE_MODULE_VERSION 145/s,
    );
  });

  it('throws a generic load failure when output carries no parseable ABI numbers', () => {
    const file = makeFile('weird.node');
    mockedSpawnSync.mockReturnValue(spawnResult({ status: 1, stderr: 'ERROR: bad EXE format' }));

    expect(() => assertNativeModuleAbi(file, 'node-pty', FAKE_ELECTRON)).toThrowError(
      /ABI check FAILED: node-pty could not be loaded by Electron \(exit code 1\)/,
    );
  });

  it('throws the spawn error when Electron itself cannot start', () => {
    const file = makeFile('spawn-error.node');
    mockedSpawnSync.mockReturnValue(
      spawnResult({ status: null, error: new Error('ENOENT: no such executable') }),
    );

    expect(() => assertNativeModuleAbi(file, 'better-sqlite3', FAKE_ELECTRON)).toThrowError(
      /spawn error: ENOENT/,
    );
  });

  it('throws when the .node file is missing, without spawning Electron', () => {
    mockedSpawnSync.mockClear();
    expect(() =>
      assertNativeModuleAbi(path.join(tmpDir, 'absent.node'), 'better-sqlite3', FAKE_ELECTRON),
    ).toThrowError(/better-sqlite3 missing at/);
    expect(mockedSpawnSync).not.toHaveBeenCalled();
  });
});
