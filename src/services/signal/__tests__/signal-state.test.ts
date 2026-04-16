import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
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

  it('should initialize with empty signals', () => {
    expect(state.get('signals')).toEqual([]);
  });

  it('should append signals', () => {
    state.append('signals', makeSig('s1'));
    state.append('signals', makeSig('s2'));
    expect(state.get('signals')).toHaveLength(2);
  });

  it('should update signal status in memory', () => {
    state.append('signals', makeSig('s1'));
    const sigs = state.get('signals') as ControllerSignal[];
    sigs[0].status = 'read';
    state.set('signals', sigs);
    expect((state.get('signals') as ControllerSignal[])[0].status).toBe('read');
  });

  it('should persist to JSONL on append', async () => {
    state.append('signals', makeSig('s1'));

    const state2 = new SignalState(ctx);
    await state2.restore();
    expect(state2.get('signals')).toHaveLength(1);
  });

  it('should restore signals from JSONL with status replayed via event sourcing', async () => {
    state.append('signals', makeSig('s1'));
    state.append('signals', makeSig('s2'));

    const sigs = state.get('signals') as ControllerSignal[];
    sigs[0].status = 'read';
    state.set('signals', [...sigs]);

    const state2 = new SignalState(ctx);
    await state2.restore();
    const restored = state2.get('signals') as ControllerSignal[];
    expect(restored).toHaveLength(2);
    expect(restored.find(s => s.id === 's1')!.status).toBe('read');
    expect(restored.find(s => s.id === 's2')!.status).toBe('unread');
  });

  // --- Event sourcing tests ---

  it('should record state events on append', () => {
    state.append('signals', makeSig('sig-1'));

    const events = state.getStateEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('append');
    expect(events[0].path).toBe('signals');
    expect(events[0].signalId).toBe('sig-1');
  });

  it('should record multiple state events', () => {
    state.append('signals', makeSig('sig-1'));
    state.append('signals', makeSig('sig-2'));
    state.set('signals', [makeSig('sig-1')]);

    const events = state.getStateEvents();
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('append');
    expect(events[1].type).toBe('append');
    expect(events[2].type).toBe('set');
  });

  it('should filter events by signal ID', () => {
    state.append('signals', makeSig('sig-1'));
    state.append('signals', makeSig('sig-2'));

    const sig1Events = state.getEventsBySignalId('sig-1');
    expect(sig1Events).toHaveLength(1);
    expect(sig1Events[0].signalId).toBe('sig-1');

    const sig2Events = state.getEventsBySignalId('sig-2');
    expect(sig2Events).toHaveLength(1);
    expect(sig2Events[0].signalId).toBe('sig-2');
  });

  it('should filter events by type', () => {
    state.append('signals', makeSig('sig-1'));
    state.append('signals', makeSig('sig-2'));
    state.set('signals', [makeSig('sig-1')]);

    const appendEvents = state.getEventsByType('append');
    expect(appendEvents).toHaveLength(2);

    const setEvents = state.getEventsByType('set');
    expect(setEvents).toHaveLength(1);
  });

  it('should persist state events to JSONL', async () => {
    state.append('signals', makeSig('sig-1'));

    const state2 = new SignalState(ctx);
    await state2.restore();

    const events = state2.getStateEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('append');
  });

  it('should restore state events with signal count logged', async () => {
    state.append('signals', makeSig('sig-1'));

    const state2 = new SignalState(ctx);
    await state2.restore();

    const restored = state2.get('signals') as ControllerSignal[];
    expect(restored).toHaveLength(1);
  });
});
