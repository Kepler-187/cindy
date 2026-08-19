#!/usr/bin/env node

/**
 * Cindy's thin local DSH launcher.
 *
 * It preserves the upstream packaged-bin stdio contract while adding two DSH-owned
 * configuration layers: the settings provider and the user's home-level patch file.
 * Stdout belongs exclusively to JSON-RPC; all launcher diagnostics go to stderr.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NAME = 'cindy-dsh-agent';
const SETTINGS_ENTRY = Object.freeze({
  insert: [{ id: 'settings', name: '@deepseek-ai/dsh-settings-file' }],
});

export function composePatchLayers(userPatches) {
  return [SETTINGS_ENTRY, ...(userPatches ?? [])];
}

export function resolveRequestedConfig(env = process.env, argv = process.argv) {
  const fromEnv = env.DSH_CORDIS_CONFIG;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  const fromArgv = argv[2];
  return typeof fromArgv === 'string' && fromArgv.length > 0 ? fromArgv : undefined;
}

export function createInstalledRuntimeRequire(metaUrl = import.meta.url) {
  const launcherDir = path.dirname(fileURLToPath(metaUrl));
  const packagedManifest = path.join(launcherDir, '..', '..', 'package.json');
  if (existsSync(packagedManifest)) return createRequire(packagedManifest);
  return createRequire(metaUrl);
}

export function resolveBareModuleBaseUrl(runtimeRequire = createInstalledRuntimeRequire()) {
  return pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-sdk-jsonrpc-demo/packaged-bin'))
    .href;
}

async function loadDshRuntime(runtimeRequire) {
  const [appBoot, homePaths] = await Promise.all([
    import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-app-boot')).href),
    import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-home-paths')).href),
  ]);
  return { ...appBoot, ...homePaths };
}

export async function runCindyDshAgent({
  env = process.env,
  argv = process.argv,
  stdin = process.stdin,
  runtimeRequire = createInstalledRuntimeRequire(),
} = {}) {
  const {
    boot,
    dshHomePath,
    installFailLoud,
    loadEnv,
    loadOptionalPatches,
    PROFILE_PATCH_FILENAME,
    resolveConfigPath,
  } = await loadDshRuntime(runtimeRequire);

  installFailLoud(NAME);
  loadEnv(NAME);
  const requested = resolveRequestedConfig(env, argv);
  const configPath = requested === undefined ? undefined : resolveConfigPath(requested, undefined);
  if (configPath === undefined || !existsSync(configPath)) {
    process.stderr.write(
      `usage: ${NAME} <path/to/cordis.yml> (or set DSH_CORDIS_CONFIG=<path>, which wins); the config is required\n`,
    );
    process.exit(1);
  }

  const userPatchPath = dshHomePath(PROFILE_PATCH_FILENAME);
  const userPatches = loadOptionalPatches(NAME, userPatchPath);
  const ctx = await boot(
    NAME,
    configPath,
    composePatchLayers(userPatches),
    undefined,
    resolveBareModuleBaseUrl(runtimeRequire),
  );

  let exiting = false;
  async function disposeAndExit(code) {
    if (exiting) return;
    exiting = true;
    try {
      await ctx.fiber.dispose();
    } finally {
      process.exit(code);
    }
  }

  stdin.on('end', () => void disposeAndExit(0));
  process.on('SIGTERM', () => void disposeAndExit(0));
  process.on('SIGINT', () => void disposeAndExit(130));
  stdin.resume?.();
}

const invokedPath = process.argv[1];
const isMain =
  typeof invokedPath === 'string' &&
  pathToFileURL(path.resolve(invokedPath)).href ===
    pathToFileURL(fileURLToPath(import.meta.url)).href;

if (isMain) await runCindyDshAgent();
