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
  private listeners = new Map<keyof HookMap, Set<Listener<any>>>();

  on<K extends keyof HookMap>(hook: K, fn: Listener<HookMap[K]>): () => void {
    if (!this.listeners.has(hook)) {
      this.listeners.set(hook, new Set());
    }
    this.listeners.get(hook)!.add(fn);
    return () => this.listeners.get(hook)?.delete(fn);
  }

  emit<K extends keyof HookMap>(hook: K, payload: HookMap[K]): void {
    this.listeners.get(hook)?.forEach((fn) => fn(payload));
  }

  removeAll(): void {
    this.listeners.clear();
  }
}
