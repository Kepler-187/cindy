/**
 * Packaging-time package-directory resolution shared by forge.config.ts.
 *
 * Locates a package's directory on disk. Some packages ship a strict `exports`
 * map that hides the obvious resolve targets:
 *   - `long` blocks `./package.json` but exposes a main entry → walk up from
 *     the bare specifier resolve.
 *   - `@img/sharp-{platform}-{arch}` blocks BOTH `./package.json` AND the bare
 *     specifier (no main), but exposes `./package` → resolve that, it points
 *     at package.json directly.
 *   - `@modelcontextprotocol/sdk` exposes a catch-all `./*` entry that maps
 *     `./package.json` onto `dist/cjs/package.json` (a stub containing only
 *     `{"type":"commonjs"}`) — the resolved file is NOT the package root, so
 *     we must walk up until we find the `package.json` whose `name` matches.
 *     (Missed this and the staged DSH runtime shipped without ajv/hono/express,
 *     so `dsh-mcp-client` → `@modelcontextprotocol/sdk` failed to load at
 *     runtime: `Cannot find module 'ajv'`.)
 * Final fallback: locate via the workspace root's hoisted node_modules path
 * (we use pnpm node-linker=hoisted, so every dep lives under root node_modules).
 */
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

export function resolveOptions(fromDirs?: string[]): { paths: string[] } | undefined {
  return fromDirs && fromDirs.length > 0 ? { paths: fromDirs } : undefined;
}

/**
 * Walk up from a resolved `package.json` file to the package root whose
 * `name` matches `dep`. Some `exports` maps (e.g. `@modelcontextprotocol/sdk`'s
 * catch-all `./*`) can resolve `<dep>/package.json` onto a stub inside the
 * package (e.g. `dist/cjs/package.json` containing only `{"type":"commonjs"}`);
 * taking that directory as the package root would copy the wrong tree and
 * silently drop the package's `dependencies`. Returns null when no matching
 * root is found (the caller falls through to the next strategy).
 */
export function packageRootForPkgJson(pkgJsonPath: string, dep: string): string | null {
  let dir = path.dirname(pkgJsonPath);
  for (;;) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { name?: unknown };
        if (pkg.name === dep) return dir;
      } catch {
        // Malformed JSON; keep walking up.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function resolvePackageDir(dep: string, fromDirs?: string[]): string {
  // fromDirs: 从这些目录的视角解析(require.resolve 的 paths 选项)。用于消歧
  // 多版本依赖 —— 例如 node-addon-api 同时存在 1.7.2 (iconv-corefoundation, mac
  // dmg 工具链, 无 `.targets`) 和 7.1.1 (node-pty 需要)。hoisted 布局下 root
  // node_modules 只留一个版本, 若被 1.7.2 占了, 直接 resolve 会拿错版本, node-pty
  // 的 binding.gyp `require('node-addon-api').targets` 会因 undefined 而炸。传
  // node-pty 目录当 fromDirs 就能锁定它实际用的 7.1.1 (nested 或 hoisted 都覆盖)。
  const resolvePkgRoot = (from: string[] | undefined): string | null => {
    try {
      const pkgJson = _require.resolve(`${dep}/package.json`, resolveOptions(from));
      const root = packageRootForPkgJson(pkgJson, dep);
      if (root) return root;
    } catch {
      // ignore, try next strategy
    }
    return null;
  };
  if (fromDirs && fromDirs.length > 0) {
    const rooted = resolvePkgRoot(fromDirs);
    if (rooted) return rooted;
  }
  const rooted = resolvePkgRoot(undefined);
  if (rooted) return rooted;
  try {
    // sharp-style: `./package` exports map entry → resolves to package.json
    const pkgJson = _require.resolve(`${dep}/package`, resolveOptions(fromDirs));
    if (pkgJson.endsWith('package.json')) {
      const root = packageRootForPkgJson(pkgJson, dep);
      if (root) return root;
    }
  } catch {
    // ignore, try next strategy
  }
  try {
    let dir = path.dirname(_require.resolve(dep, resolveOptions(fromDirs)));
    while (dir !== path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, 'package.json'))) {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        if (pkg.name === dep) return dir;
      }
      dir = path.dirname(dir);
    }
  } catch {
    // ignore, try final filesystem fallback
  }
  // Final fallback: pnpm hoisted layout — every dep is at <repo>/node_modules/<dep>.
  // This module lives in apps/desktop, so repo root is two levels up.
  const hoisted = path.join(moduleDir, '..', '..', 'node_modules', dep);
  if (fs.existsSync(path.join(hoisted, 'package.json'))) return hoisted;
  throw new Error(`[forge] cannot locate package dir for "${dep}"`);
}
