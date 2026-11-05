/**
 * ClaudeCodeWorker — third-party worker that delegates execution to Claude Code
 * via the Claude Agent SDK.
 *
 * Independent implementation (does NOT extend BaseAgent).
 * Conversation entries are written for UI display and audit only —
 * never read back for context recovery.
 *
 * Multi-stage note: the Claude Agent SDK's `query()` starts a fresh session
 * each call, so unlike the puppet WorkerAgent this worker does NOT carry SDK
 * session context across stages. Assigning a follow-up task reuses the worker
 * instance (and its persisted conversation log), but the underlying Claude
 * process begins anew. `multiStage` therefore provides less benefit here than
 * for puppet workers.
 *
 * The implementation lives in the `./claude-code-worker/` layer classes
 * (worker-base -> worker-permission -> worker-stream -> worker-run); this
 * file is the stable import surface and the public class name.
 */
import type { IWorkerInstance } from '@/types/worker';
import { ClaudeWorkerRun } from './claude-code-worker/worker-run';

export class ClaudeCodeWorker extends ClaudeWorkerRun implements IWorkerInstance {}
