// --- Conversation Entry (JSONL record) ---

// --- Enums ---

/** Conversation entry type discriminator. */
export enum EEntryType {
  /** User input from CLI. */
  User = 'user',
  /** LLM response — includes text, tool calls, and tool results from one step. */
  Assistant = 'assistant',
  /** System events — compaction markers. */
  System = 'system',
  /** Worker signals — progress/completed/failed notifications. */
  Signal = 'signal',
}

/** SystemEntry event kind. */
export enum ESystemSubtype {
  /** Compaction summary marker — all prior entries can be discarded on restore. */
  Compact = 'compact',
  /** LLM or system error surfaced to the user. */
  Error = 'error',
}

/** SignalEntry event kind — worker notifications delivered to Controller. */
export enum ESignalSubtype {
  /** Worker reports incremental progress. */
  WorkerProgress = 'worker_progress',
  /** Worker finished a task successfully. */
  WorkerCompleted = 'worker_completed',
  /** Worker failed a task. */
  WorkerFailed = 'worker_failed',
}

// --- Tool record types ---

/** Tool call data stored within an AssistantEntry. */
export interface ToolCallRecord {
  toolCallId: string;
  toolName: string;
  /** JSON string of tool input arguments. */
  arguments: string;
}

/** Tool result data stored within an AssistantEntry. */
export interface ToolResultRecord {
  toolCallId: string;
  toolName: string;
  output: { type: 'text'; value: string };
  isError?: boolean;
}

// --- Union type ---

/**
 * Union type for all conversation entries stored in JSONL files.
 *
 * | Type            | Purpose                                           |
 * |-----------------|---------------------------------------------------|
 * | UserEntry       | User input                                        |
 * | AssistantEntry  | LLM response per step (text + tool calls/results) |
 * | SignalEntry     | Worker signals (progress/completed/failed)        |
 * | SystemEntry     | System events (compaction markers)                |
 */
export type ConversationEntry =
  | UserEntry
  | AssistantEntry
  | SignalEntry
  | SystemEntry;

// --- Interfaces ---

export interface UserEntry {
  type: EEntryType.User;
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  message: { role: 'user'; content: string };
}

/**
 * LLM response for a single step.
 *
 * Contains text output, optional tool calls/results, and metadata.
 * One AssistantEntry = one LLM step (text + tool interactions are atomic).
 */
export interface AssistantEntry {
  type: EEntryType.Assistant;
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  message: {
    role: 'assistant';
    content: string;
    /** Extended thinking / chain-of-thought (if model supports it). */
    reasoning?: string;
    usage?: { inputTokens: number; outputTokens: number };
  };
  /** Tool calls made by the LLM in this step. */
  toolCalls?: ToolCallRecord[];
  /** Tool results from executing tool calls in this step. */
  toolResults?: ToolResultRecord[];
  /** SDK finish reason for this step. */
  finishReason?: string;
}

/** Worker signal entry — progress, completion, or failure notification. */
export interface SignalEntry {
  type: EEntryType.Signal;
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  subtype: ESignalSubtype;
  workerId?: string;
  workerType?: string;
  /** Display emoji for the worker type. */
  emoji?: string;
  taskId?: string;
  taskTitle: string;
  content: string;
}

export interface SystemEntry {
  type: EEntryType.System;
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  subtype: ESystemSubtype;
  content: string;
}

// --- Type guards ---

/** Check whether entry is a SystemEntry. */
export function isSystemEntry(entry: ConversationEntry): entry is SystemEntry {
  return entry.type === EEntryType.System;
}

/** Check whether entry is a SignalEntry. */
export function isSignalEntry(entry: ConversationEntry): entry is SignalEntry {
  return entry.type === EEntryType.Signal;
}

/**
 * Extract the primary text content from any ConversationEntry variant.
 *
 * - UserEntry / AssistantEntry → `message.content`
 * - SignalEntry / SystemEntry  → `content`
 */
export function getEntryContent(entry: ConversationEntry): string {
  if (entry.type === EEntryType.Signal || entry.type === EEntryType.System) {
    return entry.content;
  }
  return entry.message.content;
}
