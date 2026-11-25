/**
 * General workspace — the directory shared by tasks that belong to no codebase.
 *
 * Contract under test (monorepo-design 4.2 改造二): the path is the INJECTED
 * `WorkspacePolicy.defaultWorkerWorkspace` — resolution never reverse-derives
 * it from the session layout and never consults the process home; it is
 * side-effect free, and creation is an idempotent `mkdir -p`.
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

/**
 * The CLI-default policy assembly: `defaultWorkerWorkspace = <dataDir>/workspace`.
 * Mirrors `resolveSessionWorkspacePolicy` (services/supervisor.ts) so this
 * suite pins the same value the host-side default produces.
 */
function cliDefaultPolicy(home: string): { workspacePolicy: { defaultWorkerWorkspace: string } } {
  return { workspacePolicy: { defaultWorkerWorkspace: path.join(home, 'workspace') } };
}

describe('resolveGeneralWorkspace', () => {
  it('resolves to <home>/.wayang/workspace for the CLI-default policy', () => {
    // 0.9.9 regression: the general workspace is `<dataDir>/workspace`, where
    // dataDir is `<home>/.wayang` for the default layout.
    const home = path.join(dataDir, '.wayang');
    fs.mkdirSync(home, { recursive: true });
    expect(resolveGeneralWorkspace(cliDefaultPolicy(home))).toBe(
      path.join(dataDir, '.wayang', 'workspace'),
    );
  });

  it('reads the injected defaultWorkerWorkspace verbatim — no session-layout derivation', () => {
    // The injected value wins regardless of what the session layout looks
    // like: an ad-hoc session dir cannot bend it, because it is never derived
    // from the session dir in the first place.
    expect(resolveGeneralWorkspace({ workspacePolicy: { defaultWorkerWorkspace: '/srv/wayang-tasks' } })).toBe(
      '/srv/wayang-tasks',
    );
  });

  it('follows a custom wayang dir (--wayang-root style, no `.wayang` segment)', () => {
    const custom = path.join(dataDir, 'wayang-data');
    expect(resolveGeneralWorkspace(cliDefaultPolicy(custom))).toBe(
      path.join(custom, 'workspace'),
    );
  });

  it('never consults the process home for an ad-hoc value', () => {
    // Reverse-derivation ban (design 4.2): an ad-hoc session dir must NOT fall
    // back to <processHome>/.wayang/workspace — the injected policy is the
    // only source. A policy pointing elsewhere keeps that elsewhere.
    const injected = path.join(dataDir, 'elsewhere');
    expect(resolveGeneralWorkspace({ workspacePolicy: { defaultWorkerWorkspace: injected } })).toBe(injected);
    expect(injected).not.toBe(path.join(os.homedir(), '.wayang', 'workspace'));
  });

  it('never touches the filesystem', () => {
    const dir = resolveGeneralWorkspace(cliDefaultPolicy(dataDir));
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe('ensureGeneralWorkspace', () => {
  it('creates the injected directory and returns its path', () => {
    const home = path.join(dataDir, '.wayang');
    const ctx = cliDefaultPolicy(home);
    const dir = ensureGeneralWorkspace(ctx);

    expect(dir).toBe(path.join(dataDir, '.wayang', 'workspace'));
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });

  it('is idempotent and keeps existing content', () => {
    const ctx = cliDefaultPolicy(dataDir);
    const first = ensureGeneralWorkspace(ctx);
    fs.writeFileSync(path.join(first, 'notes.md'), 'kept');

    const second = ensureGeneralWorkspace(ctx);

    expect(second).toBe(first);
    expect(fs.readFileSync(path.join(second, 'notes.md'), 'utf-8')).toBe('kept');
  });

  it('creates a directory that is NOT under the data dir when injected so', () => {
    // Orthogonality: the general workspace goes exactly where the policy says,
    // even outside the wayang data tree (a desktop host may point it at a
    // user-visible documents dir).
    const outside = path.join(dataDir, 'documents', 'wayang-drafts');
    const dir = ensureGeneralWorkspace({ workspacePolicy: { defaultWorkerWorkspace: outside } });
    expect(dir).toBe(outside);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });
});
