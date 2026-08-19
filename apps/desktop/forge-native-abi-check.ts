// forge-native-abi-check.ts — 原生模块 ABI 硬校验（fail closed）。
//
// 「打包流程统一」(2026-08-20) 的最后防线：root node_modules 里的 better-sqlite3
// 是 Node ABI 产物（pnpm install 默认，Node 24 = 137），bundleNativeDeps 先把它拷进
// packaged，再靠 @electron/rebuild 覆盖成 Electron ABI（Electron 41 = 145）。历史上
// 出现过「rebuild 日志打印成功、包内却仍是 137」的坏包，装完启动即
// DB INIT FAILED（NODE_MODULE_VERSION 137 vs 145）——好包/坏包全凭 packaged 目录里
// 碰巧是哪一份 .node。
//
// 判定不用系统 Node 去 require 猜（结果取决于打包机 Node 版本，只能区分
// 「等于 / 不等于」），而是用打包同一套 Electron 自己的加载器来验：
// ELECTRON_RUN_AS_NODE=1 下 electron 以纯 Node 运行，process.dlopen 目标 .node——
// 加载成功即 ABI 与 Electron 一致；失败时错误文本自带
// 「NODE_MODULE_VERSION <实际> … requires NODE_MODULE_VERSION <期望>」两个数字，
// 可解析出精确 ABI。better-sqlite3 / node-pty 都不是 N-API 模块（前者按 ABI 发
// prebuild，后者用 NAN），所以「Electron 能加载」等价于「ABI 正确」。

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

const _require = createRequire(__filename);

// Node 加载器 ABI 不匹配错误：
//   The module '…' was compiled against a different Node.js version using
//   NODE_MODULE_VERSION 137. This version of Node.js requires
//   NODE_MODULE_VERSION 145. …
const NODE_MODULE_VERSION_MISMATCH_RE =
  /NODE_MODULE_VERSION\s+(\d+)(?:\s*\.\s*This version of Node\.js requires\s+NODE_MODULE_VERSION\s+(\d+))?/;

const PROBE_SCRIPT = [
  'const m = { exports: {} };',
  'try {',
  '  process.dlopen(m, process.argv[1]);',
  "  console.log('LOAD_OK ABI=' + process.versions.modules);",
  '} catch (e) {',
  "  console.log('LOAD_FAIL: ' + e.message);",
  '  process.exit(1);',
  '}',
].join('\n');

/**
 * 解析打包机上的 electron 可执行文件路径。electron 包的 index.js 在纯 Node 进程里
 * 返回当前平台 Electron 可执行文件的绝对路径（与 devDependencies 声明的版本一致，
 * 即本次打包所用的同一份 Electron）。
 */
export function resolveElectronBinary(): string {
  const bin = _require('electron') as unknown;
  if (typeof bin !== 'string' || !bin) {
    throw new Error(
      '[forge:afterCopy] ABI check: cannot resolve electron binary via require("electron")',
    );
  }
  return bin;
}

/**
 * 用 Electron 自己的加载器验证 .node 的 NODE_MODULE_VERSION 与本次打包的 Electron
 * 一致；不一致或无法加载直接抛错，终止打包（fail closed）。
 *
 * @param nativeModulePath packaged 内 .node 的绝对路径
 * @param label 人类可读模块名（用于日志 / 报错）
 * @param electronBinary 可选覆写（测试与独立脚本用）；缺省从 require('electron') 解析
 */
export function assertNativeModuleAbi(
  nativeModulePath: string,
  label: string,
  electronBinary?: string,
): void {
  if (!fs.existsSync(nativeModulePath)) {
    throw new Error(`[forge:afterCopy] ABI check: ${label} missing at ${nativeModulePath}`);
  }
  const electronBin = electronBinary ?? resolveElectronBinary();
  // Windows 注意：uv_dlopen 加载「带依赖 DLL 的 addon」（如 node-pty 1.1.x 的
  // pty.node → winpty.dll）时，若路径含正斜杠，依赖 DLL 会解析失败（错误 126
  // 「The specified module could not be found」）——由模块目录派生的 dependent
  // search path 对 `/` 不生效。统一归一化成平台原生分隔符再交给加载器，避免把
  // 「路径分隔符问题」误判成 ABI 问题（fail closed 必须失败在正确的因上）。
  const probePath =
    process.platform === 'win32' ? path.win32.normalize(nativeModulePath) : nativeModulePath;
  const probe = spawnSync(electronBin, ['-e', PROBE_SCRIPT, probePath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  const output = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`.trim();
  if (probe.status === 0 && /LOAD_OK ABI=\d+/.test(output)) {
    const abi = /ABI=(\d+)/.exec(output)?.[1] ?? '?';
    console.log(`[forge:afterCopy] ABI check ok: ${label} (NODE_MODULE_VERSION ${abi})`);
    return;
  }
  const mismatch = NODE_MODULE_VERSION_MISMATCH_RE.exec(output);
  if (mismatch) {
    throw new Error(
      `[forge:afterCopy] ABI check FAILED: ${label} is NODE_MODULE_VERSION ${mismatch[1]}` +
        (mismatch[2] ? `, but this Electron requires NODE_MODULE_VERSION ${mismatch[2]}` : '') +
        ' — the packaged .node would crash at first load (better-sqlite3: DB INIT FAILED).\n' +
        `  File: ${nativeModulePath}\n  Electron loader output: ${output}`,
    );
  }
  throw new Error(
    `[forge:afterCopy] ABI check FAILED: ${label} could not be loaded by Electron ` +
      `(${probe.error ? `spawn error: ${probe.error.message}` : `exit code ${probe.status}`}).\n` +
      `  File: ${nativeModulePath}\n  Loader output: ${output}`,
  );
}
