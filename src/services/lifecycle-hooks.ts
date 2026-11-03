/**
 * LifecycleHooks — typed system-level lifecycle event bus.
 *
 * All hook names and payloads are
 * declared in HookMap, giving compile-time safety to both emitters and
 * subscribers.
 */

import type { TaskDetail, ControllerSignal } from '@/types/index';

// ---------------------------------------------------------------------------
// Hook declarations
// ---------------------------------------------------------------------------

export interface HookMap {
  // --- Task lifecycle (side-effect hooks — no core logic depends on these) ---
  'task:added': TaskDetail;
  'task:completed': { taskId: string };
  'task:failed': { taskId: string; error: string };
  'task:cancelled': { taskId: string };

  // --- Worker lifecycle ---
  /** Emitted when a multi-stage worker parks in idle (not disposed). */
  'worker:idle': { workerId: string; taskId: string };

  // --- Controller loop lifecycle ---
  'controller:loop-start': { signals: ControllerSignal[] };
  'controller:loop-end': { lastWakeAt: number };

  // --- Signal lifecycle ---
  'signal:enqueued': { signal: ControllerSignal };
}

// ---------------------------------------------------------------------------
// LifecycleHooks
// ---------------------------------------------------------------------------

type Listener<T = unknown> = (payload: T) => void;

export class LifecycleHooks {
  /** Heterogeneous per-hook listeners in one map: stored as the payload union. */
  private listeners = new Map<keyof HookMap, Set<Listener<HookMap[keyof HookMap]>>>();

  on<K extends keyof HookMap>(hook: K, fn: Listener<HookMap[K]>): () => void {
    if (!this.listeners.has(hook)) {
      this.listeners.set(hook, new Set());
    }
    const stored = fn as Listener<HookMap[keyof HookMap]>;
    this.listeners.get(hook)!.add(stored);
    return () => this.listeners.get(hook)?.delete(stored);
  }

  emit<K extends keyof HookMap>(hook: K, payload: HookMap[K]): void {
    this.listeners.get(hook)?.forEach((fn) => fn(payload));
  }

  removeAll(): void {
    this.listeners.clear();
  }
}
