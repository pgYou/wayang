/**
 * Turn-boundary prompt + result assembly for the ACP turn loop (#56).
 * Pure helpers kept out of acp-worker-run.ts so that file stays under 500 lines.
 */

import type { WorkerResult } from '@/types/index';
import type { ConversationEntry } from '@/types/conversation';
import { EEntryType } from '@/types/index';
import { generateId } from '@/utils/id';
import { nowISO } from '@/utils/time';
import {
  buildDenialNotice, turnEndErrorText,
  type TurnDenial, type TurnEndCategory, type TurnNextAction,
} from './turn-attribution';

/** All queued controller messages in ONE delivery, each prefixed, '\n---\n'-separated. */
export function joinControllerMessages(messages: string[]): string {
  return messages.map((m) => `[Controller message] ${m}`).join('\n---\n');
}

/** Reissue prompt: the denial notice first, then any queued controller messages. */
export function buildReissuePrompt(denials: TurnDenial[], delivery: string): string {
  const notice = buildDenialNotice(denials);
  return delivery ? `${notice}\n\n${delivery}` : notice;
}

/**
 * Call-site double insurance (#56): a reissue whose denial notice comes back
 * empty would inject a notice-free prompt. Downgrade it to a terminal result
 * instead of emitting that bad round.
 */
export function finalizeTurnVerdict(verdict: TurnNextAction, denials: TurnDenial[]): TurnNextAction {
  if (verdict.action !== 'reissue' || buildDenialNotice(denials) !== '') return verdict;
  const tool = denials[0]?.toolName ?? 'unknown';
  return { action: 'terminate', reason: `non-injectable denial: ${tool}` };
}

/** A system-actor transcript entry for an injected reissue/delivery prompt (#56). */
export function makeInjectedEntry(text: string, kind: 'acp-denial-notice' | 'controller-delivery', sessionId: string): ConversationEntry {
  const ts = nowISO();
  return {
    type: EEntryType.User,
    uuid: generateId('u'),
    parentUuid: null,
    sessionId,
    timestamp: ts,
    actor: { kind: 'system', id: 'engine' },
    endedAt: ts,
    message: { role: 'user', content: text },
    metadata: { injected: kind },
  } as ConversationEntry;
}

/** Reasons decideNextAction attributes to the CATEGORY itself (the rest are guard limits). */
const CATEGORY_REASONS = new Set(['Aborted', 'request timed out', 'agent ended the turn unexpectedly']);

/** Terminal WorkerResult. Guard-limit terminations carry their specific reason. */
export function makeTerminalResult(
  category: TurnEndCategory,
  verdictReason: string | undefined,
  denials: TurnDenial[],
  summary: string,
  stopReason: string,
): WorkerResult {
  const guardReason = verdictReason !== undefined && !CATEGORY_REASONS.has(verdictReason) ? verdictReason : undefined;
  if (category === 'completed' && guardReason === undefined) return { status: 'completed', summary };
  const base = turnEndErrorText(category, denials, { stopReason });
  const error = guardReason !== undefined
    ? (base ? `${base} — ${guardReason}` : guardReason)
    : (base || 'ACP worker ended the turn unexpectedly');
  return { status: 'failed', error };
}
