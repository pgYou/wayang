#!/usr/bin/env node
/**
 * Stage the runtime node_modules closure for packaging (desktop-app-design
 * §2.10, 4.4 域四).
 *
 * electron-vite bundles the whole app except one runtime detail: ajv's
 * code generation emits `require("ajv/dist/runtime/…")` /
 * `require("ajv-formats/dist/formats")` as BARE SPECIFIERS inside generated
 * validator code, so those packages must exist as a real node_modules tree
 * inside the packaged app.
 *
 * electron-builder's automatic dependency collection was not deterministic
 * for this monorepo layout (workspace-hoisting silently dropped path-less
 * dedup references under npm; pnpm's symlinked .pnpm store is equally
 * outside its assumptions). The dist scripts therefore stage the closure
 * explicitly: resolve every package the way node would, copy it into the
 * staging dir, and let the `files` entry place the tree at node_modules in
 * the archive.
 *
 * pnpm layout note: `node_modules/ajv` is a symlink into
 * `node_modules/.pnpm/ajv@x/node_modules/ajv`, and ajv's own dependencies
 * live SIBLING to it (`.pnpm/ajv@x/node_modules/fast-deep-equal`), not in an
 * ancestor. Resolution therefore starts from the REALPATH of the dependent
 * (the .pnpm store path), where the plain upward walk finds them; copies
 * dereference symlinks so the staged tree is a self-contained plain file
 * tree with no links back into .pnpm.
 *
 * Usage: node scripts/stage-runtime-deps.mjs [outDir]
 * (default outDir: <app>/.runtime-node-modules; relative paths resolve
 * against the app dir.)
 */

import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Runtime dependencies — the ajv closure the bundle's generated code requires. */
const RUNTIME_DEPENDENCIES = ['ajv', 'ajv-formats'];

/**
 * Resolve a package DIRECTORY the way node resolves bare specifiers.
 * Starts from the realpath of `fromDir` so pnpm's `.pnpm` sibling layout
 * resolves; returns the realpath of the found package.
 */
function findPackageDir(name, fromDir) {
  let dir = realpathSync(fromDir);
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`cannot resolve package "${name}" from ${fromDir}`);
    dir = parent;
  }
}

/** Production dependency names: dependencies plus peerDependencies. */
function declaredDependencyNames(packageDir) {
  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf-8'));
  return Object.keys(pkg.dependencies ?? {}).concat(Object.keys(pkg.peerDependencies ?? {}));
}

/**
 * Stage `packageDir` as `name` into `outDir` (flat at the top level unless
 * `nestUnder` is given). Already-staged realpaths are skipped; a name that
 * resolves to a different version than a top-level staging lands nested
 * under its dependent. Symlinks are dereferenced — the staged tree must be
 * a plain, self-contained file tree.
 */
function stage(name, packageDir, outDir, nestUnder) {
  const destDir = nestUnder ? join(nestUnder, 'node_modules', name) : join(outDir, name);
  cpSync(packageDir, destDir, { recursive: true, dereference: true });
  console.log(`staged ${name} <- ${relative(appDir, packageDir) || packageDir} -> ${relative(appDir, destDir) || destDir}`);
  return destDir;
}

function main() {
  const outDirArg = process.argv[2] ?? '.runtime-node-modules';
  const outDir = isAbsolute(outDirArg) ? outDirArg : resolve(appDir, outDirArg);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  /** name -> { srcDir (realpath source), stagedDir } for the top level. */
  const topLevel = new Map();

  const walk = (name, fromDir, nestUnder) => {
    const srcDir = findPackageDir(name, fromDir);
    // Same package already staged at the top level: node resolution from the
    // dependent walks up and finds it, so no second copy is needed — unless
    // a nested copy already came along verbatim, which wins anyway.
    const existing = topLevel.get(name);
    if (existing && existing.srcDir === resolve(srcDir)) return;
    const stagedDir = stage(name, srcDir, outDir, nestUnder);
    if (!nestUnder) topLevel.set(name, { srcDir: resolve(srcDir), stagedDir });
    for (const depName of declaredDependencyNames(srcDir)) {
      // Nested node_modules that came along with the verbatim copy satisfy
      // the dependency without another staging pass.
      if (existsSync(join(stagedDir, 'node_modules', depName, 'package.json'))) continue;
      const depSrc = findPackageDir(depName, srcDir);
      const depTop = topLevel.get(depName);
      if (depTop && depTop.srcDir !== resolve(depSrc)) {
        // Different version than the top-level staging: nest under this
        // dependent so its resolution picks the version it declared.
        walk(depName, srcDir, stagedDir);
        continue;
      }
      walk(depName, srcDir, undefined);
    }
  };

  for (const name of RUNTIME_DEPENDENCIES) walk(name, appDir, undefined);
  console.log(`runtime node_modules staged into ${relative(appDir, outDir) || outDir}`);
}

main();
