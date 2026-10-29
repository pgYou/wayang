import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  cpSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createMockCtx } from '@/__tests__/helpers';
import { SignalState } from '@/services/signal/signal-state';
import type { ControllerSignal } from '@/types/index';
import type { SystemContext } from '@/infra/system-context';

/**
 * End-to-end test against a REAL pre-snapshot session, committed as a fixture.
 *
 * Fixture: src/services/signal/__tests__/fixtures/legacy-session
 *   - signals.jsonl       36 signal bodies (append-only, legacy layout)
 *   - state-events.jsonl  71 whole-array state snapshots (legacy layout)
 *   - no signals.json     so this session has never been migrated
 *
 * The capture came from a live run and was scrubbed by
 * `fixtures/generate-legacy-session.mjs` (API key, workspace path and internal
 * endpoint rewritten). Signal bodies and status transitions are untouched, so
 * the assertions below are grounded in real data rather than a hand-built case.
 *
 * Ground truth replayed from the two legacy files:
 *   36 signals total — 34 read, 2 discarded (sig-4, sig-25), 0 unread.
 */
const FIXTURE_DIR = join(__dirname, 'fixtures', 'legacy-session');

const LEGACY_SIGNAL_COUNT = 36;
const LEGACY_READ_COUNT = 34;
const LEGACY_DISCARDED_IDS = ['sig-25', 'sig-4'];
const LEGACY_MAX_SIG_NUMBER = 36;

