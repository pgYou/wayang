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
  /** Third-party worker terminal result (success) — display/audit record only. */
  TaskResult = 'task_result',
}

/** SignalEntry event kind — worker notifications delivered to Controller. */
export enum ESignalSubtype {
  /** Worker reports incremental progress. */
  WorkerProgress = 'worker_progress',
  /** Worker finished a task successfully. */
  WorkerCompleted = 'worker_completed',
  /** Worker failed a task. */
  WorkerFailed = 'worker_failed',
  /** Idle (multi-stage) worker disposed — reaped by timeout or manually. No task failed. */
  WorkerDisposed = 'worker_disposed',
  /** A dispatched task was cancelled (user/controller-initiated). Not a failure. */
  TaskCancelled = 'task_cancelled',
  /** System heartbeat — periodic check-in while workers are running. */
  Heartbeat = 'heartbeat',
  /** Worker requesting permission for a sensitive operation. */
  PermissionRequest = 'permission_request',
  /** Unfinished tasks carried over from a previous session (sessionless resume). */
  PreviousSessionTasks = 'previous_session_tasks',
  /** Worker asking the controller a blocking question mid-task. */
  WorkerInquiry = 'worker_inquiry',
  /** A pending worker inquiry timed out; the worker continued on its own. */
  InquiryTimeout = 'inquiry_timeout',
  /** Controller messages the worker never read before its run ended. */
  MessageUndelivered = 'message_undelivered',
}

// --- Tool record types ---

/** Lifecycle status of a tool call / tool result. */
export type ToolRecordStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** Tool call data stored within an AssistantEntry. */
export interface ToolCallRecord {
  toolCallId: string;
  toolName: string;
  /** JSON string of tool input arguments. */
  arguments: string;
  /** Task dispatched by this call (async tools like add_task). */
  taskId?: string;
  /**
   * Execution status. For async dispatch tools (add_task) this reflects the
   * dispatched task at write time ('running') and is never updated afterwards
   * (append-only storage) — terminal state arrives via later signal entries.
   */
  status?: ToolRecordStatus;
  startedAt?: string;
  endedAt?: string;
  /** Error classification (e.g. error class name) when status is 'failed'. */
  errorType?: string;
}

/** Tool result data stored within an AssistantEntry. */
export interface ToolResultRecord {
  toolCallId: string;
  toolName: string;
  output: { type: 'text'; value: string };
  isError?: boolean;
  status?: ToolRecordStatus;
  errorType?: string;
  startedAt?: string;
  endedAt?: string;
}

// --- Envelope (optional fields shared by all entry kinds) ---

/** Who produced an entry. */
export interface EntryActor {
  kind: 'user' | 'controller' | 'worker' | 'system' | 'tool';
  id: string;
  taskId?: string;
}

/**
 * Optional envelope fields carried by every conversation entry.
 *
 * All fields are optional and additive — readers must ignore unknown fields,
 * and writers must not make any of them required. `v` is the schema version
 * of the envelope (new writes use 1).
 */
