import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

interface LauncherModule {
  composePatchLayers(userPatches: unknown[] | undefined): unknown[];
  createInstalledRuntimeRequire(metaUrl?: string): NodeRequire;
  resolveBareModuleBaseUrl(runtimeRequire?: NodeRequire): string;
  resolveRequestedConfig(env?: NodeJS.ProcessEnv, argv?: string[]): string | undefined;
}

interface ForgeDshRuntimeModule {
  stageDshRuntime(buildPath: string): void;
}

const desktopRoot = path.resolve(process.cwd());
const launcherPath = path.join(desktopRoot, 'dsh', 'cindy-dsh-bin.mjs');
const tempRoots: string[] = [];

async function launcherModule(): Promise<LauncherModule> {
  return import(/* @vite-ignore */ pathToFileURL(launcherPath).href) as Promise<LauncherModule>;
}

async function createLauncherFixture(): Promise<{
  root: string;
  home: string;
  configPath: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-dsh-launcher-'));
  tempRoots.push(root);
  const home = path.join(root, 'dsh-home');
  await mkdir(home, { recursive: true });
  const configPath = path.join(root, 'cordis.yml');
  await writeFile(configPath, '[]\n', 'utf8');
  return { root, home, configPath };
}

function runLauncher(configPath: string, home: string) {
  return spawnSync(process.execPath, [launcherPath, configPath], {
    cwd: desktopRoot,
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
    input: '',
    timeout: 20_000,
  });
}

async function runLauncherUntilReady(configPath: string, home: string, readyText: string) {
  const child = spawn(process.execPath, [launcherPath, configPath], {
    cwd: desktopRoot,
    env: { ...process.env, DSH_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let endedInput = false;
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
    if (!endedInput && stderr.includes(readyText)) {
      endedInput = true;
      child.stdin.end();
    }
  });
  return await new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`launcher did not exit after readiness; stderr=${stderr}`));
      }, 20_000);
      child.once('error', reject);
      child.once('close', (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      });
    },
  );
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })),
  );
});

describe('Cindy DSH launcher', () => {
  it('puts the built-in settings provider before user patch layers', async () => {
    const launcher = await launcherModule();
    const userPatch = { id: 'settings', config: { watch: false } };

    expect(launcher.composePatchLayers([userPatch])).toEqual([
      { insert: [{ id: 'settings', name: '@deepseek-ai/dsh-settings-file' }] },
      userPatch,
    ]);
  });

  it('keeps the packaged-bin config precedence and resolves the installed runtime anchor', async () => {
    const launcher = await launcherModule();
    expect(
      launcher.resolveRequestedConfig({ DSH_CORDIS_CONFIG: 'from-env.yml' }, [
        'node',
        launcherPath,
        'from-argv.yml',
      ]),
    ).toBe('from-env.yml');
    expect(launcher.resolveRequestedConfig({}, ['node', launcherPath, 'from-argv.yml'])).toBe(
      'from-argv.yml',
    );

    const anchor = new URL(
      launcher.resolveBareModuleBaseUrl(launcher.createInstalledRuntimeRequire()),
    );
    expect(anchor.protocol).toBe('file:');
    expect(anchor.pathname.replace(/\\/g, '/')).toContain(
      '/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/packaged-bin.js',
    );
  });

  it('loads a home-level user plugin without writing diagnostics to stdout', async () => {
    const { root, home, configPath } = await createLauncherFixture();
    const pluginPath = path.join(root, 'user-marker.mjs');
    const markerPath = path.join(root, 'loaded.txt');
    await writeFile(
      pluginPath,
      `import { writeFileSync } from 'node:fs';\nexport default function apply(_ctx, config) { writeFileSync(config.markerPath, config.note, 'utf8'); process.stderr.write('[user-marker-ready]\\n'); }\n`,
      'utf8',
    );
    await writeFile(
      path.join(home, 'cordis.patch.yml'),
      `- insert:\n  - id: user-marker\n    name: ${JSON.stringify(pluginPath)}\n    config:\n      markerPath: ${JSON.stringify(markerPath)}\n      note: loaded-through-user-patch\n`,
      'utf8',
    );

    const result = await runLauncherUntilReady(configPath, home, '[user-marker-ready]');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(await readFile(markerPath, 'utf8')).toBe('loaded-through-user-patch');
  });

  it('fails loud for invalid user patch YAML and invalid shared settings', async () => {
    const patchFixture = await createLauncherFixture();
    const patchPath = path.join(patchFixture.home, 'cordis.patch.yml');
    await writeFile(patchPath, '- insert: [\n', 'utf8');
    const invalidPatch = runLauncher(patchFixture.configPath, patchFixture.home);
    expect(invalidPatch.status).toBe(1);
    expect(invalidPatch.stderr).toContain(patchPath);
    expect(invalidPatch.stdout).toBe('');

    const settingsFixture = await createLauncherFixture();
    const settingsPath = path.join(settingsFixture.home, 'settings.yaml');
    await writeFile(path.join(settingsFixture.home, 'cordis.patch.yml'), '[]\n', 'utf8');
    await writeFile(settingsPath, 'bash: [\n', 'utf8');
    const invalidSettings = runLauncher(settingsFixture.configPath, settingsFixture.home);
    expect(invalidSettings.status).toBe(1);
    expect(invalidSettings.stderr).toContain(settingsPath);
    expect(invalidSettings.stdout).toBe('');
  });
});

describe('DSH launcher packaging contract', () => {
  it('stages a runnable dependency closure without recursing through package cycles', async () => {
    const buildPath = await mkdtemp(path.join(os.tmpdir(), 'cindy-dsh-stage-'));
    tempRoots.push(buildPath);
    const forge = (await import('../../../../forge.config')) as ForgeDshRuntimeModule;

    forge.stageDshRuntime(buildPath);

    const stagedLauncher = path.join(buildPath, '.vite', 'build', 'cindy-dsh-bin.mjs');
    const home = path.join(buildPath, 'dsh-home');
    const configPath = path.join(buildPath, 'cordis.yml');
    await mkdir(home, { recursive: true });
    await writeFile(configPath, '[]\n', 'utf8');
    const result = spawnSync(process.execPath, [stagedLauncher, configPath], {
      cwd: buildPath,
      env: { ...process.env, DSH_HOME: home },
      encoding: 'utf8',
      input: '',
      timeout: 60_000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
  }, 120_000);

  it('stages the launcher in the ASAR tree and lets the utility worker import mjs', async () => {
    const forge = await readFile(path.join(desktopRoot, 'forge.config.ts'), 'utf8');
    const worker = await readFile(
      path.join(desktopRoot, 'src', 'main', 'maker-host', 'dshRuntimeWorkerProcess.ts'),
      'utf8',
    );

    expect(forge).toContain('stageDshRuntime(buildPath)');
    expect(forge).toContain("'.vite', 'build', 'cindy-dsh-bin.mjs'");
    expect(forge).toContain('peerDependenciesMeta');
    expect(worker).toContain("['.js', '.mjs'].includes(path.extname(entryPath))");
    expect(worker).not.toContain('ELECTRON_RUN_AS_NODE');
  });
});
