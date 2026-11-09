/**
 * Progress fallback state machine for ACP workers (MCP-available and degraded
 * runs alike — `update_progress` is primary, this is what remains when it
 * never fires).
 *
 * If the agent stays silent for the configured idle window (default 120s), the
 * NEW TEXT of the turn — everything sealed since the watermark, joined as one
 * message, exactly the text the conversation records — is reported once,
 * tail-clipped at PROGRESS_TAIL_CHARS with the absolute MAX_PROGRESS_CHARS
 * ceiling (cap only — never a summary).
 *
 * The tracker owns no text aggregation: a sealed segment's text IS the turn
 * writer's own aggregation (`AcpTurnWriter.openText()`), published here
 * through `noteMessageSealed(text, position)` when the run layer closes a
 * message — a new messageId, a tool call, or the turn end. Sealing never
 * emits anything; the segments accumulate so a report is the JOINED turn
 * text, never the last fragment (issue #64: knot renews messageId mid-message,
 * which carved one reply into per-chunk fragments).
 *
 * There are exactly two emission moments: the idle window expiring (`fire`)
 * and the turn end of the degraded path (`flush`, which does not wait out the
 * window). Both consume the accumulated segments: stale ones (at/before the
 * watermark — already covered by a real `update_progress`) are dropped, the
 * rest are joined and reported, and the watermark advances to the newest
 * reported position. Every firing path goes through `canFire()` (the four
 * guards live in the run layer) and `stop()` (run finally / abort / turn loop
 * exit) clears the timer, so nothing is reported after turn end, cancel, abort
 * or agent exit.
 */

import { MAX_PROGRESS_CHARS, PROGRESS_FALLBACK_MS, PROGRESS_TAIL_CHARS, capText, tailProgressText } from './mcp-schemas';

export interface ProgressFallbackOptions {
  canFire: () => boolean;
  emit: (message: string, source: 'fallback') => void;
  idleMs?: number;
  maxChars?: number;
  tailChars?: number;
  now?: () => number;
}

/**
 * Where a message sits in the run's text stream: the turn it belongs to and the
 * number of agent-text characters produced in that turn by its end. Positions
 * only ever move forward, so they order segments and a real `update_progress`
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

/** One sealed segment: the writer-aggregated text and where it ended. */
interface SealedSegment {
  text: string;
  position: ProgressPosition;
}

export class McpProgressTracker {
  private readonly canFire: () => boolean;
  private readonly emit: ProgressFallbackOptions['emit'];
  private readonly now: () => number;
  private idleMs: number;
  private readonly maxChars: number;
  private readonly tailChars: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastProgressAt = 0;
  /** Segments sealed since the last report, in stream order. */
  private pending: SealedSegment[] = [];
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
    this.tailChars = opts.tailChars ?? PROGRESS_TAIL_CHARS;
    this.now = opts.now ?? (() => Date.now());
  }

  setIdleMs(ms: number): void { this.idleMs = ms > 0 ? ms : PROGRESS_FALLBACK_MS; }

  /** Task start: fresh state and a fresh idle window. */
  start(): void {
    this.stop();
    this.pending = [];
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
   * channel carries no message id and takes no part in the dedupe.
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
   * segment accumulates until the next report; it is never dropped in favor of
   * a later one.
   */
  noteMessageSealed(text: string, position: ProgressPosition): void {
    this.pending.push({ text, position });
  }

  /**
   * Report the turn's closed-but-unreported text NOW (turn end on the
   * degraded path — no need to wait out the idle window). Returns whether
   * anything was emitted; either way the idle window restarts.
   */
  flush(): boolean {
    if (!this.canFire()) return false;
    const { text, position } = this.takeUnreported();
    this.lastProgressAt = this.now();
    if (!text) {
      this.arm();
      return false;
    }
    if (isAfter(position, this.watermark)) this.watermark = position;
    this.emit(capText(tailProgressText(text, this.tailChars), this.maxChars), 'fallback');
    this.arm();
    return true;
  }

  /**
   * Consume the accumulated segments: stale ones (at/before the watermark — a
   * real update_progress already covered them) are dropped, the rest are
   * joined into one message ending at the newest position.
   */
  private takeUnreported(): { text: string; position: ProgressPosition } {
    while (this.pending.length > 0 && !isAfter(this.pending[0].position, this.watermark)) {
      this.pending.shift();
    }
    if (this.pending.length === 0) return { text: '', position: this.watermark };
    const position = this.pending[this.pending.length - 1].position;
    const text = this.pending.map((segment) => segment.text).join('');
    this.pending = [];
    return { text, position };
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
