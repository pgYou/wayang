import type { ControllerSignal, NewSignalInput, SignalStatus, SignalSource, SignalType } from '@/types/index';
import type { Logger } from '@/infra/logger';
import { SignalState } from '@/services/signal/signal-state';
import type { SystemContext } from '@/infra/system-context';
import type { Subscribable } from '@/infra/state/subscribable';
import type { StateEvent } from '@/infra/state/base-state';

/** Query filter for signals */
export interface SignalQueryFilter {
  /** Filter by signal status */
  status?: SignalStatus;
  /** Filter by signal source */
  source?: SignalSource;
  /** Filter by signal type */
  type?: SignalType;
}

export class SignalQueue implements Subscribable {
  private resolveWait: (() => void) | null = null;

  private counter: number;
  private readonly state: SignalState;
  private readonly logger: Logger;
  private readonly ctx: SystemContext;

  constructor(ctx: SystemContext) {
    this.ctx = ctx;
    this.state = new SignalState(ctx);
    this.logger = ctx.logger;

    const sigs = this.state.get<ControllerSignal[]>('signals');
    this.counter = sigs.reduce((max, s) => {
      const n = parseInt(s.id.replace('sig-', ''), 10);
      return isNaN(n) ? max : Math.max(max, n);
    }, 0);
  }

  // --- Subscribable ---

  subscribe(path: string, callback: (event: StateEvent) => void): () => void {
    return this.state.on(path, callback);
  }

  getSnapshot<T>(path: string): T {
    return this.state.get(path);
  }

  enqueue(sig: NewSignalInput): void {
    const full = {
      ...sig,
      id: `sig-${++this.counter}`,
      status: 'unread' as const,
      timestamp: Date.now(),
    } as ControllerSignal;

    // Progress merge: same worker's old progress → discarded
    if (sig.source === 'worker' && sig.type === 'progress') {
      const { workerId } = sig.payload;
      if (workerId) {
        const allSigs = this.state.get<ControllerSignal[]>('signals');
        let changed = false;
        for (const old of allSigs) {
          if (
            old.status === 'unread'
            && old.source === 'worker'
            && old.type === 'progress'
            && old.payload.workerId === workerId
          ) {
            old.status = 'discarded';
            changed = true;
          }
        }
        if (changed) {
          this.state.set('signals', [...allSigs]);
        }
      }
    }

    this.state.append('signals', full);
    this.logger.debug({ sigId: full.id, type: full.type }, 'Signal enqueued');

    // Wake up waiting controller loop
    if (this.resolveWait) {
      this.resolveWait();
      this.resolveWait = null;
    }

    // Notify lifecycle hooks
    this.ctx.hooks.emit('signal:enqueued', { signal: full });
  }

  dequeueUnread(): ControllerSignal[] {
    const all = this.state.get<ControllerSignal[]>('signals');
    const unread = all.filter(s => s.status === 'unread');
    this.logger.debug({ total: all.length, unreadCount: unread.length, unreadIds: unread.map(s => s.id), allStatuses: all.map(s => `${s.id}=${s.status}`) }, 'dequeueUnread');
    for (const sig of unread) {
      sig.status = 'read';
    }
    if (unread.length > 0) {
      this.state.set('signals', [...all]);
    }
    return unread;
  }

  waitForSignal(): Promise<void> {
    const unread = this.state.get<ControllerSignal[]>('signals').filter(s => s.status === 'unread');
    if (unread.length > 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.resolveWait = () => {
        this.logger.debug('waitForSignal resolved');
        resolve();
      };
    });
  }

  async restore(): Promise<void> {
    await this.state.restore();
    // Re-initialize counter from restored state
    const sigs = this.state.get<ControllerSignal[]>('signals');
    this.counter = sigs.reduce((max, s) => {
      const n = parseInt(s.id.replace('sig-', ''), 10);
      return isNaN(n) ? max : Math.max(max, n);
    }, 0);
  }

  /** Get all unread signals without modifying state. Used by UI to display pending signals. */
  getUnreadSignals(): ControllerSignal[] {
    return this.state.get<ControllerSignal[]>('signals').filter(s => s.status === 'unread');
  }

  /**
   * Query signals by filter criteria.
   * Returns a filtered list without modifying state.
   */
  query(filter: SignalQueryFilter): ControllerSignal[] {
    const all = this.state.get<ControllerSignal[]>('signals');

    return all.filter((sig) => {
      if (filter.status !== undefined && sig.status !== filter.status) {
        return false;
      }
      if (filter.source !== undefined && sig.source !== filter.source) {
        return false;
      }
      if (filter.type !== undefined && sig.type !== filter.type) {
        return false;
      }
      return true;
    });
  }
}
