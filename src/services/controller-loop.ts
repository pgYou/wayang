/**
 * ControllerLoop — domain object managing the controller's wake/process cycle.
 *
 * Responsibilities:
 *   1. Signal-driven loop: wait → dequeue → process → idle
 *   2. Lifecycle hooks: emit `controller:loop-start` / `controller:loop-end` for external observers
 *   3. Heartbeat wake: when workers are running but idle too long, inject a
 *      heartbeat signal to let the controller review status
 *
 * The heartbeat mechanism subscribes to lifecycle hooks internally:
 *   • `controller:loop-end` → start countdown if workers are running
 *   • `signal:enqueued` → reset countdown (real event arrived)
 */

import type { SystemContext } from '@/infra/system-context';
import type { SignalQueue } from '@/services/signal/signal-queue';
import type { ControllerAgent } from '@/services/agents/controller-agent';
import type { ActiveWorkerInfo } from '@/types/index';
import { formatLlmError } from '@/utils/llm-error';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ControllerLoopOptions {
  /** Idle interval (ms) before injecting a heartbeat signal. Default 30s. */
  heartbeatIntervalMs?: number;
}

/** Callback to gather heartbeat data. Keeps ControllerLoop decoupled from engine. */
export interface HeartbeatProvider {
  getRunningCount(): number;
  getActiveWorkers(): ActiveWorkerInfo[];
  getPendingCount(): number;
}

// ---------------------------------------------------------------------------
// ControllerLoop
// ---------------------------------------------------------------------------

export class ControllerLoop {
  /** Timestamp of the last time the loop began processing signals. */
  lastWakeAt: number = Date.now();

  private readonly heartbeatIntervalMs: number;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly unsubscribers: Array<() => void> = [];

  constructor(
    private readonly ctx: SystemContext,
    private readonly signalQueue: SignalQueue,
    private readonly controllerAgent: ControllerAgent,
    private readonly heartbeatProvider: HeartbeatProvider,
    options?: ControllerLoopOptions,
  ) {
    this.heartbeatIntervalMs = options?.heartbeatIntervalMs ?? 30_000;
  }

  // --- Lifecycle ---

  async start(): Promise<void> {
    const { signalQueue, controllerAgent, ctx } = this;
    const { hooks } = ctx;

    // Subscribe to hooks for heartbeat wake logic
    this.unsubscribers.push(
      hooks.on('controller:loop-end', (payload) => this.onLoopEnd(payload)),
      hooks.on('signal:enqueued', () => this.clearHeartbeatTimer()),
    );

    ctx.logger.info('ControllerLoop started');

    while (!ctx.abortController.signal.aborted) {
      try {
        // Check if context needs compaction
        if (controllerAgent.needsCompaction()) {
          ctx.logger.info('Context full, triggering compaction');
          await controllerAgent.performCompaction();
        }

        const signals = signalQueue.dequeueUnread();
        ctx.logger.debug('loop start with signals:' + JSON.stringify(signals));

        if (signals.length > 0) {
          this.lastWakeAt = Date.now();
          ctx.logger.info(
            { count: signals.length, sigIds: signals.map(s => s.id), sigTypes: signals.map(s => `${s.source}/${s.type}`) },
            'Processing signals',
          );

          hooks.emit('controller:loop-start', { signals });

          // Streaming entries and conversation persistence are managed inside run()
          await controllerAgent.run(signals);
          ctx.logger.debug('loop end');
        }

        hooks.emit('controller:loop-end', { lastWakeAt: this.lastWakeAt });

        await signalQueue.waitForSignal();
      } catch (err: any) {
        if (ctx.abortController.signal.aborted) break;
        const friendly = formatLlmError(err);
        ctx.logger.error(
          { error: friendly, statusCode: err.statusCode ?? err.lastError?.statusCode },
          'Controller loop error',
        );

        // Surface the error in the UI as a system entry in conversation
        controllerAgent.reportError(friendly);

        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    ctx.logger.info('ControllerLoop stopped');
  }

  shutdown(): void {
    this.clearHeartbeatTimer();
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers.length = 0;
  }

  // --- Heartbeat wake ---

  private onLoopEnd({ lastWakeAt }: { lastWakeAt: number }): void {
    this.clearHeartbeatTimer();

    // Only set timer if there are running workers
    if (this.heartbeatProvider.getRunningCount() === 0) return;

    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      this.sendHeartbeatSignal(lastWakeAt);
    }, this.heartbeatIntervalMs);
  }

  private sendHeartbeatSignal(lastWakeAt: number): void {
    const now = Date.now();
    const activeWorkers = this.heartbeatProvider.getActiveWorkers();

    this.signalQueue.enqueue({
      source: 'system',
      type: 'heartbeat',
      payload: {
        reason: 'Workers are running but no signals for a while. Review status and decide if action is needed.',
        idleSinceMs: now - lastWakeAt,
        workers: activeWorkers.map((w) => ({
          workerId: w.workerId,
          taskId: w.taskId,
          taskTitle: w.taskTitle,
          workerType: w.workerType,
          runningForMs: now - w.startedAt,
        })),
        pendingTaskCount: this.heartbeatProvider.getPendingCount(),
      },
    });
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
