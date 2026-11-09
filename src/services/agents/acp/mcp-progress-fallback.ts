/**
 * Progress fallback state machine for ACP workers (MCP-available and degraded
 * runs alike — `update_progress` is primary, this is what remains when it
 * never fires).
 *
 * If the agent stays silent for the configured idle window (default 120s), the
 * LATEST COMPLETE MESSAGE is reported once, capped at 20000 characters (cap
 * only — never a summary).
 *
 * The tracker owns no text: a message's text IS the turn writer's own
 * aggregation (`AcpTurnWriter.openText()`), published here through
 * `noteMessageSealed(id, text, position)` when the run layer closes a message —
 * a new messageId, a tool call, or the turn end. The tracker stores only that
 * latest closed message plus the id it already reported, so the chunk-to-message
 * joining exists exactly once in the process.
 *
 * Sealing never emits anything. There are exactly two emission moments: the
 * idle window expiring (`fire`) and the turn end of the degraded path
 * (`flush`, which does not wait out the window). Every firing path goes through
 * `canFire()` (the four guards live in the run layer) and `stop()` (run finally /
 * abort / turn loop exit) clears the timer, so nothing is reported after turn
 * end, cancel, abort or agent exit.
 */

import { MAX_PROGRESS_CHARS, PROGRESS_FALLBACK_MS, capText } from './mcp-schemas';

export interface ProgressFallbackOptions {
  canFire: () => boolean;
  emit: (message: string, source: 'fallback') => void;
  idleMs?: number;
  maxChars?: number;
  now?: () => number;
}

/**
 * Where a message sits in the run's text stream: the turn it belongs to and the
 * number of agent-text characters produced in that turn by its end. Positions
 * only ever move forward, so they order messages and a real `update_progress`
 * (which carries no text identity) can advance a watermark to "here".
 */
export interface ProgressPosition {
  turn: number;
  chars: number;
}

/** True when `a` lies strictly after `b` in the run's text stream. */
function isAfter(a: ProgressPosition, b: ProgressPosition): boolean {
  return a.turn > b.turn || (a.turn === b.turn && a.chars > b.chars);
}

/** One closed message: dedupe key, text and where it ended. */
export interface SealedMessage {
  id: string;
  text: string;
  position: ProgressPosition;
}

export class McpProgressTracker {
  private readonly canFire: () => boolean;
  private readonly emit: ProgressFallbackOptions['emit'];
  private readonly now: () => number;
  private idleMs: number;
  private maxChars: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastProgressAt = 0;
  private lastSealedMessage: SealedMessage | null = null;
  /** Key of the last fallback report — one scalar, no id set. */
  private reportedId: string | null = null;
  /**
   * Everything up to here was already reported by a real `update_progress`;
   * a candidate older than this line is stale and must not be re-announced.
   */
  private watermark: ProgressPosition = { turn: 0, chars: 0 };

  constructor(opts: ProgressFallbackOptions) {
    this.canFire = opts.canFire;
    this.emit = opts.emit;
    this.idleMs = opts.idleMs ?? PROGRESS_FALLBACK_MS;
    this.maxChars = opts.maxChars ?? MAX_PROGRESS_CHARS;
    this.now = opts.now ?? (() => Date.now());
  }

  setIdleMs(ms: number): void { this.idleMs = ms > 0 ? ms : PROGRESS_FALLBACK_MS; }
  get lastReply(): SealedMessage | null { return this.lastSealedMessage; }

  /** Task start: fresh state and a fresh idle window. */
  start(): void {
    this.stop();
    this.lastSealedMessage = null;
    this.reportedId = null;
    this.watermark = { turn: 0, chars: 0 };
    this.lastProgressAt = this.now();
    this.arm();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * A real update_progress (or the fallback itself) resets the idle window and
   * advances the watermark to the current position: everything produced so far
   * counts as reported, so a later window must not re-announce it. The MCP
   * channel carries no message id and takes no part in the key dedupe.
   */
  noteProgress(position: ProgressPosition): void {
    if (isAfter(position, this.watermark)) this.watermark = position;
    this.lastProgressAt = this.now();
    this.arm();
  }

  /** New prompt / turn start: new idle window. Emits nothing by itself. */
  noteNewMessage(): void {
    this.lastProgressAt = this.now();
    this.arm();
  }

  /** Turn end resets the idle window. Emits nothing by itself. */
  noteTurnEnd(): void {
    this.lastProgressAt = this.now();
    this.arm();
  }

  /**
   * One message closed (new messageId / tool call / turn end). The text comes
   * from the turn writer's aggregation — this tracker never joins chunks. The
   * key is compared scalarly against the last reported one; no id set is kept.
   */
  noteMessageSealed(id: string, text: string, position: ProgressPosition): void {
    this.lastSealedMessage = { id, text, position };
  }

  /**
   * Report the latest closed, never-reported message NOW (turn end on the
   * degraded path — no need to wait out the idle window). Returns whether
   * anything was emitted; either way the idle window restarts.
   */
  flush(): boolean {
    if (!this.canFire()) return false;
    const reply = this.unreported();
    this.lastProgressAt = this.now();
    if (!reply) {
      this.arm();
      return false;
    }
    this.reportedId = reply.id;
    if (isAfter(reply.position, this.watermark)) this.watermark = reply.position;
    this.emit(capText(reply.text, this.maxChars), 'fallback');
    this.arm();
    return true;
  }

  /**
   * The latest closed message, unless it was already reported by key or it ends
   * at/before the watermark (a real update_progress already covered it — stale).
   */
  private unreported(): SealedMessage | null {
    const reply = this.lastSealedMessage;
    if (!reply) return null;
    if (this.reportedId === reply.id) return null;
    return isAfter(reply.position, this.watermark) ? reply : null;
  }

  private arm(): void {
    this.stop();
    if (!this.canFire()) return;
    const remaining = Math.max(0, this.idleMs - (this.now() - this.lastProgressAt));
    this.timer = setTimeout(() => this.fire(), remaining);
    this.timer.unref?.();
  }

  private fire(): void {
    this.timer = null;
    if (!this.canFire()) return;
    // Early wake-up (timer rounding): wait for the real window.
    if (this.now() - this.lastProgressAt < this.idleMs) {
      this.arm();
      return;
    }
    // Nothing new to say → stay silent and wait another FULL window (flush
    // restarts the window in both cases, so an empty window cannot spin).
    this.flush();
  }
}
