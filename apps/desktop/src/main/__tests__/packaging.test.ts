import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Packaging config pin tests (§2.10, 4.4 域四): the electron-builder setup is
 * verified at the file level — appId / productName / output dir, the
 * whole-directory asarUnpack of out/main/** (chunk-hash-named entries make
 * manifest-style unpack silently stale), the same-source mark icon (≥512 png
 * so electron-builder can convert it to .icns), the runtime dependency set
 * (the bundle's ajv runtime requires) and the dist scripts.
 */

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '../../..');
const repoRoot = join(pkgRoot, '../..');
const desktopSrcRoot = join(here, '../..');

const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8')) as {
  version: string;
  main: string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  build: {
    appId: string;
    productName: string;
    directories: { output: string };
    files: string[];
    asarUnpack: string[];
    mac: { target: string[]; icon: string; category: string };
  };
};

describe('electron-builder packaging config (§2.10, 4.4 域四)', () => {
  it('pins the version and the main entry', () => {
    expect(pkg.version).toBe('1.0.0-alpha.1');
    expect(pkg.main).toBe('./out/main/index.js');
  });

  it('pins appId / productName / output dir (mac dmg 先行)', () => {
    expect(pkg.build.appId).toBe('ai.wayang.desktop');
    expect(pkg.build.productName).toBe('Wayang');
    expect(pkg.build.directories.output).toBe('release');
    expect(pkg.build.mac.target).toEqual(['dmg']);
  });

  it('packs out/ as the app payload plus the staged runtime node_modules', () => {
    expect(pkg.build.files).toContain('out/**');
    // The ajv runtime closure is staged deterministically (electron-builder's
    // auto collection drops workspace-hoisted deps on some environments).
    expect(pkg.build.files).toContainEqual({ from: '.runtime-node-modules', to: 'node_modules', filter: ['**/*'] });
  });

  it('unpacks the whole out/main directory — fork/spawn entries must not live in the archive', () => {
    // utility-entry.js and mcp-bridge-entry.js are forked/spawned by path;
    // build chunks carry hash names, so per-file manifests go silently
    // stale. Only the whole-directory pattern is stable (§2.10).
    expect(pkg.build.asarUnpack).toContain('out/main/**');
    for (const pattern of pkg.build.asarUnpack) {
      expect(pattern).not.toMatch(/chunk-|utility-entry|mcp-bridge-entry/);
    }
  });

  it('uses the repo mark icon (≥512 png) as the single icon source', () => {
    expect(pkg.build.mac.icon).toBe('../../assets/logo/wayang-mark-icon-512.png');
    const iconPath = join(pkgRoot, pkg.build.mac.icon);
    const png = readFileSync(iconPath);
    // PNG IHDR: width/height are big-endian u32 at offsets 16/20.
    expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(512);
    expect(png.readUInt32BE(20)).toBeGreaterThanOrEqual(512);
    expect(iconPath.startsWith(join(repoRoot, 'assets/logo'))).toBe(true);
  });

  it('declares only the runtime dependency set — the ajv modules the bundle requires', () => {
    // electron-vite bundles everything; the only runtime requires left in
    // out/main are ajv's generated-code lookups, so the packaged app ships
    // exactly ajv + ajv-formats (everything else is a devDependency).
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['ajv', 'ajv-formats']);
    expect(pkg.devDependencies['electron-builder']).toBeDefined();
  });

  it('wires dist scripts through the build and the dep staging (dmg + dir smoke)', () => {
    expect(pkg.scripts.dist).toBe('npm run build && node scripts/stage-runtime-deps.mjs && electron-builder --mac');
    expect(pkg.scripts['dist:dir']).toBe(
      'npm run build && node scripts/stage-runtime-deps.mjs && electron-builder --mac --dir',
    );
  });

  it('stages the full ajv runtime closure into node_modules layout', () => {
    // Integration: run the stager into a scratch dir and verify the tree the
    // bundle's generated requires will resolve against — ajv v8 with the
    // validation_error runtime entry, ajv-formats with the formats module,
    // and the transitive leaves.
    const out = mkdtempSync(join(tmpdir(), 'wayang-stage-'));
    try {
      execFileSync('node', [join(pkgRoot, 'scripts/stage-runtime-deps.mjs'), out], { cwd: desktopSrcRoot });
      expect(existsSync(join(out, 'ajv/package.json'))).toBe(true);
      expect(existsSync(join(out, 'ajv/dist/runtime/validation_error.js'))).toBe(true);
      expect(JSON.parse(readFileSync(join(out, 'ajv/package.json'), 'utf-8')).version).toMatch(/^8\./);
      expect(existsSync(join(out, 'ajv-formats/package.json'))).toBe(true);
      expect(existsSync(join(out, 'ajv-formats/dist/formats.js'))).toBe(true);
      for (const leaf of ['fast-deep-equal', 'fast-uri', 'json-schema-traverse', 'require-from-string']) {
        expect(existsSync(join(out, leaf, 'package.json'))).toBe(true);
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('keeps the staging dir out of version control', () => {
    const gitignore = readFileSync(join(repoRoot, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('apps/desktop/.runtime-node-modules/');
  });
});
