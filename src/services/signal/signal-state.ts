/**
 * Signal inbox persistence.
 *
 * Ownership map (this is the part that must stay unambiguous):
 *
 *   signals.json      SNAPSHOT / source of truth.
 *                     Holds the hot window + the id high-water mark.
 *                     Recovery reads ONLY this file.
 *                     Atomic write; corruption is a hard error, not "empty".
 *
 *   signals.jsonl     APPEND-ONLY complete history.
 *                     One line per enqueue (with the full body) and one line per
 *                     status transition. Never rewritten, never trimmed.
 *                     This is the durable record for history queries; it is not
 *                     read during normal recovery. It is NOT a disposable audit
 *                     copy — it is the only complete record once signals fall
 *                     out of the window.
 *
 * The in-memory `signals` array is a WINDOW over `signals.jsonl`, never the
 * whole history. That is why appends to the log go through the entry, and why
 * window edits never rewrite the log.
 */

import { join } from 'node:path';
import type { ControllerSignal, SignalStatus } from '@/types/index';
import type { Logger } from '@/infra/logger';
import { BaseWayangState } from '@/infra/state/base-state';
import { JSONFileHelper } from '@/infra/state/persistence/json-file';
import { JSONLFileHelper } from '@/infra/state/persistence/jsonl-file';
import type { IPersistenceHelper, PersistContext } from '@/infra/state/persistence/types';
import type { SystemContext } from '@/infra/system-context';

/** Default number of processed (read/discarded) signals kept in the hot window. */
export const DEFAULT_SIGNAL_WINDOW_SIZE = 2_000;

/** On-disk shape of the signal snapshot. */
export interface SignalSnapshot {
  /** Hot window: all unread signals plus the most recent processed ones. */
  signals: ControllerSignal[];
  /**
   * Highest signal id ever issued, independent of window contents.
   * Guarantees ids are never reused after trimming.
   */
  idHighWaterMark: number;
}

/** One line in the append-only signal history. */
export interface SignalHistoryEntry {
  /** Monotonic entry id, for ordering. */
  seq: number;
  signalId: string;
  /** 'enqueued' when the signal first appears, else the transition target. */
  status: SignalStatus | 'enqueued';
  /** Previous status, when this entry records a transition. */
  from?: SignalStatus;
  timestamp: number;
  /** Full signal body, present only on the 'enqueued' entry. */
  signal?: ControllerSignal;
}

interface SignalStateData {
  signals: ControllerSignal[];
  idHighWaterMark: number;
}

/**
 * Persistence adapter for the signals field.
 *
 * The field's on-disk representation is the whole snapshot object, but the
 * state tree exposes only `signals`. This adapter bridges the two: the base
 * class hands it the field value, and it composes the snapshot with the
 * high-water mark that lives alongside it.
 */
class SignalSnapshotHelper implements IPersistenceHelper {
  readonly mode = 'save' as const;

  /** Supplies the current high-water mark from live state (not from disk). */
  private markProvider: () => number = () => 0;

  constructor(private readonly file: JSONFileHelper<SignalSnapshot>) {}

  /** Bind the adapter to the state's live high-water mark. */
  bindMark(provider: () => number): void {
    this.markProvider = provider;
  }

  write(change: PersistContext): void {
    const snapshot: SignalSnapshot = {
      signals: (change.value as ControllerSignal[]) ?? [],
      idHighWaterMark: this.markProvider(),
    };
    this.file.writeValue(snapshot);
  }

  /** Persist an explicit snapshot (window + mark) in one atomic write. */
  writeSnapshot(snapshot: SignalSnapshot): void {
    this.file.writeValue(snapshot);
  }

  read(): unknown {
    const snapshot = this.file.readonly();
    return snapshot?.signals ?? null;
  }

  clear(): void {
    this.file.clear();
  }
}

