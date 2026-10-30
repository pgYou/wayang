/**
 * Shared conversation-envelope stamping — the single source of truth for the
 * mechanical envelope fields (`v`, `parentId`) written at append time.
 *
 * Both the infra layer (BaseWayangState.append, via its 'conversation' path)
 * and the concrete state classes (ControllerAgentState / WorkerState) rely on
 * this one function; there is no second implementation. The compaction
 * boundary rule (marker and first entry after it anchor to parentId=null) is
 * defined here and nowhere else.
 */

import type { ConversationEntry } from '@/types/index';
import { isCompactMarker } from '@/types/index';

/** Envelope schema version stamped on new writes. */
export const ENVELOPE_VERSION = 1;

/**
 * Stamp mechanical envelope fields on an entry about to be appended:
 *
 * - `v`: schema version, set to 1 when absent (never overwrites).
 * - `parentId`: uuid of the last entry in `conversation` — the real chain
 *   link. `null` when the array is empty, when the previous entry is a
 *   compaction marker, or when the entry itself is a marker: a compaction
 *   boundary starts a fresh chain (the marker and the first entry after it
 *   both anchor to null).
 *
 * Values the caller already set (including an explicit `parentId: null`) are
 * never overwritten. Non-object entries pass through untouched.
 *
 * Mutates and returns the same entry object. Idempotent: stamping an already
 * stamped entry is a no-op.
 */
export function applyAppendEnvelope<T extends ConversationEntry>(
  entry: T,
  conversation: ConversationEntry[],
): T {
  if (entry === null || typeof entry !== 'object') return entry;
  if (entry.v === undefined) entry.v = ENVELOPE_VERSION;
  if (entry.parentId === undefined) {
    const last = conversation.length > 0 ? conversation[conversation.length - 1] : undefined;
    const lastIsMarker = last !== null && typeof last === 'object' && isCompactMarker(last as ConversationEntry);
    entry.parentId =
      !last || lastIsMarker || isCompactMarker(entry) || typeof (last as ConversationEntry).uuid !== 'string'
        ? null
        : (last as ConversationEntry).uuid;
  }
  return entry;
}
