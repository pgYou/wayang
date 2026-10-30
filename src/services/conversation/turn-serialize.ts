/**
 * JSON-safe serialization of TurnView for the RPC layer (WebUI / audit).
 *
 * Long texts are truncated with an explicit marker; every truncated field has
 * a matching `*Truncated` boolean so clients can distinguish "short" from
 * "cut off". These shapes are wire types — they must stay plain-JSON
 * serializable (no Map, no class instances).
 */

import type { TurnUsage, TurnView } from '@/types/conversation';

/** Default truncation limit for step / user / signal text. */
export const DEFAULT_TURN_TEXT_LIMIT = 2000;

export interface TurnTextLimits {
  maxTextLength?: number;
}

export interface SerializedStep {
  uuid: string;
  stepIndex?: number;
  timestamp: string;
  content: string;
  contentTruncated: boolean;
  reasoning?: string;
  reasoningTruncated?: boolean;
  finishReason?: string;
  model?: TurnView['steps'][number]['model'];
  timing?: TurnView['steps'][number]['timing'];
  requestId?: string;
  usage?: TurnView['steps'][number]['message']['usage'];
  toolCallCount: number;
  toolResultCount: number;
}

export interface SerializedSignal {
  uuid: string;
  subtype: string;
  signalId?: string;
  workerId?: string;
  taskId?: string;
  taskTitle: string;
  timestamp: string;
  content: string;
  contentTruncated: boolean;
}

export interface SerializedTurn {
  turnId: string;
  rootTurnId?: string;
  actor?: TurnView['actor'];
  startedAt?: string;
  endedAt?: string;
  status: TurnView['status'];
  userEntry?: { uuid: string; timestamp: string; content: string; contentTruncated: boolean };
  steps: SerializedStep[];
  signals: SerializedSignal[];
  toolCalls: TurnView['toolCalls'];
  usage: TurnUsage;
  entryIds: string[];
}

export interface TurnSummary {
  turnId: string;
  rootTurnId?: string;
  actor?: TurnView['actor'];
  startedAt?: string;
  endedAt?: string;
  status: TurnView['status'];
  usage: TurnUsage;
  stepCount: number;
  signalCount: number;
  toolCallCount: number;
  entryCount: number;
  userPreview?: string;
  userPreviewTruncated?: boolean;
}

function cut(text: string | undefined, limit: number): { value: string; truncated: boolean } {
  if (text === undefined) return { value: '', truncated: false };
  if (text.length <= limit) return { value: text, truncated: false };
  return { value: `${text.slice(0, limit)}…[truncated]`, truncated: true };
}

/** Serialize a full TurnView with truncated long texts. */
export function serializeTurnView(view: TurnView, limits: TurnTextLimits = {}): SerializedTurn {
  const textLimit = limits.maxTextLength ?? DEFAULT_TURN_TEXT_LIMIT;

  return {
    turnId: view.turnId,
    ...(view.rootTurnId !== undefined && { rootTurnId: view.rootTurnId }),
    ...(view.actor !== undefined && { actor: view.actor }),
    ...(view.startedAt !== undefined && { startedAt: view.startedAt }),
    ...(view.endedAt !== undefined && { endedAt: view.endedAt }),
    status: view.status,
    ...(view.userEntry !== undefined && (() => {
      const u = cut(view.userEntry.message?.content, textLimit);
      return {
        userEntry: {
          uuid: view.userEntry.uuid,
          timestamp: view.userEntry.timestamp,
          content: u.value,
          contentTruncated: u.truncated,
        },
      };
    })()),
    steps: view.steps.map(step => {
      const content = cut(step.message?.content, textLimit);
      const reasoning = step.message?.reasoning !== undefined
        ? cut(step.message.reasoning, textLimit)
        : undefined;
      return {
        uuid: step.uuid,
        ...(step.stepIndex !== undefined && { stepIndex: step.stepIndex }),
        timestamp: step.timestamp,
        content: content.value,
        contentTruncated: content.truncated,
        ...(reasoning !== undefined && {
          reasoning: reasoning.value,
          reasoningTruncated: reasoning.truncated,
        }),
        ...(step.finishReason !== undefined && { finishReason: step.finishReason }),
        ...(step.model !== undefined && { model: step.model }),
        ...(step.timing !== undefined && { timing: step.timing }),
        ...(step.requestId !== undefined && { requestId: step.requestId }),
        ...(step.message?.usage !== undefined && { usage: step.message.usage }),
        toolCallCount: step.toolCalls?.length ?? 0,
        toolResultCount: step.toolResults?.length ?? 0,
      };
    }),
    signals: view.signals.map(sig => {
      const c = cut(sig.content, textLimit);
      return {
        uuid: sig.uuid,
        subtype: sig.subtype,
        ...(sig.signalId !== undefined && { signalId: sig.signalId }),
        ...(sig.workerId !== undefined && { workerId: sig.workerId }),
        ...(sig.taskId !== undefined && { taskId: sig.taskId }),
        taskTitle: sig.taskTitle,
        timestamp: sig.timestamp,
        content: c.value,
        contentTruncated: c.truncated,
      };
    }),
    toolCalls: view.toolCalls,
    usage: view.usage,
    entryIds: view.entryIds,
  };
}

/** Compact turn header for list responses. */
export function summarizeTurn(view: TurnView, limits: TurnTextLimits = {}): TurnSummary {
  const previewLimit = Math.min(limits.maxTextLength ?? 200, 200);
  const preview = view.userEntry !== undefined
    ? cut(view.userEntry.message?.content, previewLimit)
    : undefined;
  return {
    turnId: view.turnId,
    ...(view.rootTurnId !== undefined && { rootTurnId: view.rootTurnId }),
    ...(view.actor !== undefined && { actor: view.actor }),
    ...(view.startedAt !== undefined && { startedAt: view.startedAt }),
    ...(view.endedAt !== undefined && { endedAt: view.endedAt }),
    status: view.status,
    usage: view.usage,
    stepCount: view.steps.length,
    signalCount: view.signals.length,
    toolCallCount: view.toolCalls.length,
    entryCount: view.entryIds.length,
    ...(preview !== undefined && {
      userPreview: preview.value,
      userPreviewTruncated: preview.truncated,
    }),
  };
}
