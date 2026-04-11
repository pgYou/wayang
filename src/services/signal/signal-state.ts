import { join } from 'node:path';
import type { ControllerSignal, StateEvent } from '@/types/index';
import type { Logger } from '@/infra/logger';
import { BaseWayangState } from '@/infra/state/base-state';
import { JSONLFileHelper } from '@/infra/state/persistence/jsonl-file';

interface SignalStateData {
  signals: ControllerSignal[];
}

/** Event-sourcing log entry for state changes */
export interface StateEventLog {
  /** Event type from StateEvent */
  type: StateEvent['type'];
  /** State path that changed */
  path: string;
  /** Timestamp when event occurred */
  timestamp: number;
  /** Optional signal ID this event relates to */
  signalId?: string;
  /** Previous value (for set/update/remove operations) */
  prev?: unknown;
  /** New value */
  data?: unknown;
}

export class SignalState extends BaseWayangState {
  private jsonlFile: JSONLFileHelper;
  private eventLogFile: JSONLFileHelper;
  /** In-memory cache of event log entries. */
  private eventBuffer: StateEventLog[] = [];
  /** When true, skip recording events (used during restore to avoid re-writing). */
  private restoring = false;

  constructor(
    private sessionDir: string,
    private logger: Logger,
  ) {
    const jsonlFile = new JSONLFileHelper(join(sessionDir, 'signals.jsonl'));
    const eventLogFile = new JSONLFileHelper(join(sessionDir, 'state-events.jsonl'));

    super(
      { signals: [] },
      [{ path: 'signals', helper: jsonlFile }],
    );

    this.jsonlFile = jsonlFile;
    this.eventLogFile = eventLogFile;

    // Subscribe to state changes for event sourcing
    this.on('signals', (event: StateEvent) => this.recordStateEvent(event));
  }

  /** Record a state change event to the event log */
  private recordStateEvent(event: StateEvent): void {
    // Skip during restore to avoid re-writing events we just loaded from disk
    if (this.restoring) return;
    const logEntry: StateEventLog = {
      type: event.type,
      path: event.path,
      timestamp: Date.now(),
      prev: event.prev,
      data: event.data,
    };

    // Extract signalId if this is a signal-related event
    if (event.path === 'signals') {
      if (event.type === 'append' && Array.isArray(event.data) && event.data.length > 0) {
        const sig = event.data[event.data.length - 1] as ControllerSignal;
        if (sig?.id) {
          logEntry.signalId = sig.id;
        }
      } else if ((event.type === 'set' || event.type === 'update') && Array.isArray(event.data)) {
        const sig = event.data.find((m: any) => m?.id) as ControllerSignal;
        if (sig?.id) {
          logEntry.signalId = sig.id;
        }
      }
    }

    this.eventBuffer.push(logEntry);
    this.eventLogFile.write(logEntry);
    this.logger.debug({ eventType: event.type, path: event.path }, 'State event recorded');
  }

  /** Get all state change events from the in-memory buffer. */
  getStateEvents(): StateEventLog[] {
    return this.eventBuffer;
  }

  /** Get events filtered by signal ID */
  getEventsBySignalId(signalId: string): StateEventLog[] {
    return this.eventBuffer.filter(e => e.signalId === signalId);
  }

  /** Get events filtered by type */
  getEventsByType(type: StateEvent['type']): StateEventLog[] {
    return this.eventBuffer.filter(e => e.type === type);
  }

  async restore(): Promise<void> {
    this.restoring = true;
    try {
    const signals = this.jsonlFile.read() as ControllerSignal[];

    // Build initial signal map from JSONL (source of truth for existence)
    const sigMap = new Map<string, ControllerSignal>();
    for (const sig of signals) {
      sigMap.set(sig.id, { ...sig });
    }

    // Restore event log into memory buffer
    const events = this.eventLogFile.read() as StateEventLog[];
    this.eventBuffer = events;

    // Replay set events to recover status changes (read/discarded)
    for (const event of events) {
      if (event.type === 'set' && event.path === 'signals' && Array.isArray(event.data)) {
        for (const sig of event.data as ControllerSignal[]) {
          if (sig?.id && sigMap.has(sig.id)) {
            sigMap.get(sig.id)!.status = sig.status;
          }
        }
      }
    }

    this.data.signals = Array.from(sigMap.values());

    this.logger.info({
      signalCount: this.data.signals.length,
      eventCount: events.length,
    }, 'SignalState restored');
    } finally {
      this.restoring = false;
    }
  }

  /** Override append to ensure JSONL write-per-entry. */
  append(path: string, entry: unknown): void {
    super.append(path, entry);
    if (path === 'signals') {
      this.persistAppend(path, entry);
    }
  }
}