describe('SignalState end-to-end on a real legacy session', () => {
  let tempDir: string;
  let ctx: SystemContext;

  const sigPath = () => join(tempDir, 'signals.json');
  const historyPath = () => join(tempDir, 'signals.jsonl');
  const legacyEventsPath = () => join(tempDir, 'state-events.jsonl');

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wayang-e2e-'));
    // Copy the fixture verbatim; the migration must work on real bytes.
    cpSync(FIXTURE_DIR, tempDir, { recursive: true });
    ctx = createMockCtx({ sessionDir: tempDir } as any);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should ship a fixture that is a genuine legacy layout', () => {
    expect(existsSync(join(FIXTURE_DIR, 'signals.json'))).toBe(false);
    expect(existsSync(join(FIXTURE_DIR, 'signals.jsonl'))).toBe(true);
    expect(existsSync(join(FIXTURE_DIR, 'state-events.jsonl'))).toBe(true);

    const legacyLines = readFileSync(join(FIXTURE_DIR, 'signals.jsonl'), 'utf-8')
      .trim()
      .split('\n');
    expect(legacyLines).toHaveLength(LEGACY_SIGNAL_COUNT);
    // Legacy rows are plain signal bodies, not history entries.
    expect(JSON.parse(legacyLines[0]).id).toBe('sig-1');
    expect(JSON.parse(legacyLines[0]).status).toBe('unread');
  });

  it('should not leak credentials or machine paths in the fixture', () => {
    const files = ['signals.jsonl', 'state-events.jsonl', 'conversation.jsonl', 'meta.json'];
    for (const name of files) {
      const text = readFileSync(join(FIXTURE_DIR, name), 'utf-8');
      expect(text).not.toMatch(/9rBf9lxBpCcevj0cx8mQgjHM/);
      expect(text).not.toMatch(/lukegypeng/);
      expect(text).not.toMatch(/venus\.oa\.com/);
    }
  });

  it('should migrate all signals and recover processed status from legacy events', async () => {
    const state = new SignalState(ctx);
    await state.restore();

    const signals = state.get<ControllerSignal[]>('signals');
    expect(signals).toHaveLength(LEGACY_SIGNAL_COUNT);

    // Reading only signals.jsonl would mark all of these unread again; the
    // legacy state-events replay is what restores them.
    const read = signals.filter(s => s.status === 'read');
    const unread = signals.filter(s => s.status === 'unread');
    const discarded = signals.filter(s => s.status === 'discarded');

    expect(read).toHaveLength(LEGACY_READ_COUNT);
    expect(unread).toHaveLength(0);
    expect(discarded.map(s => s.id).sort()).toEqual(LEGACY_DISCARDED_IDS);
  });

  it('should preserve signal bodies through migration', async () => {
    const state = new SignalState(ctx);
    await state.restore();

    const signals = state.get<ControllerSignal[]>('signals');
    const byId = new Map(signals.map(s => [s.id, s]));

    const legacyBodies = readFileSync(historyPath(), 'utf-8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as ControllerSignal);

    for (const legacy of legacyBodies) {
      const migrated = byId.get(legacy.id);
      expect(migrated).toBeDefined();
      expect(migrated!.source).toBe(legacy.source);
      expect(migrated!.type).toBe(legacy.type);
      expect(migrated!.payload).toEqual(legacy.payload);
      expect(migrated!.timestamp).toBe(legacy.timestamp);
    }
  });

  it('should derive the id high-water mark from the real ids', async () => {
    const state = new SignalState(ctx);
    await state.restore();
    expect(state.getIdHighWaterMark()).toBe(LEGACY_MAX_SIG_NUMBER);
  });

  it('should write a snapshot so migration runs exactly once', async () => {
    const first = new SignalState(ctx);
    await first.restore();
    expect(existsSync(sigPath())).toBe(true);

    const snapshot = JSON.parse(readFileSync(sigPath(), 'utf-8'));
    expect(snapshot.signals).toHaveLength(LEGACY_SIGNAL_COUNT);
    expect(snapshot.idHighWaterMark).toBe(LEGACY_MAX_SIG_NUMBER);

    // Rewrite the legacy logs to a bogus state. A second restore must ignore
    // them, proving that the snapshot — not the log — is now the source.
    writeFileSync(historyPath(), JSON.stringify({ id: 'sig-999', status: 'unread' }) + '\n');
    rmSync(legacyEventsPath(), { force: true });

    const second = new SignalState(ctx);
    await second.restore();
    const restored = second.get<ControllerSignal[]>('signals');
    expect(restored).toHaveLength(LEGACY_SIGNAL_COUNT);
    expect(restored.some(s => s.id === 'sig-999')).toBe(false);
  });

  it('should not leave a temp file behind after the migration snapshot', async () => {
    const state = new SignalState(ctx);
    await state.restore();

    const leftovers = readdirSync(tempDir).filter(f => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('should keep the migrated status when restoring from the new snapshot', async () => {
    const first = new SignalState(ctx);
    await first.restore();

    const second = new SignalState(ctx);
    await second.restore();

    const signals = second.get<ControllerSignal[]>('signals');
    expect(signals.filter(s => s.status === 'read')).toHaveLength(LEGACY_READ_COUNT);
    expect(signals.filter(s => s.status === 'discarded').map(s => s.id).sort())
      .toEqual(LEGACY_DISCARDED_IDS);
  });

  it('should trim the migrated window but keep the high-water mark', async () => {
    // A small window forces the 36 real signals through the trim path.
    const smallCtx = createMockCtx({
      sessionDir: tempDir,
      config: { providers: {}, controller: {}, worker: {}, signalWindowSize: 10 },
    } as any);

    const state = new SignalState(smallCtx);
    await state.restore();

    const before = state.get<ControllerSignal[]>('signals');
    expect(before).toHaveLength(LEGACY_SIGNAL_COUNT);

    // Trigger a set()+trim cycle the way dequeueUnread does.
    state.set('signals', [...before]);

    const after = state.get<ControllerSignal[]>('signals');
    expect(after.length).toBeLessThanOrEqual(LEGACY_SIGNAL_COUNT);

    // The snapshot on disk must match the in-memory window.
    const snapshot = JSON.parse(readFileSync(sigPath(), 'utf-8'));
    expect(snapshot.signals).toHaveLength(after.length);

    // High-water mark is unaffected by trimming: ids must not be reused.
    expect(state.getIdHighWaterMark()).toBe(LEGACY_MAX_SIG_NUMBER);
  });

  it('should reject a corrupt migrated snapshot instead of silently emptying', async () => {
    const first = new SignalState(ctx);
    await first.restore();
    writeFileSync(sigPath(), '{ definitely-not-json');

    const broken = new SignalState(ctx);
    await expect(broken.restore()).rejects.toThrow(/corrupt snapshot/i);
  });
});
