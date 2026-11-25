import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * UI discipline pin (§2.8 决策十一, 4.3 验收「界面全部经主题 token 与
 * components/ui 组件实现，无散落样式」): mechanical scans over the renderer
 * tree — hard-coded color values, inline styles, per-component ad-hoc radii,
 * off-grid (non 4/8) spacing and the token vocabulary itself are all checked
 * textually, mirroring the repo's boundary-guard style.
 */

const rendererRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const appRoot = join(rendererRoot, '../..');
const globalsCss = join(rendererRoot, 'globals.css');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('theme token system (§2.8 决策十一)', () => {
  it('globals.css declares the shadcn HSL vocabulary incl. the single --radius base', () => {
    const css = readFileSync(globalsCss, 'utf-8');
    for (const token of [
      '--background:', '--foreground:', '--card:', '--popover:', '--primary:',
      '--primary-foreground:', '--muted:', '--accent:', '--secondary:',
      '--destructive:', '--border:', '--input:', '--ring:', '--radius:',
    ]) {
      expect(css.includes(token), `globals.css must declare ${token}`).toBe(true);
    }
    // HSL system: every color token is written in hsl() form.
    expect((css.match(/--[a-z-]+: hsl\(/g) ?? []).length).toBeGreaterThanOrEqual(18);
    // Single radius base: exactly one --radius declaration; the component
    // scale (sm/md/lg/xl) derives from it.
    expect((css.match(/--radius:/g) ?? []).length).toBe(1);
    expect((css.match(/--radius-(?:sm|md|lg|xl): (?:calc\()?var\(--radius\)/g) ?? []).length).toBe(4);
  });

  it('components.json is present and points at this layout (shadcn CLI add works later)', () => {
    const path = join(appRoot, '..', 'components.json');
    expect(existsSync(path)).toBe(true);
    const config = JSON.parse(readFileSync(path, 'utf-8')) as { tailwind?: { css?: string }; aliases?: Record<string, string> };
    expect(config.tailwind?.css).toBe('src/renderer/src/globals.css');
    expect(config.aliases?.utils).toBe('@/renderer/src/lib/cn');
  });

  it('no scattered styles in the renderer tree: literals, inline styles, ad-hoc radii, off-grid spacing', () => {
    const offenders: string[] = [];
    for (const file of walk(join(rendererRoot, 'components'))) {
      const src = readFileSync(file, 'utf-8');
      const rel = file.replace(`${rendererRoot}/`, '');
      if (/#[0-9a-fA-F]{3,8}\b/.test(src) && !/data-slot|aria-|uuid|test/i.test(src)) {
        offenders.push(`${rel}: hex color literal`);
      }
      if (/\b(?:bg|text|border)-(?:white|black)\b/.test(src)) offenders.push(`${rel}: raw white/black utility`);
      if (/style=\{\{/.test(src)) offenders.push(`${rel}: inline style attribute`);
      if (/rounded-\[(?!inherit)/.test(src) || /rounded-(?:2xl|3xl)\b/.test(src)) offenders.push(`${rel}: ad-hoc radius`);
      if (/shadow-\[/.test(src)) offenders.push(`${rel}: arbitrary shadow`);
      const offGrid = src.match(/(?:^|["' ])(?:(?:p|m)(?:t|r|b|l|x|y)?|gap)-(?:0\.5|1\.5|2\.5|3\.5)\b/);
      if (offGrid) offenders.push(`${rel}: off-grid spacing "${offGrid[0].trim()}"`);
    }
    expect(offenders).toEqual([]);
  });
});
