import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Boundary pin (§2.2, 4.2 验收「组件零直访 window.wayang」): the renderer tree
 * may touch `window.wayang` ONLY through `lib/wayang-api.ts` (plus the
 * type-only declaration in types/global.d.ts). Textual scan — mirrors the
 * repo's mechanical boundary guards.
 */
describe('renderer bridge access boundary (§2.2)', () => {
  const rendererRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const ALLOWED = new Set([
    join(rendererRoot, 'lib', 'wayang-api.ts'),
    join(rendererRoot, 'types', 'global.d.ts'),
  ]);

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__') continue; // test fixtures may quote the bridge
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  it('no component or module accesses the bridge object outside wayang-api.ts', () => {
    const offenders: string[] = [];
    for (const file of walk(rendererRoot)) {
      if (ALLOWED.has(file)) continue;
      if (/window\s*\.\s*wayang/.test(readFileSync(file, 'utf-8'))) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the renderer has no string channel literals (contract is the only source)', () => {
    const offenders: string[] = [];
    for (const file of walk(rendererRoot)) {
      if (/['"]wayang:[a-zA-Z]+['"]/.test(readFileSync(file, 'utf-8'))) {
        offenders.push(file);
      }
    }
    // Channel names live in src/shared/ipc-contract.ts (outside this tree).
    expect(offenders).toEqual([]);
  });
});
