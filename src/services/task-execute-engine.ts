/**
 * TaskExecuteEngine — unified task + worker lifecycle manager.
 *
 * Merges TaskPool (task state machine), TaskScheduler (scheduling),
 * WorkerFactory (worker creation), and worker instance tracking into
 * a single cohesive domain object.
 *
 * Responsibilities:
 *   1. Task state machine: pending → running → completed/failed/cancelled
 *   2. Scheduling: dequeue pending tasks up to maxConcurrency, spawn workers
 *   3. Worker lifecycle: create, track, abort, cleanup
 *   4. Signal emission: notify controller of worker completion/failure/progress
 *
 * Scheduling is driven by direct method calls (add → scheduleNext),
 * NOT by lifecycle hooks. This keeps core flow explicit and traceable.
 *
 * The implementation lives in the `./task-execute-engine/` layer classes
 * (engine-base → task-lifecycle → worker-tracking → worker-wiring →
 * worker-dispatch); this file is the stable import surface and the public
 * class name.
 */
import type { Subscribable } from '@/infra/state/subscribable';
import { WorkerDispatchEngine } from './task-execute-engine/worker-dispatch';

export type {
  TaskExecuteEngineOptions,
  WorkerInquiryResolution,
  WorkerMessageDelivery,
} from './task-execute-engine/types';

// ---------------------------------------------------------------------------
// TaskExecuteEngine
// ---------------------------------------------------------------------------

export class TaskExecuteEngine extends WorkerDispatchEngine implements Subscribable {}
