/**
 * Worker transcript utilities — the controller's read path into a worker's
 * live/on-disk conversation (issue #16).
 *
 * Everything here is read-only. It inspects
 * `<sessionDir>/workers/<workerId>/conversation.jsonl` — the same append-only
 * file `WorkerState` writes — so a finished, failed, or cancelled worker stays
 * inspectable after the engine has dropped it from its in-memory `workers` map.
 *
 * Also hosts the pagination/formatting helpers shared by `get_task_detail` and
 * `read_worker_conversation`, plus the activity inference used by
 * `get_worker_status` and the heartbeat signal.
 *
 * The implementation lives in the `./worker-transcript/` modules
 * (transcript-file, windowed-read, entry-text, activity, pagination,
 * formatting); this file is the stable import surface
 * (`@/services/worker-transcript`).
 */
export {
  WORKER_TRANSCRIPT_FILE,
  MAX_TRANSCRIPT_RESULT_CHARS,
  isValidWorkerId,
  workerTranscriptPath,
  readWorkerTranscript,
} from './worker-transcript/transcript-file';
export {
  MAX_TRANSCRIPT_WINDOW_BYTES,
  readWorkerTranscriptWindow,
  type TranscriptReadOptions,
  type WorkerTranscriptWindow,
} from './worker-transcript/windowed-read';
export { entryText, entryLabel } from './worker-transcript/entry-text';
export {
  summarizeTranscript,
  formatDuration,
  formatLastActivity,
  type WorkerTranscriptSummary,
} from './worker-transcript/activity';
export { selectWindow, type TranscriptWindow } from './worker-transcript/pagination';
export {
  formatTranscriptEntry,
  shrinkWindow,
  renderEntriesFitting,
  buildWindowMeta,
  buildTruncationNotice,
  buildTranscriptHeader,
  type FormatOptions,
  type FormattedEntry,
  type RenderedEntries,
  type WindowMeta,
} from './worker-transcript/formatting';
