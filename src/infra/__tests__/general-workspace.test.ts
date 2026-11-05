/**
 * General workspace — the directory shared by tasks that belong to no codebase.
 *
 * Contract under test: it lives at `<wayangDir>/workspace` (so ~/.wayang/
 * workspace for the default layout), resolution is side-effect free, and
 * creation is an idempotent `mkdir -p`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureGeneralWorkspace, resolveGeneralWorkspace } from '@/infra/general-workspace';

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wayang-general-ws-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** A session directory following the documented `<wayangDir>/sessions/<id>` layout. */
function sessionDirFor(home: string): string {
  return path.join(home, '.wayang', 'sessions', 's-1');
}

describe('resolveGeneralWorkspace', () => {
  it('resolves to <home>/.wayang/workspace for the default session layout', () => {
    expect(resolveGeneralWorkspace({ sessionDir: sessionDirFor(dataDir) })).toBe(
      path.join(dataDir, '.wayang', 'workspace'),
    );
  });

  it('follows a custom wayang dir (--home-dir style, no `.wayang` segment)', () => {
    const custom = path.join(dataDir, 'wayang-data');
    expect(resolveGeneralWorkspace({ sessionDir: path.join(custom, 'sessions', 's-1') })).toBe(
      path.join(custom, 'workspace'),
    );
  });

  it('falls back to the default wayang dir for ad-hoc session dirs', () => {
    // Not a `<wayangDir>/sessions/<id>` layout: nothing can be derived, so the
    // default location is used rather than a guessed parent.
    expect(resolveGeneralWorkspace({ sessionDir: '/tmp/hand-built-session' })).toBe(
      path.join(os.homedir(), '.wayang', 'workspace'),
    );
  });

  it('never touches the filesystem', () => {
    const dir = resolveGeneralWorkspace({ sessionDir: sessionDirFor(dataDir) });
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe('ensureGeneralWorkspace', () => {
  it('creates the directory and returns its path', () => {
    const dir = ensureGeneralWorkspace({ sessionDir: sessionDirFor(dataDir) });

    expect(dir).toBe(path.join(dataDir, '.wayang', 'workspace'));
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });

  it('is idempotent and keeps existing content', () => {
    const first = ensureGeneralWorkspace({ sessionDir: sessionDirFor(dataDir) });
    fs.writeFileSync(path.join(first, 'notes.md'), 'kept');

    const second = ensureGeneralWorkspace({ sessionDir: sessionDirFor(dataDir) });

    expect(second).toBe(first);
    expect(fs.readFileSync(path.join(second, 'notes.md'), 'utf-8')).toBe('kept');
  });
});
