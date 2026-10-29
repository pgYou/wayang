/**
 * Persistence helper contract.
 *
 * A helper owns the storage strategy for exactly one state field. The state
 * class never talks to files directly — it hands the helper a structured
 * change and lets the helper decide how to persist it.
 */

/** Operation that triggered the persist call. */
export type PersistOp = 'set' | 'update' | 'append' | 'remove';

export interface PersistContext<T = unknown> {
  /** Top-level state field being persisted (e.g. 'signals'). */
  path: string;
  /** Which state operation caused this persist. */
  op: PersistOp;
  /** Latest full value of the field AFTER the operation. */
  value: T;
  /** The entry passed to append(), when op === 'append' and the field is a log. */
  entry?: unknown;
}

export interface IPersistenceHelper<T = unknown> {
  /**
   * Storage semantics, not file semantics.
   * - 'snapshot': full replace — the field's whole value is the source of truth.
   * - 'append':   append-only log — entries are immutable once written, and the
   *               in-memory array is a window that MAY be shorter than history.
   */
  readonly mode: 'save' | 'append';

  /** Persist a state change. */
  write(change: PersistContext<T>): void;

  /** Load the persisted value, or null when absent/unreadable. */
  read(): unknown;

  readFromEnd?(stopCondition: (entry: any) => boolean): any[];

  clear(): void;
}
