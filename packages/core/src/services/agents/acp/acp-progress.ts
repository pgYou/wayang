/**
 * AcpProgress — the run layer's progress wiring around McpProgressTracker:
 * the single choke point for real `update_progress` and the idle fallback,
 * plus the bridge from the transcript layer (AcpTurnWriter) to the tracker.
 *
 * The text exists exactly once in the process: AcpTurnWriter aggregates the
 * streamed chunks into complete entries (a tool call or the turn end closes
 * the open segment); `recordReply()` hands the latest flushed entry to the
 * tracker, which replays it verbatim when the idle window expires or (on the
 * degraded path) the turn ends. This layer keeps no copy of any text.
 */

import { McpProgressTracker, type ProgressPosition } from './mcp-progress-fallback';
import { capText } from './mcp-schemas';
import type { AcpTurnWriter } from './acp-turn-writer';

/** Whitespace/punctuation-only text (e.g. a lone "。") is not progress. */
const PROGRESS_FILLER_RE = /[\s\p{P}]/gu;

/** True when the text still has substance once whitespace/punctuation are removed. */
function hasProgressSubstance(text: string): boolean {
  return text.replace(PROGRESS_FILLER_RE, '').length > 0;
}

export interface AcpProgressDeps {
  /** The run guards: no progress after turn end / cancel / abort / agent exit. */
  canFire: () => boolean;
  /** Engine progress callback (may be absent on direct construction). */
  onProgress: (msg: string) => void;
  /** The turn writer — the single text aggregation (the transcript layer). */
  writer: AcpTurnWriter;
  /** Where the run currently is in its own text stream (turn + chars so far). */
  position: () => ProgressPosition;
  /** Idle window override (config `mcp.fallbackMs`); default 120s. */
  idleMs?: number;
}

export class AcpProgress {
  readonly tracker: McpProgressTracker;
  private readonly deps: AcpProgressDeps;

  constructor(deps: AcpProgressDeps) {
    this.deps = deps;
    this.tracker = new McpProgressTracker({
      canFire: deps.canFire,
      emit: (message) => deps.onProgress(message),
      ...(deps.idleMs !== undefined && { idleMs: deps.idleMs }),
    });
  }

  /** Task start: fresh tracker state and a fresh idle window. */
  start(): void { this.tracker.start(); }

  /** Run finally / abort / loop exit: never report after this. */
  stop(): void { this.tracker.stop(); }

  /** New prompt / turn start: new idle window. */
  noteNewMessage(): void { this.tracker.noteNewMessage(); }

  /** Turn end resets the idle window. */
  noteTurnEnd(): void { this.tracker.noteTurnEnd(); }

  /**
   * Single choke point for a real `update_progress` (the MCP tool layer calls
   * this). Guards FIRST — a late tool call must not re-arm the idle timer
   * either — then advance the watermark to the current position: everything
   * produced so far counts as announced.
   */
  report(message: string): void {
    if (!this.deps.canFire()) return;
    this.tracker.noteProgress(this.deps.position());
    this.deps.onProgress(capText(message));
  }

  /**
   * One complete entry flushed to the transcript (a tool call closed the open
   * segment, or the turn ended and finishTurn wrote it): hand it to the
   * tracker as the fallback candidate. Recording never emits anything.
   */
  recordReply(): void {
    if (!this.deps.canFire()) return;
    const text = this.deps.writer.lastText();
    if (text === null || text.length === 0) return;
    if (!hasProgressSubstance(text)) return;
    this.tracker.noteReplySealed(text, this.deps.position());
  }

  /**
   * Turn-end catch-up on the degraded path: report the latest complete,
   * never-reported entry NOW instead of waiting out the idle window.
   */
  flush(): boolean { return this.tracker.flush(); }
}
