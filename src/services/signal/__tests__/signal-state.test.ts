import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createMockCtx } from '@/__tests__/helpers';
import { SignalState } from '@/services/signal/signal-state';
import type { ControllerSignal } from '@/types/index';
import type { SystemContext } from '@/infra/system-context';

describe('SignalState', () => {
  let tempDir: string;
  let state: SignalState;
  let ctx: SystemContext;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wayang-test-'));
    ctx = createMockCtx({ sessionDir: tempDir } as any);
    state = new SignalState(ctx);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const makeSig = (id: string): ControllerSignal => ({
    id,
    status: 'unread',
    source: 'user',
    type: 'input',
    payload: { text: `sig ${id}` },
    timestamp: Date.now(),
  });

  const sigPath = () => join(tempDir, 'signals.json');
  const historyPath = () => join(tempDir, 'signals.jsonl');

  it('should initialize with empty signals and zero high-water mark', () => {
    expect(state.get('signals')).toEqual([]);
    expect(state.getIdHighWaterMark()).toBe(0);
  });

  it('should append signals into the window', () => {
    state.append('signals', makeSig('s1'));
    state.append('signals', makeSig('s2'));
    expect(state.get('signals')).toHaveLength(2);
  });

  // --- Snapshot persistence ---

  it('should persist appends to signals.json', () => {
    state.append('signals', makeSig('s1'));
    expect(existsSync(sigPath())).toBe(true);
    const raw = JSON.parse(readFileSync(sigPath(), 'utf-8'));
    expect(raw.signals).toHaveLength(1);
  });

  it('should restore window from snapshot only', async () => {
    state.append('signals', makeSig('s1'));

    const state2 = new SignalState(ctx);
    await state2.restore();
    expect(state2.get('signals')).toHaveLength(1);
  });

  it('should restore read/discarded status from snapshot without replaying history', async () => {
    state.append('signals', makeSig('s1'));
    state.append('signals', makeSig('s2'));

    const sigs = state.get<ControllerSignal[]>('signals');
    sigs[0].status = 'read';
    state.set('signals', [...sigs]);

    // Delete history: recovery must still work, because the snapshot carries it.
    rmSync(historyPath(), { force: true });

    const state2 = new SignalState(ctx);
    await state2.restore();
    const restored = state2.get<ControllerSignal[]>('signals');
    expect(restored).toHaveLength(2);
    expect(restored.find(s => s.id === 's1')!.status).toBe('read');
    expect(restored.find(s => s.id === 's2')!.status).toBe('unread');
  });

  it('should persist and restore the id high-water mark', async () => {
    state.setIdHighWaterMark(42);
    state.commit();

    const state2 = new SignalState(ctx);
    await state2.restore();
    expect(state2.getIdHighWaterMark()).toBe(42);
  });

  it('should throw on a corrupt snapshot instead of restoring empty state', async () => {
    state.append('signals', makeSig('s1'));
    writeFileSync(sigPath(), '{ corrupted');

    const state2 = new SignalState(ctx);
    await expect(state2.restore()).rejects.toThrow(/corrupt snapshot/i);
  });

  it('should quarantine a corrupt snapshot for inspection', async () => {
    state.append('signals', makeSig('s1'));
    writeFileSync(sigPath(), '{ corrupted');

    const state2 = new SignalState(ctx);
    await expect(state2.restore()).rejects.toThrow();
    const quarantined = readFileSync(sigPath(), 'utf-8').length;
    expect(quarantined).toBeGreaterThan(0);
  });

  it('should restore empty when neither snapshot nor history exists', async () => {
    const state2 = new SignalState(ctx);
    await state2.restore();
    expect(state2.get('signals')).toEqual([]);
    expect(state2.getIdHighWaterMark()).toBe(0);
  });

  // --- History (append-only, independent of the window) ---

  it('should record an enqueued entry with the full signal body', () => {
    const sig = makeSig('sig-1');
    state.recordEnqueued(sig);

    const history = state.readHistory();
    expect(history).toHaveLength(1);
    expect(history[0].signalId).toBe('sig-1');
    expect(history[0].status).toBe('enqueued');
    expect(history[0].signal?.payload).toEqual({ text: 'sig sig-1' });
  });

  it('should record status transitions with from/to', () => {
    const sig = makeSig('sig-1');
    state.recordEnqueued(sig);
    state.recordTransition('sig-1', 'unread', 'read');

    const history = state.getHistoryForSignal('sig-1');
    expect(history).toHaveLength(2);
    expect(history[1].status).toBe('read');
    expect(history[1].from).toBe('unread');
  });

  it('should keep history complete even when the window is trimmed', async () => {
    for (let i = 1; i <= 5; i++) {
      const sig = makeSig(`sig-${i}`);
      state.append('signals', sig);
      state.recordEnqueued(sig);
    }
    // Keep only the newest processed signal in the window.
    state.set('signals', [makeSig('sig-5')]);

    const history = state.readHistory();
    expect(history).toHaveLength(5);
    expect(history.map(e => e.signalId)).toEqual(['sig-1', 'sig-2', 'sig-3', 'sig-4', 'sig-5']);
  });

  it('should reconstruct an archived signal from history alone', () => {
    const sig = makeSig('sig-1');
    state.recordEnqueued(sig);
    state.recordTransition('sig-1', 'unread', 'read');
    state.recordTransition('sig-1', 'read', 'discarded');

    const archived = state.getArchivedSignal('sig-1');
    expect(archived).not.toBeNull();
    expect(archived!.signal.payload).toEqual({ text: 'sig sig-1' });
    expect(archived!.status).toBe('discarded');
  });

  it('should return null when archiving an unknown signal', () => {
    expect(state.getArchivedSignal('sig-404')).toBeNull();
  });

  it('should not let history corruption block state recovery', async () => {
    state.append('signals', makeSig('s1'));
    appendFileSync(historyPath(), 'torn line without newline');

    const state2 = new SignalState(ctx);
    await state2.restore();
    expect(state2.get('signals')).toHaveLength(1);
  });

  // --- Migration from legacy layout ---

  describe('legacy migration', () => {
    it('should migrate legacy signals and recover status from state-events', async () => {
      const legacySignals = [makeSig('sig-1'), makeSig('sig-2')];
      writeFileSync(
        historyPath(),
        legacySignals.map(s => JSON.stringify(s)).join('\n') + '\n',
      );
      // Legacy event log: a full-array snapshot marking sig-1 as read.
      const afterRead = legacySignals.map(s => ({ ...s, status: s.id === 'sig-1' ? 'read' : 'unread' }));
      writeFileSync(
        join(tempDir, 'state-events.jsonl'),
        JSON.stringify({ type: 'set', path: 'signals', timestamp: Date.now(), data: afterRead }) + '\n',
      );

      const migrated = new SignalState(ctx);
      await migrated.restore();

      const signals = migrated.get<ControllerSignal[]>('signals');
      expect(signals).toHaveLength(2);
      expect(signals.find(s => s.id === 'sig-1')!.status).toBe('read');
      expect(signals.find(s => s.id === 'sig-2')!.status).toBe('unread');
    });

    it('should derive the high-water mark from migrated signals', async () => {
      writeFileSync(
        historyPath(),
        JSON.stringify(makeSig('sig-7')) + '\n',
      );

      const migrated = new SignalState(ctx);
      await migrated.restore();
      expect(migrated.getIdHighWaterMark()).toBe(7);
    });

    it('should write a snapshot so migration runs only once', async () => {
      writeFileSync(historyPath(), JSON.stringify(makeSig('sig-1')) + '\n');

      const first = new SignalState(ctx);
      await first.restore();
      expect(existsSync(sigPath())).toBe(true);

      // Mutate the snapshot, then restore again: the legacy log must be ignored.
      const snapshot = JSON.parse(readFileSync(sigPath(), 'utf-8'));
      snapshot.signals = [makeSig('sig-9')];
      writeFileSync(sigPath(), JSON.stringify(snapshot));

      const second = new SignalState(ctx);
      await second.restore();
      expect(second.get<ControllerSignal[]>('signals').map(s => s.id)).toEqual(['sig-9']);
    });

    it('should not migrate when a snapshot already exists', async () => {
      writeFileSync(historyPath(), JSON.stringify(makeSig('sig-1')) + '\n');
      writeFileSync(sigPath(), JSON.stringify({ signals: [], idHighWaterMark: 5 }));

      const restored = new SignalState(ctx);
      await restored.restore();
      expect(restored.get('signals')).toEqual([]);
      expect(restored.getIdHighWaterMark()).toBe(5);
    });
  });
});