export interface ConversationEntryEnvelope {
  /** Envelope schema version. New writes use 1. */
  v?: number;
  /**
   * uuid of the previous entry in the same session's chain. `null` at the
   * first entry of a chain and at compaction boundaries (the compact marker
   * and the first entry after it). This is the real chain link — see the
   * deprecated `parentUuid` on each entry kind.
   */
  parentId?: string | null;
  /** One agent activation (one controller run / one worker run) = one turn. */
  turnId?: string;
  /** The user turn that originally triggered this chain; propagated via signal/task. */
  rootTurnId?: string;
  /** Who produced this entry. */
  actor?: EntryActor;
  /** What triggered this entry: a signal id, tool call id, or task id. */
  causationId?: string;
  /** ISO timestamp — when the recorded activity started. */
  startedAt?: string;
  /** ISO timestamp — when the recorded activity ended. */
  endedAt?: string;
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

export interface UserEntry extends ConversationEntryEnvelope {
  type: EEntryType.User;
  uuid: string;
  /** @deprecated Legacy chain field — always null. Use `parentId` instead. */
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
export interface AssistantEntry extends ConversationEntryEnvelope {
  type: EEntryType.Assistant;
  uuid: string;
  /** @deprecated Legacy chain field — always null. Use `parentId` instead. */
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  message: {
    role: 'assistant';
    content: string;
    /** Extended thinking / chain-of-thought (if model supports it). */
    reasoning?: string;
    /** Token usage of this single step (not cumulative). */
    usage?: {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens?: number;
      reasoningTokens?: number;
      totalTokens?: number;
    };
  };
  /** Tool calls made by the LLM in this step. */
  toolCalls?: ToolCallRecord[];
  /** Tool results from executing tool calls in this step. */
  toolResults?: ToolResultRecord[];
  /** SDK finish reason for this step. */
  finishReason?: string;
  /** Zero-based index of this step within its turn. */
  stepIndex?: number;
  /**
   * Model that produced this step. provider/model are best effort from the
   * SDK event; temperature/maxOutputTokens are backfilled from ProviderConfig
   * (the values the run was configured with), never fabricated.
   */
  model?: {
    provider?: string;
    model?: string;
    temperature?: number;
    maxOutputTokens?: number;
  };
  /** Timing of this step (best effort from the SDK; firstTokenAt is approximate for streams). */
  timing?: {
    startedAt?: string;
    firstTokenAt?: string;
    endedAt?: string;
    durationMs?: number;
    retries?: number;
  };
  /**
   * Provider response id, when the SDK exposes one. Absent means unavailable.
   */
  requestId?: string;
  /**
   * Distributed tracing ids — reserved fields, never fabricated.
   * 待 telemetry 接入：no source provides these yet; they stay unwritten
   * until a telemetry pipeline is wired in.
   */
  traceId?: string;
  spanId?: string;
}

/**
 * Structured permission-request data attached to `permission_request` signal
 * entries. Lets the TUI render per-tool summaries without re-parsing the
 * flattened `content` text. Optional — legacy entries predate it and fall
 * back to content-based rendering.
 */
export interface PermissionRequestMeta {
  /** Unique ID for matching request → response. */
  requestId: string;
  /** Tool name that triggered the permission check. */
  toolName: string;
  /** Arguments passed to the tool. */
  toolArgs: Record<string, unknown>;
  /** Human-readable description of what the tool will do. */
  description?: string;
}

/**
 * Structured worker-inquiry data attached to `worker_inquiry` signal entries
 * (mirrors PermissionRequestMeta): the TUI renders the question from it and
 * matches a later respond_inquiry call by inquiryId.
 */
export interface WorkerInquiryMeta {
  inquiryId: string;
  question: string;
  context?: string;
}

/** Worker signal entry — progress, completion, or failure notification. */
export interface SignalEntry extends ConversationEntryEnvelope {
  type: EEntryType.Signal;
  uuid: string;
  /** @deprecated Legacy chain field — always null. Use `parentId` instead. */
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  subtype: ESignalSubtype;
  /** Id of the originating signal in the SignalQueue (e.g. "sig-42"). */
  signalId?: string;
  workerId?: string;
  workerType?: string;
  /** Display emoji for the worker type. */
  emoji?: string;
  taskId?: string;
  taskTitle: string;
  content: string;
  /** Present on permission_request entries — structured data for summary rendering. */
  permissionMeta?: PermissionRequestMeta;
  /** Present on worker_inquiry entries — structured data for summary rendering. */
  inquiryMeta?: WorkerInquiryMeta;
}

export interface SystemEntry extends ConversationEntryEnvelope {
  type: EEntryType.System;
  uuid: string;
  /** @deprecated Legacy chain field — always null. Use `parentId` instead. */
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  subtype: ESystemSubtype;
  content: string;
  /**
   * Present only on compaction markers written by ContextManager.compact().
   * Distinguishes real markers from legacy subtype='compact' records that
   * predate typed metadata (e.g. old ClaudeCodeWorker success entries).
   */
  compactMeta?: {
    summarizedTokenCount?: number;
    /** First entry id covered by the summary (inclusive). */
    fromEntryId?: string;
    /** Last entry id covered by the summary (inclusive). */
    toEntryId?: string;
    /** Model name used to produce the summary. */
    model?: string;
    /** ISO timestamp of when the summary was created. */
    createdAt?: string;
  };
}

// --- Type guards ---

/** Check whether entry is a SystemEntry. */
export function isSystemEntry(entry: ConversationEntry): entry is SystemEntry {
  return entry.type === EEntryType.System;
}

/**
 * Structural check for a compaction marker: a SystemEntry whose subtype is
 * Compact AND that carries compactMeta. Records with subtype='compact' but no
 * compactMeta are legacy non-marker entries and must not trigger restore
 * windowing or compact-style rendering.
 */
export function isCompactMarker(entry: ConversationEntry): entry is SystemEntry {
  return entry.type === EEntryType.System
    && entry.subtype === ESystemSubtype.Compact
    && entry.compactMeta !== undefined;
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

// --- Derived, read-only view types (never persisted) ---

/** Lifecycle status of a turn (derived by the index, never persisted). */
export type ETurnStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** Tool call summary inside a TurnView. */
export interface TurnToolCallView {
  toolCallId: string;
  toolName: string;
  /** Task dispatched by this call, when the tool is an async dispatcher (add_task). */
  taskId?: string;
  status?: ToolRecordStatus;
  startedAt?: string;
  endedAt?: string;
  /** Status of the matching tool result, when one exists. */
  resultStatus?: ToolRecordStatus;
}

/** Token usage accumulated over a turn's assistant steps (missing values default to 0). */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

/**
 * One agent activation (turn) derived from a conversation.
 *
 * A turn aggregates its triggering input (userEntry and/or signals), the
 * assistant steps it produced, their tool calls, and accumulated usage.
 * Derived in memory by the conversation index — never written to disk.
 */
export interface TurnView {
  turnId: string;
  rootTurnId?: string;
  actor?: EntryActor;
  startedAt?: string;
  endedAt?: string;
  status: ETurnStatus;
  steps: AssistantEntry[];
  userEntry?: UserEntry;
  signals: SignalEntry[];
  toolCalls: TurnToolCallView[];
  usage: TurnUsage;
  entryIds: string[];
}

/** In-memory grouped view over one conversation (one JSONL file). */
export interface ConversationIndex {
  turns: TurnView[];
  byEntryId: Map<string, TurnView>;
}

// --- Compat aliases (names used while the view types were first introduced) ---

/** @deprecated Alias — use `TurnToolCallView`. */
export type TurnViewToolCall = TurnToolCallView;
/** @deprecated Alias — use `TurnUsage`. */
export type TurnViewUsage = TurnUsage;
