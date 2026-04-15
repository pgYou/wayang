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

import type { Supervisor } from '@/services/supervisor';
import type { ActiveWorkerInfo } from '@/types/index';
import { EEntryType, ESystemSubtype } from '@/types/index';
import { generateId } from '@/utils/id';
import { nowISO } from '@/utils/time';
import { formatLlmError } from '@/utils/llm-error';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ControllerLoopOptions {
  /** Idle interval (ms) before injecting a heartbeat signal. Default 30s. */
  heartbeatIntervalMs?: number;
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
    private readonly supervisor: Supervisor,
    options?: ControllerLoopOptions,
  ) {
    this.heartbeatIntervalMs = options?.heartbeatIntervalMs ?? 30_000;
  }

  // --- Lifecycle ---

  async start(): Promise<void> {
    const { signalQueue, controllerAgent, hooks, ctx } = this.supervisor;

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
        controllerAgent.state.set('dynamicState.streamingEntries', []);
        controllerAgent.state.append('conversation', {
          type: EEntryType.System,
          uuid: generateId('err'),
          parentUuid: null,
          sessionId: 'controller',
          timestamp: nowISO(),
          subtype: ESystemSubtype.Error,
          content: friendly,
        });

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
    if (this.supervisor.taskPool.getRunningCount() === 0) return;

    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      this.sendHeartbeatSignal(lastWakeAt);
    }, this.heartbeatIntervalMs);
  }

  private sendHeartbeatSignal(lastWakeAt: number): void {
    const now = Date.now();
    const activeWorkers = this.supervisor.controllerState.get<ActiveWorkerInfo[]>('runtimeState.activeWorkers');

    this.supervisor.signalQueue.enqueue({
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
        pendingTaskCount: this.supervisor.taskPool.list('pending').length,
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
