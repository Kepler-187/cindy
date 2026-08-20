import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  packageRootForPkgJson,
  resolvePackageDir,
} from '../../../forge-package-resolution';

const tmpRoots: string[] = [];

function makeFakePackageTree(): string {
  // Simulates a package whose exports map resolves `<dep>/package.json` onto a
  // stub inside the package (the `@modelcontextprotocol/sdk` catch-all `./*`
  // case): the stub contains only `{"type":"commonjs"}`, while the real root
  // package.json carries `name` and `dependencies`.
  const root = mkdtempSync(join(tmpdir(), 'forge-pkg-resolve-'));
  tmpRoots.push(root);
  const pkgDir = join(root, 'node_modules', 'fake-exports-stub');
  mkdirSync(join(pkgDir, 'dist', 'cjs'), { recursive: true });
  writeFileSync(join(pkgDir, 'dist', 'cjs', 'package.json'), '{"type":"commonjs"}');
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({
      name: 'fake-exports-stub',
      version: '1.0.0',
      dependencies: { ajv: '^8.0.0' },
    }),
  );
  return root;
}

afterAll(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true });
});

describe('packageRootForPkgJson', () => {
  it('walks up from an exports-map stub to the real package root', () => {
    const root = makeFakePackageTree();
    const stub = join(root, 'node_modules', 'fake-exports-stub', 'dist', 'cjs', 'package.json');

    const resolved = packageRootForPkgJson(stub, 'fake-exports-stub');

    expect(resolved).toBe(join(root, 'node_modules', 'fake-exports-stub'));
  });

  it('returns the directory itself when the resolved file is already the root package.json', () => {
    const root = makeFakePackageTree();
    const pkgJson = join(root, 'node_modules', 'fake-exports-stub', 'package.json');

    expect(packageRootForPkgJson(pkgJson, 'fake-exports-stub')).toBe(
      join(root, 'node_modules', 'fake-exports-stub'),
    );
  });

  it('returns null when no matching package name is found', () => {
    const root = makeFakePackageTree();
    const pkgJson = join(root, 'node_modules', 'fake-exports-stub', 'package.json');

    expect(packageRootForPkgJson(pkgJson, 'some-other-package')).toBeNull();
  });
});

describe('resolvePackageDir', () => {
  it('resolves @modelcontextprotocol/sdk to its real root (not the dist/cjs stub)', () => {
    // @modelcontextprotocol/sdk's exports map contains a catch-all `./*` entry
    // that resolves `<dep>/package.json` onto dist/cjs/package.json. Before the
    // packageRootForPkgJson fix this returned the dist/cjs directory, so the
    // staged DSH runtime closure silently lost ajv/hono/express and crashed at
    // load time with "Cannot find module 'ajv'".
    const sdkRoot = resolvePackageDir('@modelcontextprotocol/sdk');

    expect(sdkRoot).toMatch(/node_modules[\\/]@modelcontextprotocol[\\/]sdk$/);
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const pkg = JSON.parse(
      readFileSync(join(sdkRoot, 'package.json'), 'utf8'),
    ) as { name?: string; dependencies?: Record<string, string> };
    expect(pkg.name).toBe('@modelcontextprotocol/sdk');
    expect(pkg.dependencies).toBeTruthy();
    // The missing-dependency regression: ajv must be visible from the staged root.
    expect(pkg.dependencies?.['ajv']).toBeTruthy();
  });

  it('still resolves ordinary packages from the hoisted layout', () => {
    const root = resolvePackageDir('ajv');
    expect(root).toMatch(/node_modules[\\/]ajv$/);
  });
});
