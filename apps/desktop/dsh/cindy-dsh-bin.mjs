#!/usr/bin/env node

/**
 * Cindy's thin local DSH launcher.
 *
 * It preserves the upstream packaged-bin stdio contract while composing the official
 * DSH base, the user's home-level patch, and Cindy's narrow runtime overlay.
 * Stdout belongs exclusively to JSON-RPC; all launcher diagnostics go to stderr.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NAME = 'cindy-dsh-agent';
export function composePatchLayers(basePatches, userPatches, cindyPatches, derivedPatches = []) {
  return [...basePatches, ...(userPatches ?? []), ...cindyPatches, ...derivedPatches];
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

export function resolveShippedPresetRoot(runtimeRequire = createInstalledRuntimeRequire()) {
  return path.join(
    path.dirname(runtimeRequire.resolve('@deepseek-ai/dsh/package.json')),
    'config',
    'agent-presets',
  );
}

export function resolveBundlePatchPath(packageName, runtimeRequire = createInstalledRuntimeRequire()) {
  const manifestPath = runtimeRequire.resolve(`${packageName}/package.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const declared = manifest?.dsh?.bundle?.patch;
  if (typeof declared !== 'string' || declared.length === 0) {
    throw new Error(`${NAME}: ${packageName} does not declare dsh.bundle.patch`);
  }
  return path.resolve(path.dirname(manifestPath), declared);
}

export function presetRootPatch(entries, presetRoot) {
  const presetEntry = entries.find((entry) => entry?.id === 'agent-presets');
  if (!presetEntry) throw new Error(`${NAME}: Cindy overlay did not compose agent-presets`);
  return [{
    id: 'agent-presets',
    config: {
      ...(presetEntry.config ?? {}),
      roots: [{ path: presetRoot, trust: 'system' }],
    },
  }];
}

export function resolveCindyBridgeEntry(patches, bridgeUrl) {
  let matches = 0;
  const resolved = patches.map((patch) => {
    if (!Array.isArray(patch?.insert)) return patch;
    return {
      ...patch,
      insert: patch.insert.map((entry) => {
        if (entry?.id !== 'cindy-dsh-bridge') return entry;
        matches += 1;
        return { ...entry, name: bridgeUrl };
      }),
    };
  });
  if (matches !== 1) throw new Error(`${NAME}: Cindy overlay must insert exactly one bridge entry`);
  return resolved;
}

/**
 * Cindy does not own preset ids. Read the active DSH web bundle's declared
 * default and apply it to Cindy's separately composed agent-preset service.
 */
export function resolveOfficialPresetDefault(
  runtimeRequire,
  loadOverlayPatches,
  composeEntries,
) {
  const webPatchPath = resolveBundlePatchPath('@deepseek-ai/dsh-web-app', runtimeRequire);
  const entries = composeEntries([loadOverlayPatches(NAME, webPatchPath)]);
  const presetEntry = entries.find((entry) => entry?.id === 'agent-presets');
  const defaultId = presetEntry?.config?.default;
  if (typeof defaultId !== 'string' || defaultId.length === 0) {
    throw new Error(`${NAME}: active DSH web bundle does not declare an agent preset default`);
  }
  return defaultId;
}

export function applyAgentPresetDefault(patches, defaultId) {
  let matches = 0;
  const resolved = patches.map((patch) => {
    if (!Array.isArray(patch?.insert)) return patch;
    return {
      ...patch,
      insert: patch.insert.map((entry) => {
        if (entry?.id !== 'agent-presets') return entry;
        matches += 1;
        return { ...entry, config: { ...(entry.config ?? {}), default: defaultId } };
      }),
    };
  });
  if (matches !== 1) throw new Error(`${NAME}: Cindy overlay must insert exactly one agent-presets entry`);
  return resolved;
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
    composeEntries,
    dshHomePath,
    installFailLoud,
    loadEnv,
    loadOptionalPatches,
    loadOverlayPatches,
    PROFILE_PATCH_FILENAME,
    resolveConfigPath,
  } = await loadDshRuntime(runtimeRequire);

  installFailLoud(NAME);
  loadEnv(NAME);
  const requested = resolveRequestedConfig(env, argv);
  const overlayPath = requested === undefined ? undefined : resolveConfigPath(requested, undefined);
  if (overlayPath === undefined || !existsSync(overlayPath)) {
    process.stderr.write(
      `usage: ${NAME} <path/to/cordis.yml> (or set DSH_CORDIS_CONFIG=<path>, which wins); the config is required\n`,
    );
    process.exit(1);
  }

  const launcherDir = path.dirname(fileURLToPath(import.meta.url));
  const configPath = path.join(launcherDir, 'cindy-dsh-empty.yml');
  const basePatchPath = resolveBundlePatchPath('@deepseek-ai/dsh-base', runtimeRequire);
  const basePatches = loadOverlayPatches(NAME, basePatchPath);
  const officialPresetDefault = resolveOfficialPresetDefault(
    runtimeRequire,
    loadOverlayPatches,
    composeEntries,
  );
  const cindyPatches = resolveCindyBridgeEntry(
    applyAgentPresetDefault(loadOverlayPatches(NAME, overlayPath), officialPresetDefault),
    pathToFileURL(path.join(path.dirname(overlayPath), 'cindy-dsh-bridge.mjs')).href,
  );
  const userPatchPath = dshHomePath(PROFILE_PATCH_FILENAME);
  const userPatches = loadOptionalPatches(NAME, userPatchPath);
  process.env.DSH_AGENT_MODULE_URL = pathToFileURL(
    runtimeRequire.resolve('@deepseek-ai/dsh-agent'),
  ).href;
  const preliminary = composePatchLayers(basePatches, userPatches, cindyPatches);
  const derived = presetRootPatch(
    composeEntries([preliminary]),
    resolveShippedPresetRoot(runtimeRequire),
  );
  const ctx = await boot(
    NAME,
    configPath,
    composePatchLayers(basePatches, userPatches, cindyPatches, derived),
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
