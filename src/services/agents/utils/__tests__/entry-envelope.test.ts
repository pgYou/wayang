import { describe, it, expect } from 'vitest';
import { applyTurnEnvelope, syncStepTimestamps } from '@/services/agents/utils/entry-envelope';
import type { AssistantEntry, UserEntry } from '@/types/index';
import { EEntryType } from '@/types/index';

const makeUser = (uuid: string): UserEntry => ({
  type: EEntryType.User,
  uuid,
  parentUuid: null,
  sessionId: 's1',
  timestamp: new Date().toISOString(),
  message: { role: 'user', content: 'hi' },
});

describe('applyTurnEnvelope', () => {
  const env = {
    turnId: 'T1',
    rootTurnId: 'R1',
    causationId: 'sig-1',
    actor: { kind: 'controller' as const, id: 'ctrl' },
  };

  it('fills turn lineage on a bare entry', () => {
    const entry = applyTurnEnvelope(makeUser('u1'), env);
    expect(entry.turnId).toBe('T1');
    expect(entry.rootTurnId).toBe('R1');
    expect(entry.causationId).toBe('sig-1');
    expect(entry.actor).toEqual({ kind: 'controller', id: 'ctrl' });
  });

  it('never overwrites fields the producer already set', () => {
    const base = makeUser('u1');
    base.turnId = 'OWN';
    base.rootTurnId = 'OWN-ROOT';
    base.causationId = 'OWN-CAUSE';
    base.actor = { kind: 'worker', id: 'w1', taskId: 't1' };
    const entry = applyTurnEnvelope(base, env);
    expect(entry.turnId).toBe('OWN');
    expect(entry.rootTurnId).toBe('OWN-ROOT');
    expect(entry.causationId).toBe('OWN-CAUSE');
    expect(entry.actor).toEqual({ kind: 'worker', id: 'w1', taskId: 't1' });
  });

  it('is a no-op without an envelope', () => {
    const entry = applyTurnEnvelope(makeUser('u1'), undefined);
    expect(entry.turnId).toBeUndefined();
  });
});

describe('syncStepTimestamps', () => {
  it('mirrors timing into envelope timestamps', () => {
    const entry: AssistantEntry = {
      type: EEntryType.Assistant,
      uuid: 'a1',
      parentUuid: null,
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: 'x' },
      timing: { startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:01.000Z', durationMs: 1000 },
    };
    syncStepTimestamps(entry);
    expect(entry.startedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(entry.endedAt).toBe('2026-01-01T00:00:01.000Z');
  });

  it('leaves entries without timing untouched', () => {
    const entry: AssistantEntry = {
      type: EEntryType.Assistant,
      uuid: 'a1',
      parentUuid: null,
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: 'x' },
    };
    syncStepTimestamps(entry);
    expect(entry.startedAt).toBeUndefined();
    expect(entry.endedAt).toBeUndefined();
  });
});
