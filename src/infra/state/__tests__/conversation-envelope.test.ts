import { describe, it, expect } from 'vitest';
import { applyAppendEnvelope, ENVELOPE_VERSION } from '@/infra/state/conversation-envelope';
import type { ConversationEntry, SystemEntry, UserEntry } from '@/types/index';
import { EEntryType, ESystemSubtype } from '@/types/index';

const makeUser = (uuid: string): UserEntry => ({
  type: EEntryType.User,
  uuid,
  parentUuid: null,
  sessionId: 's1',
  timestamp: new Date().toISOString(),
  message: { role: 'user', content: 'hi' },
});

const makeCompactMarker = (uuid: string): SystemEntry => ({
  type: EEntryType.System,
  uuid,
  parentUuid: null,
  sessionId: 's1',
  timestamp: new Date().toISOString(),
  subtype: ESystemSubtype.Compact,
  content: 'summary',
  compactMeta: { summarizedTokenCount: 10 },
});

describe('applyAppendEnvelope (shared single source of truth)', () => {
  it('stamps v=1 and parentId=null on the first entry of a chain', () => {
    const entry = applyAppendEnvelope(makeUser('u1'), []);
    expect(entry.v).toBe(ENVELOPE_VERSION);
    expect(entry.parentId).toBeNull();
  });

  it('chains parentId to the previous entry uuid', () => {
    const u1 = makeUser('u1');
    const u2 = applyAppendEnvelope(makeUser('u2'), [u1]);
    expect(u2.parentId).toBe('u1');
    expect(u2.v).toBe(ENVELOPE_VERSION);
  });

  it('does not overwrite an existing v', () => {
    const entry = makeUser('u1');
    (entry as any).v = 7;
    applyAppendEnvelope(entry, []);
    expect(entry.v).toBe(7);
  });

  it('does not overwrite a caller-set parentId (explicit null included)', () => {
    const u1 = makeUser('u1');
    const u2 = applyAppendEnvelope({ ...makeUser('u2'), parentId: null }, [u1]);
    const u3 = applyAppendEnvelope({ ...makeUser('u3'), parentId: 'custom-parent' }, [u1, u2]);
    expect(u2.parentId).toBeNull();
    expect(u3.parentId).toBe('custom-parent');
  });

  it('anchors the compact marker itself to null', () => {
    const u1 = makeUser('u1');
    const marker = applyAppendEnvelope(makeCompactMarker('c1'), [u1]);
    expect(marker.parentId).toBeNull();
  });

  it('anchors the first entry after a compact marker to null (new chain)', () => {
    const marker = makeCompactMarker('c1');
    const next = applyAppendEnvelope(makeUser('u2'), [marker]);
    expect(next.parentId).toBeNull();
  });

  it('chains normally after a non-marker system entry', () => {
    const sys: ConversationEntry = {
      type: EEntryType.System,
      uuid: 'sys1',
      parentUuid: null,
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      subtype: ESystemSubtype.Error,
      content: 'boom',
    };
    const next = applyAppendEnvelope(makeUser('u2'), [sys]);
    expect(next.parentId).toBe('sys1');
  });

  it('is idempotent: stamping an already stamped entry changes nothing', () => {
    const u1 = makeUser('u1');
    const conversation: ConversationEntry[] = [u1];
    const u2 = applyAppendEnvelope(makeUser('u2'), conversation);
    expect(u2.parentId).toBe('u1');
    // Re-stamping the already-stamped entry (e.g. a second layer applying the
    // same shared function) must be a no-op — caller-set values win.
    applyAppendEnvelope(u2, conversation);
    expect(u2.parentId).toBe('u1');
    expect(u2.v).toBe(ENVELOPE_VERSION);
  });

  it('passes non-object entries through untouched', () => {
    const raw = applyAppendEnvelope('raw-string' as unknown as ConversationEntry, []);
    expect(raw).toBe('raw-string');
  });
});
