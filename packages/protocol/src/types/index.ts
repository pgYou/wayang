// Types barrel — re-export all for backward compatibility

export type { ProviderConfig, ModelConfig, ModelRef, WayangConfig, WorkerConfig, WorkerType, AcpProtocolConfig, ToolChoice, PermissionConfig, SensitiveMode, LoggingConfig } from './config';
export { validateConfig, collectWorkerWarnings, collectProviderWarnings, normalizeWorkerTypes, WORKER_TYPES } from './config';

// --- Config hot-update (monorepo-design 4.1 运行时热更) ---
export type {
  ProviderPatch,
  ModelPatch,
  ProviderDefinition,
  ModelDefinition,
  WorkerSettingsPatch,
  ConfigUpdateRequest,
  ConfigUpdateMethod,
  ConfigUpdateAffected,
  ConfigUpdateResult,
  ConfigUpdateBlocker,
  ConfigUpdateRejection,
  BindingSite,
} from './config-update';
export { parseConfigUpdateRequest, isConfigUpdateMethod, bindingSites, modelRefProvider, modelRefKey } from './config-update';

export type {
  ConversationEntry,
  UserEntry,
  AssistantEntry,
  SignalEntry,
  SystemEntry,
  ToolCallRecord,
  ToolResultRecord,
  ToolRecordStatus,
  ConversationEntryEnvelope,
  EntryActor,
  ETurnStatus,
  TurnView,
  TurnToolCallView,
  TurnUsage,
  ConversationIndex,
  PermissionRequestMeta,
  WorkerInquiryMeta,
  /** @deprecated Alias of TurnToolCallView. */
  TurnViewToolCall,
  /** @deprecated Alias of TurnUsage. */
  TurnViewUsage,
} from './conversation';
export { EEntryType, ESystemSubtype, ESignalSubtype, isSystemEntry, isSignalEntry, isCompactMarker, getEntryContent } from './conversation';

export type { TaskDetail } from './task';

export type {
  ControllerSignal,
  NewSignalInput,
  SignalStatus,
  SignalSource,
  SignalType,
  SignalPayloadMap,
  SignalTurnLineage,
  InputSignalPayload,
  CompletedSignalPayload,
  FailedSignalPayload,
  ProgressSignalPayload,
  CancelledSignalPayload,
  TaskCancelledSignalPayload,
  TaskQueuedSignalPayload,
  WorkerStartedSignalPayload,
  HeartbeatSignalPayload,
  PermissionRequestSignalPayload,
  WorkerInquirySignalPayload,
  InquiryTimeoutSignalPayload,
  MessageUndeliveredSignalPayload,
  PreviousSessionTasksSignalPayload,
} from './signal';
export { getSignalField } from './signal';

export type { StateEvent } from './state';

export type { WorkerResult, ActiveWorkerInfo, WorkerLiveStatus } from './worker';

export type { WayangLanguageModel as WayangModel } from './agent';

export type { InquireQuestion } from './inquiry';
export {
  INQUIRE_OTHER_OPTION,
  INQUIRE_CUSTOM_ANSWER_PREFIX,
  buildSelectChoices,
  isOtherChoice,
  formatCustomAnswer,
  isCustomAnswer,
} from './inquiry';

export type { ContextUsage, ContextBreakdown, ContextLastUsage } from './context-usage';

// --- Deployment storage & workspace contracts (monorepo-design 4.2 改造二) ---
export type { StoragePaths, WorkspacePolicy } from './paths';

