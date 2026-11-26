#!/usr/bin/env node
/**
 * Package boundary guard for the monorepo layout (feat/100).
 *
 * Three rules, all checked mechanically against the source tree:
 *   1. @wayang-ai/protocol must not import @wayang-ai/core, @wayang-ai/cli or @wayang-ai/desktop.
 *   2. @wayang-ai/core must not import @wayang-ai/cli or @wayang-ai/desktop.
 *   3. Cross-package references must go through the `@wayang-ai/*` package name.
 *      An `@/...` specifier is package-local: it has to resolve to a file inside
 *      the importing package's own `src/`. Anything else is a cross-package read
 *      written with the local alias, which silently depends on the tsconfig
 *      `paths` fallback and hides the edge.
 *
 * Relative imports that climb out of the package root are reported for the same
 * reason. Exit code 1 on any violation, 0 otherwise. No dependencies.
 *
 * Fourth rule (monorepo-design 4.2 改造二, cwd 禁令):
 *   4. `packages/core/src` source code must not call `process.cwd()` — core is
 *      a headless kernel and must never depend on the process startup
 *      directory. Test files (`__tests__/` trees, `*.test.ts`) are exempt:
 *      they legitimately anchor fixtures on the vitest working directory.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** name -> workspace group: libraries live in packages/, apps in apps/. */
const PACKAGES = [
  { name: 'protocol', group: 'packages' },
  { name: 'core', group: 'packages' },
  { name: 'cli', group: 'apps' },
  { name: 'desktop', group: 'apps' },
];

/** Namespaces each package may reference through its own `@/` alias. */
const OWNED = {
  protocol: ['types', 'rpc'],
  core: ['services', 'infra', 'server', 'utils', '__tests__', 'client'],
  cli: ['tui', 'client', 'cli', 'cli-args', 'bootstrap', 'config-loader', 'config-env', 'session-select', '__tests__', 'server-entry'],
  // `shared` is desktop's cross-context namespace (IPC contract §2.2, config
  // envelope, onboard logic): renderer/preload/main/utility all consume it.
  desktop: ['main', 'preload', 'renderer', 'utility', 'shared', '__tests__'],
};

/** Allowed `@wayang-ai/*` edges. Anything not listed is a violation. */
const ALLOWED_EDGES = {
  protocol: [],
  core: ['protocol'],
  cli: ['protocol', 'core'],
  desktop: ['protocol', 'core'],
};

const SOURCE_FILE = /\.(ts|tsx)$/;
const SPECIFIER = /(?:from\s+|import\s*\(\s*|require\(\s*)(['"])([^'"]+)\1/g;
const PROCESS_CWD = /process\s*\.\s*cwd\s*\(/;

/** Test code may anchor fixtures on the vitest working directory — exempt. */
function isTestFile(file) {
  const parts = file.split(sep);
  return parts.includes('__tests__') || /\.test\.[jt]sx?$/.test(file);
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE_FILE.test(entry.name)) out.push(full);
  }
  return out;
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Resolve `@/rest` inside a package the way tsc/esbuild do, without fallbacks. */
function resolvesInside(pkg, rest) {
  const base = join(ROOT, pkg.group, pkg.name, 'src', rest);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  return candidates.some(isFile);
}

const violations = [];
const report = (pkg, file, specifier, rule) => {
  violations.push({ pkg: pkg.name, file: relative(ROOT, file), specifier, rule });
};

for (const pkg of PACKAGES) {
  for (const file of walk(join(ROOT, pkg.group, pkg.name, 'src'))) {
    const source = readFileSync(file, 'utf8');
    SPECIFIER.lastIndex = 0;
    let match;
    while ((match = SPECIFIER.exec(source))) {
      const specifier = match[2];

      if (specifier.startsWith('@wayang-ai/')) {
        const target = specifier.slice('@wayang-ai/'.length).split('/')[0];
        if (target !== pkg.name && !ALLOWED_EDGES[pkg.name].includes(target)) {
          report(pkg, file, specifier, `forbidden edge ${pkg.name} -> ${target}`);
        }
        // Renderer/preload run in a browser context: core is full of Node
        // builtins and would break there. They may only touch protocol.
        const rel = relative(ROOT, file);
        const rendererLike =
          rel.startsWith(join('apps', 'desktop', 'src', 'renderer') + sep) ||
          rel.startsWith(join('apps', 'desktop', 'src', 'preload') + sep);
        if (rendererLike && target === 'core') {
          report(pkg, file, specifier, 'renderer/preload must not import @wayang-ai/core (protocol only)');
        }
        continue;
      }

      // `@/../package.json` is the package's own manifest (the alias points at
      // `<pkg>/src`), not a cross-package read.
      if (specifier === '@/../package.json') continue;

      if (specifier.startsWith('@/')) {
        const rest = specifier.slice(2);
        const top = rest.split('/')[0];
        if (!OWNED[pkg.name].includes(top) || !resolvesInside(pkg, rest)) {
          report(pkg, file, specifier, 'cross-package reference must use @wayang-ai/*');
        }
        continue;
      }

      if (specifier.startsWith('.')) {
        const target = resolve(dirname(file), specifier);
        const pkgRoot = join(ROOT, pkg.group, pkg.name);
        if (!target.startsWith(pkgRoot + sep)) {
          report(pkg, file, specifier, 'relative import escapes the package root');
          continue;
        }
        const candidates = [target, `${target}.ts`, `${target}.tsx`, join(target, 'index.ts')];
        if (!candidates.some(isFile)) {
          report(pkg, file, specifier, 'relative import does not resolve inside the package');
        }
      }
    }
  }
}

// --- Rule 4 (monorepo-design 4.2 改造二): core source must not call process.cwd() ---

const CORE_SRC = join(ROOT, 'packages', 'core', 'src');
for (const file of walk(CORE_SRC)) {
  if (isTestFile(file)) continue;
  const source = readFileSync(file, 'utf8');
  if (PROCESS_CWD.test(source)) {
    violations.push({
      pkg: 'core',
      file: relative(ROOT, file),
      specifier: 'process.cwd()',
      rule: 'core source code must not depend on the process startup directory (design 4.2) — inject the controllerWorkspace / storage paths instead',
    });
  }
}

if (violations.length === 0) {
  console.log('boundaries: ok (packages: protocol <- core; apps: cli, desktop; cross-package imports use @wayang-ai/*; core src has no process.cwd)');
  process.exit(0);
}

console.error(`boundaries: ${violations.length} violation(s)`);
for (const v of violations) {
  console.error(`  [${v.pkg}] ${v.file}: ${v.specifier} — ${v.rule}`);
}
process.exit(1);