export class SignalState extends BaseWayangState {
  private readonly snapshotFile: JSONFileHelper<SignalSnapshot>;
  private readonly snapshotHelper: SignalSnapshotHelper;
  private readonly historyFile: JSONLFileHelper<SignalHistoryEntry>;
  private readonly logger: Logger;
  private readonly snapshotPath: string;
  private readonly historyPath: string;
  private historySeq = 0;

  constructor(ctx: SystemContext) {
    const snapshotPath = join(ctx.sessionDir, 'signals.json');
    const historyPath = join(ctx.sessionDir, 'signals.jsonl');

    const snapshotFile = new JSONFileHelper<SignalSnapshot>(snapshotPath);
    const snapshotHelper = new SignalSnapshotHelper(snapshotFile);
    const historyFile = new JSONLFileHelper<SignalHistoryEntry>(historyPath);

    const initialData: SignalStateData = { signals: [], idHighWaterMark: 0 };

    super(initialData, [{ path: 'signals', helper: snapshotHelper }]);

    this.snapshotFile = snapshotFile;
    this.snapshotHelper = snapshotHelper;
    this.historyFile = historyFile;
    this.snapshotPath = snapshotPath;
    this.historyPath = historyPath;
    this.logger = ctx.logger;

    // The snapshot must always carry the live mark, even when the write is
    // triggered by the base class (e.g. set('signals', ...)).
    snapshotHelper.bindMark(() => this.data.idHighWaterMark);
  }

  // --- Snapshot access ---

  getIdHighWaterMark(): number {
    return this.data.idHighWaterMark;
  }

  /** Raise the high-water mark. Persisted on the next snapshot write. */
  setIdHighWaterMark(value: number): void {
    this.data.idHighWaterMark = value;
  }

  /**
   * Write the current window and high-water mark in ONE atomic snapshot write.
   * Batched status changes call this after mutating the window, so trimming and
   * status updates land together.
   */
  commit(): void {
    this.snapshotHelper.writeSnapshot({
      signals: this.data.signals,
      idHighWaterMark: this.data.idHighWaterMark,
    });
  }

  // --- History (append-only, never read during recovery) ---

  /** Record that a signal was created, including its full body. */
  recordEnqueued(signal: ControllerSignal): void {
    this.historyFile.append({
      seq: ++this.historySeq,
      signalId: signal.id,
      status: 'enqueued',
      timestamp: signal.timestamp,
      signal,
    });
  }

  /** Record a status transition (read / discarded). */
  recordTransition(signalId: string, from: SignalStatus, to: SignalStatus): void {
    this.historyFile.append({
      seq: ++this.historySeq,
      signalId,
      status: to,
      from,
      timestamp: Date.now(),
    });
  }

  /** Full history, for history queries. Never used to rebuild live state. */
  readHistory(): SignalHistoryEntry[] {
    return this.historyFile.read();
  }

  /** History entries for one signal, oldest first. */
  getHistoryForSignal(signalId: string): SignalHistoryEntry[] {
    return this.readHistory().filter(e => e.signalId === signalId);
  }

  /** Reconstruct a signal's body and final status from history alone. */
  getArchivedSignal(signalId: string): { signal: ControllerSignal; status: SignalStatus } | null {
    const entries = this.getHistoryForSignal(signalId);
    const created = entries.find(e => e.status === 'enqueued' && e.signal);
    if (!created?.signal) return null;

    let status: SignalStatus = created.signal.status;
    for (const entry of entries) {
      if (entry.status !== 'enqueued') status = entry.status;
    }
    return { signal: { ...created.signal, status }, status };
  }

  // --- Restore ---

