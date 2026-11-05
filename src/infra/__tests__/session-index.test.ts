/**
 * SessionIndex tests — in-memory cache over sessions/<id>/meta.json.
 *
 * Key properties under test:
 * - No shared on-disk index file is written (multi-instance safety).
 * - Queries filter by workspace and archived flag.
 * - Cursor + limit pagination behaves newest-first.
 * - Upsert updates the cache without touching disk.
 * - invalidate() picks up sessions created by other processes.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSessionIndex } from '@/infra/session-index';
import type { SessionMeta } from '@/infra/session-helpers';

let dataDir: string;

function writeMeta(sessionId: string, overrides: Partial<SessionMeta> = {}): void {
  const sessionDir = path.join(dataDir, 'sessions', sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const meta: SessionMeta = {
    sessionId,
    workspace: '/repo-a',
    firstInput: null,
    createdAt: 1000,
    lastActiveAt: 1000,
    ...overrides,
  };
  fs.writeFileSync(path.join(sessionDir, 'meta.json'), JSON.stringify(meta));
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wayang-index-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('SessionIndex — list', () => {
  it('returns sessions newest-created first', () => {
    writeMeta('old', { createdAt: 1000 });
    writeMeta('newest', { createdAt: 3000 });
    writeMeta('mid', { createdAt: 2000 });

    const ids = createSessionIndex(dataDir).list().map(e => e.sessionId);
    expect(ids).toEqual(['newest', 'mid', 'old']);
  });

  it('returns empty array when sessions/ does not exist', () => {
    expect(createSessionIndex(dataDir).list()).toEqual([]);
  });

  it('filters by workspace', () => {
    writeMeta('a1', { workspace: '/repo-a', createdAt: 1000 });
    writeMeta('a2', { workspace: '/repo-a', createdAt: 2000 });
    writeMeta('b1', { workspace: '/repo-b', createdAt: 3000 });

    const ids = createSessionIndex(dataDir).list({ workspace: '/repo-a' }).map(e => e.sessionId);
    expect(ids).toEqual(['a2', 'a1']);
  });

  it('excludes archived sessions by default and includes them on request', () => {
    writeMeta('visible', { createdAt: 2000 });
    writeMeta('hidden', { createdAt: 1000, archived: true });

    const index = createSessionIndex(dataDir);
    expect(index.list().map(e => e.sessionId)).toEqual(['visible']);
    expect(index.list({ includeArchived: true }).map(e => e.sessionId)).toEqual(['visible', 'hidden']);
  });

  it('treats absent archived flag as not archived (legacy meta.json)', () => {
    writeMeta('legacy', { createdAt: 1000 });
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'sessions', 'legacy', 'meta.json'), 'utf-8'));
    expect('archived' in raw).toBe(false);

    expect(createSessionIndex(dataDir).list().map(e => e.sessionId)).toEqual(['legacy']);
  });

  it('resolves sessionDir alongside meta', () => {
    writeMeta('s1', { createdAt: 1000 });
    const entry = createSessionIndex(dataDir).list()[0];
    expect(entry.sessionDir).toBe(path.join(dataDir, 'sessions', 's1'));
  });

  it('skips malformed meta.json without failing the whole list', () => {
    writeMeta('good', { createdAt: 2000 });
    const brokenDir = path.join(dataDir, 'sessions', 'broken');
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(path.join(brokenDir, 'meta.json'), '{ not valid json');

    writeMeta('good2', { createdAt: 3000 });
    expect(createSessionIndex(dataDir).list().map(e => e.sessionId)).toEqual(['good2', 'good']);
  });
});

describe('SessionIndex — pagination', () => {
  beforeEach(() => {
    writeMeta('s3', { createdAt: 3000 });
    writeMeta('s2', { createdAt: 2000 });
    writeMeta('s1', { createdAt: 1000 });
  });

  it('honours limit', () => {
    expect(createSessionIndex(dataDir).list({ limit: 2 }).map(e => e.sessionId)).toEqual(['s3', 's2']);
  });

  it('treats limit 0 as empty', () => {
    expect(createSessionIndex(dataDir).list({ limit: 0 })).toEqual([]);
  });

  it('cursor is exclusive: resumes after the given sessionId', () => {
    const index = createSessionIndex(dataDir);
    const page1 = index.list({ limit: 2 }).map(e => e.sessionId);
    expect(page1).toEqual(['s3', 's2']);

    const page2 = index.list({ limit: 2, cursor: page1[page1.length - 1] });
    expect(page2.map(e => e.sessionId)).toEqual(['s1']);
  });

  it('unknown cursor is ignored rather than returning nothing', () => {
    expect(createSessionIndex(dataDir).list({ cursor: 'does-not-exist' })).toHaveLength(3);
  });
});

describe('SessionIndex — get / latestForWorkspace', () => {
  it('get resolves an existing session', () => {
    writeMeta('s1', { createdAt: 1000 });
    const entry = createSessionIndex(dataDir).get('s1');
    expect(entry?.sessionId).toBe('s1');
    expect(entry?.meta.workspace).toBe('/repo-a');
  });

  it('get returns null for unknown session', () => {
    expect(createSessionIndex(dataDir).get('nope')).toBeNull();
  });

  it('latestForWorkspace picks the newest matching session', () => {
    writeMeta('a-old', { workspace: '/repo-a', createdAt: 1000 });
    writeMeta('a-new', { workspace: '/repo-a', createdAt: 2000 });
    writeMeta('b-new', { workspace: '/repo-b', createdAt: 3000 });

    const index = createSessionIndex(dataDir);
    expect(index.latestForWorkspace('/repo-a')?.sessionId).toBe('a-new');
    expect(index.latestForWorkspace('/repo-b')?.sessionId).toBe('b-new');
    expect(index.latestForWorkspace('/repo-c')).toBeNull();
  });

  it('latestForWorkspace skips archived sessions unless asked', () => {
    writeMeta('a-archived', { workspace: '/repo-a', createdAt: 2000, archived: true });
    writeMeta('a-open', { workspace: '/repo-a', createdAt: 1000 });

    const index = createSessionIndex(dataDir);
    expect(index.latestForWorkspace('/repo-a')?.sessionId).toBe('a-open');
    expect(index.latestForWorkspace('/repo-a', { includeArchived: true })?.sessionId).toBe('a-archived');
  });
});

describe('SessionIndex — cache behaviour', () => {
  it('does not write any index file to disk', () => {
    writeMeta('s1', { createdAt: 1000 });
    const before = fs.readdirSync(dataDir).sort();

    createSessionIndex(dataDir).list();

    expect(fs.readdirSync(dataDir).sort()).toEqual(before);
    // sessions/ contains only session dirs, no shared index artifact
    const sessionsDirEntries = fs.readdirSync(path.join(dataDir, 'sessions'));
    expect(sessionsDirEntries).toEqual(['s1']);
  });

  it('upsert adds an entry without touching disk', () => {
    const index = createSessionIndex(dataDir);
    expect(index.list()).toEqual([]);

    const entry = {
      sessionId: 's1',
      sessionDir: path.join(dataDir, 'sessions', 's1'),
      meta: {
        sessionId: 's1',
        workspace: '/repo-a',
        firstInput: null,
        createdAt: 1000,
        lastActiveAt: 1000,
      },
    };
    index.upsert(entry);

    expect(index.get('s1')?.sessionId).toBe('s1');
    expect(fs.existsSync(path.join(dataDir, 'sessions'))).toBe(false);
  });

  it('upsert replaces an existing entry and keeps sort order', () => {
    writeMeta('s1', { createdAt: 1000 });
    writeMeta('s2', { createdAt: 2000 });

    const index = createSessionIndex(dataDir);
    const target = index.get('s1')!;
    index.upsert({ ...target, meta: { ...target.meta, createdAt: 5000 } });

    expect(index.list().map(e => e.sessionId)).toEqual(['s1', 's2']);
  });

  it('invalidates so sessions created by other processes become visible', () => {
    writeMeta('s1', { createdAt: 1000 });
    const index = createSessionIndex(dataDir);
    expect(index.list()).toHaveLength(1);

    // Simulate another CLI instance creating a session.
    writeMeta('s2', { createdAt: 2000 });
    expect(index.list()).toHaveLength(1);

    index.invalidate();
    expect(index.list().map(e => e.sessionId)).toEqual(['s2', 's1']);
  });
});

describe('SessionIndex — workspace matching (multi-workspace + normalization)', () => {
  it('matches a session through any of its workspaces entries (A or B hit, C misses)', () => {
    writeMeta('multi', {
      workspace: '/repo-a',
      workspaces: [
        { path: '/repo-a', slug: 'repo-a' },
        { path: '/repo-b', slug: 'repo-b' },
      ],
      createdAt: 1000,
    });

    const index = createSessionIndex(dataDir);
    expect(index.list({ workspace: '/repo-a' }).map(e => e.sessionId)).toEqual(['multi']);
    expect(index.list({ workspace: '/repo-b' }).map(e => e.sessionId)).toEqual(['multi']);
    expect(index.list({ workspace: '/repo-c' })).toEqual([]);
    // latestForWorkspace shares the same matching rule.
    expect(index.latestForWorkspace('/repo-a')?.sessionId).toBe('multi');
    expect(index.latestForWorkspace('/repo-b')?.sessionId).toBe('multi');
    expect(index.latestForWorkspace('/repo-c')).toBeNull();
  });

  it('falls back to the single workspace field for legacy meta without workspaces', () => {
    writeMeta('legacy', { workspace: '/repo-a', createdAt: 1000 });
    const index = createSessionIndex(dataDir);
    expect(index.list({ workspace: '/repo-a' }).map(e => e.sessionId)).toEqual(['legacy']);
    expect(index.list({ workspace: '/repo-b' })).toEqual([]);
  });

  it('normalizes symlink spellings on both sides of the comparison', () => {
    const real = path.join(dataDir, 'real-repo');
    fs.mkdirSync(real, { recursive: true });
    const alias = path.join(dataDir, 'alias-repo');
    fs.symlinkSync(real, alias);

    // Stored as the real path, queried through the symlink.
    writeMeta('stored-real', { workspace: real, createdAt: 1000 });
    // Stored as the symlink, queried through the real path.
    writeMeta('stored-alias', { workspace: alias, createdAt: 2000 });
    // Stored with a trailing slash, queried without one.
    writeMeta('stored-slash', { workspace: `${real}/`, createdAt: 3000 });

    const index = createSessionIndex(dataDir);
    expect(index.list({ workspace: alias }).map(e => e.sessionId).sort()).toEqual(
      ['stored-alias', 'stored-real', 'stored-slash'],
    );
    expect(index.list({ workspace: real }).map(e => e.sessionId).sort()).toEqual(
      ['stored-alias', 'stored-real', 'stored-slash'],
    );
    expect(index.list({ workspace: `${alias}/` }).map(e => e.sessionId).sort()).toEqual(
      ['stored-alias', 'stored-real', 'stored-slash'],
    );
  });

  it('keeps newest-first ordering when several sessions match one workspace', () => {
    writeMeta('older', { workspace: '/repo-a', createdAt: 1000, lastActiveAt: 1000 });
    writeMeta('newer', { workspace: '/repo-a', createdAt: 3000, lastActiveAt: 3000 });
    writeMeta('middle', { workspace: '/repo-a', createdAt: 2000, lastActiveAt: 2000 });

    const index = createSessionIndex(dataDir);
    expect(index.list({ workspace: '/repo-a' }).map(e => e.sessionId)).toEqual(['newer', 'middle', 'older']);
    expect(index.latestForWorkspace('/repo-a')?.sessionId).toBe('newer');
  });
});
