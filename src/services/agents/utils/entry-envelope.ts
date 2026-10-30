/**
 * Turn-lineage helpers for conversation entries.
 *
 * The mechanical append-time fields (`v`, `parentId`, including the
 * compaction-boundary rule) live in the shared infra module
 * `@/infra/state/conversation-envelope` (applyAppendEnvelope) — the single
 * source of truth invoked by BaseWayangState.append. This module only
 * carries the producer-context concerns:
 *  - applyTurnEnvelope: turn lineage (turnId/rootTurnId/causationId/actor),
 *    which requires producer context (controller run, worker run).
 *  - syncStepTimestamps: mirroring AssistantEntry step timing into the
 *    envelope timestamps.
 */

import type { AssistantEntry, ConversationEntry, EntryActor } from '@/types/index';
import { EEntryType } from '@/types/index';

/** Turn lineage applied to every entry produced within one agent activation. */
export interface TurnEnvelope {
  turnId: string;
  rootTurnId?: string;
  causationId?: string;
  actor?: EntryActor;
}

/**
 * Stamp turn lineage on an entry. Fields already present on the entry are not
 * overwritten (the producer may have set a more specific value, e.g. a signal
 * entry keeping the originating worker's lineage).
 *
 * Mutates and returns the same entry object.
 */
export function applyTurnEnvelope<T extends ConversationEntry>(entry: T, env: TurnEnvelope | undefined): T {
  if (!env) return entry;
  if (entry.turnId === undefined) entry.turnId = env.turnId;
  if (entry.rootTurnId === undefined && env.rootTurnId !== undefined) entry.rootTurnId = env.rootTurnId;
  if (entry.causationId === undefined && env.causationId !== undefined) entry.causationId = env.causationId;
  if (entry.actor === undefined && env.actor !== undefined) entry.actor = env.actor;
  return entry;
}

/**
 * Mirror an AssistantEntry's step timing into the envelope timestamps, so
 * `startedAt`/`endedAt` are present on the entry itself without duplicating
 * values at the call sites.
 */
export function syncStepTimestamps(entry: AssistantEntry): void {
  if (entry.type !== EEntryType.Assistant) return;
  if (entry.timing?.startedAt !== undefined) entry.startedAt = entry.timing.startedAt;
  if (entry.timing?.endedAt !== undefined) entry.endedAt = entry.timing.endedAt;
}