  async restore(): Promise<void> {
    // Presence must be judged by the FILE, not by a successful parse: a corrupt
    // snapshot still means "this session already has a snapshot", so it must go
    // to the error path rather than the migration path.
    const hasSnapshot = this.snapshotFile.exists();

    if (!hasSnapshot && this.hasLegacyLog()) {
      this.migrateLegacy();
      return;
    }

    if (!hasSnapshot) {
      this.data.signals = [];
      this.data.idHighWaterMark = 0;
      this.historySeq = this.inferHistorySeq();
      this.logger.info({ signalCount: 0 }, 'SignalState restored (empty)');
      return;
    }

    let snapshot: SignalSnapshot | null;
    try {
      snapshot = this.snapshotFile.readonly();
    } catch (err) {
      // A corrupt snapshot must never be read as empty state: doing so would
      // let the next write discard every pending signal.
      throw new Error(
        `SignalState: cannot restore from corrupt snapshot "${this.snapshotPath}". `
        + `Inspect the quarantined copy, or delete the file to start from an empty window. `
        + `Cause: ${(err as Error).message}`,
      );
    }

    this.data.signals = Array.isArray(snapshot?.signals) ? snapshot!.signals : [];
    this.data.idHighWaterMark = typeof snapshot?.idHighWaterMark === 'number'
      ? snapshot!.idHighWaterMark
      : this.inferHighWaterMark(this.data.signals);
    this.historySeq = this.inferHistorySeq();

    this.logger.info({
      signalCount: this.data.signals.length,
      idHighWaterMark: this.data.idHighWaterMark,
    }, 'SignalState restored');
  }

  private hasLegacyLog(): boolean {
    return this.historyFile.read().length > 0;
  }

  /** Derive the next history seq from existing history. */
  private inferHistorySeq(): number {
    let max = 0;
    for (const entry of this.historyFile.read()) {
      if (typeof entry?.seq === 'number' && entry.seq > max) max = entry.seq;
    }
    return max;
  }

  private inferHighWaterMark(signals: ControllerSignal[]): number {
    return signals.reduce((max, s) => {
      const n = parseInt(String(s.id).replace('sig-', ''), 10);
      return Number.isNaN(n) ? max : Math.max(max, n);
    }, 0);
  }

  /**
   * One-time migration from the pre-snapshot layout.
   *
   * Legacy `signals.jsonl` held signal bodies but could not express status
   * changes; legacy `state-events.jsonl` held them as whole-array snapshots.
   * Both are required to recover read/discarded — reading only the log would
   * silently mark every processed signal unread again.
   *
   * After the snapshot is written, this path is never taken for this session.
   */
  private migrateLegacy(): void {
    const legacySignals = this.historyFile.read() as unknown as ControllerSignal[];

    const byId = new Map<string, ControllerSignal>();
    for (const sig of legacySignals) {
      if (sig?.id) byId.set(sig.id, { ...sig });
    }

    this.replayLegacyStateEvents(byId);

    this.data.signals = Array.from(byId.values());
    this.data.idHighWaterMark = this.inferHighWaterMark(this.data.signals);
    this.historySeq = this.inferHistorySeq();

    // Snapshot written here is what makes migration run exactly once.
    this.commit();

    this.logger.info({
      signalCount: this.data.signals.length,
      idHighWaterMark: this.data.idHighWaterMark,
      historyPath: this.historyPath,
    }, 'SignalState migrated from legacy logs');
  }

  /**
   * Replay legacy `state-events.jsonl` to recover read/discarded status.
   * Legacy shape: { type, path, timestamp, prev, data }, where `data` is the
   * whole signals array after a `set`.
   */
  private replayLegacyStateEvents(byId: Map<string, ControllerSignal>): void {
    const eventsPath = join(this.snapshotPath, '..', 'state-events.jsonl');
    const eventsFile = new JSONLFileHelper<{ type?: string; path?: string; data?: unknown }>(eventsPath);
    const events = eventsFile.read();
    if (events.length === 0) return;

    for (const event of events) {
      if (event?.type !== 'set' || event?.path !== 'signals') continue;
      if (!Array.isArray(event.data)) continue;
      for (const sig of event.data as ControllerSignal[]) {
        if (!sig?.id) continue;
        const existing = byId.get(sig.id);
        if (existing) existing.status = sig.status;
      }
    }
  }
}
