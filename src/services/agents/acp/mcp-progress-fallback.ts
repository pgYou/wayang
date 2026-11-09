/**
 * Progress fallback state machine for ACP workers (MCP-available and degraded
 * runs alike — `update_progress` is primary, this is what remains when it
 * never fires).
 *
 * If the agent stays silent for the configured idle window (default 120s), the
 * LATEST COMPLETE REPLY TEXT is reported once, verbatim, capped at
 * MAX_PROGRESS_CHARS (cap only — never a summary, never a join).
 *
 * The tracker owns no text. The conversation layer (AcpTurnWriter) already
 * aggregates streamed chunks into complete entries at the turn's natural
 * boundaries (a tool call, the turn end); the run layer hands the latest
 * flushed entry here through `noteReplySealed(text, position)` when one
 * closes. The tracker keeps exactly that one latest entry — the peer's
 * messageIds are irrelevant at this layer: whatever id-shape the agent sends,
 * the transcript layer has already absorbed it (#64: a knot reply arrives as
 * several messages; the transcript joins them into one entry, and the
 * fallback replays that entry).
 *
 * There are exactly two emission moments: the idle window expiring (`fire`)
 * and the turn end of the degraded path (`flush`, which does not wait out the
 * window). Every firing path goes through `canFire()` (the guards live in the
 * run layer). ONE watermark orders the whole stream: a real `update_progress`
 * advances it to the CURRENT position (everything produced so far counts as
 * reported — the MCP channel carries no text identity), and a fallback report
 * advances it to the entry it emitted, so the same entry is never replayed.
 * `stop()` (run finally / abort / turn loop exit) clears the timer, so nothing
 * is reported after turn end, cancel, abort or agent exit.
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
 * Where an entry sits in the run's text stream: the turn it belongs to and the
 * number of agent-text characters produced in that turn by its end. Positions
 * only ever move forward, so they order entries and a real `update_progress`
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

/** The latest complete transcript entry: its text and where it ended. */
export interface SealedReply {
  text: string;
  position: ProgressPosition;
}

export class McpProgressTracker {
  private readonly canFire: () => boolean;
  private readonly emit: ProgressFallbackOptions['emit'];
  private readonly now: () => number;
  private idleMs: number;
  private readonly maxChars: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastProgressAt = 0;
  /** The latest complete entry handed by the run layer (single slot). */
  private reply: SealedReply | null = null;
  /**
   * Everything up to here counts as reported — by a real `update_progress`
   * (to the CURRENT position) or by the fallback itself (to the entry it
   * emitted). A candidate at/before this line is stale.
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

  /** Task start: fresh state and a fresh idle window. */
  start(): void {
    this.stop();
    this.reply = null;
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
   * A real update_progress resets the idle window and advances the watermark
   * to the current position: everything produced so far counts as reported,
   * so a later window must not re-announce it. The MCP channel carries no
   * message id and takes no part in any dedupe.
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
   * One complete entry flushed to the transcript (a tool call closed the open
   * segment, or the turn ended). The text IS the writer's own aggregation —
   * this tracker never joins chunks and never keeps more than the latest
   * entry. Sealing never emits anything.
   */
  noteReplySealed(text: string, position: ProgressPosition): void {
    this.reply = { text, position };
  }

  /**
   * Report the latest complete, never-reported entry NOW (turn end on the
   * degraded path — no need to wait out the idle window). Verbatim, capped at
   * maxChars; never a join, never a summary. Returns whether anything was
   * emitted; either way the idle window restarts.
   */
  flush(): boolean {
    if (!this.canFire()) return false;
    const reply = this.reply;
    this.lastProgressAt = this.now();
    if (!reply || !isAfter(reply.position, this.watermark)) {
      this.arm();
      return false;
    }
    this.watermark = reply.position;
    this.emit(capText(reply.text, this.maxChars), 'fallback');
    this.arm();
    return true;
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
