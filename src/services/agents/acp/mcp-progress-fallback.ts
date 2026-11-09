/**
 * Progress fallback state machine for ACP workers with MCP available.
 *
 * `update_progress` is the primary channel. If the agent stays silent for the
 * configured idle window (default 120s), the LATEST COMPLETE REPLY is reported
 * once, capped at 20000 characters (cap only — never a summary). A reply is a
 * run of `agent_message_chunk`s grouped by messageId; a tool_call, a new
 * messageId, a new prompt or a turn end seals it. Thought / echo / tool-result
 * text never enters it.
 *
 * Every firing path goes through `canFire()` (the four guards live in the run
 * layer) and `stop()` (run finally / abort / turn loop exit) clears the timer,
 * so nothing is reported after turn end, cancel, abort or agent exit.
 */

import { MAX_PROGRESS_CHARS, PROGRESS_FALLBACK_MS, capText } from './mcp-schemas';

export interface ProgressFallbackOptions {
  canFire: () => boolean;
  emit: (message: string, source: 'fallback') => void;
  idleMs?: number;
  maxChars?: number;
  now?: () => number;
}

export type ProgressSource = 'mcp' | 'fallback' | 'session';

interface CompleteReply {
  id: string;
  text: string;
}

export class McpProgressTracker {
  private readonly canFire: () => boolean;
  private readonly emit: ProgressFallbackOptions['emit'];
  private readonly now: () => number;
  private idleMs: number;
  private maxChars: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastProgressAt = 0;
  private turnSeq = 0;
  private draftSerial = 0;
  private draft: { id: string; base: string; parts: string[] } | null = null;
  private lastCompleteReply: CompleteReply | null = null;
  private fallbackDoneForId: string | null = null;

  constructor(opts: ProgressFallbackOptions) {
    this.canFire = opts.canFire;
    this.emit = opts.emit;
    this.idleMs = opts.idleMs ?? PROGRESS_FALLBACK_MS;
    this.maxChars = opts.maxChars ?? MAX_PROGRESS_CHARS;
    this.now = opts.now ?? (() => Date.now());
  }

  setIdleMs(ms: number): void { this.idleMs = ms > 0 ? ms : PROGRESS_FALLBACK_MS; }
  get lastReply(): CompleteReply | null { return this.lastCompleteReply; }

  /** Task start: fresh state and a fresh idle window. */
  start(): void {
    this.stop();
    this.turnSeq = 0;
    this.draftSerial = 0;
    this.draft = null;
    this.lastCompleteReply = null;
    this.fallbackDoneForId = null;
    this.lastProgressAt = this.now();
    this.arm();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** A real update_progress (or the fallback itself) resets the idle window. */
  noteProgress(source: ProgressSource): void {
    if (source === 'mcp') this.fallbackDoneForId = null;
    this.lastProgressAt = this.now();
    this.arm();
  }

  /** New prompt / new messageId — new reply, new idle window. */
  noteNewMessage(): void {
    this.seal();
    this.turnSeq += 1;
    this.lastProgressAt = this.now();
    this.arm();
  }

  /** Turn end seals the reply; the run layer stops the tracker at loop exit. */
  noteTurnEnd(): void {
    this.seal();
    this.lastProgressAt = this.now();
    this.arm();
  }

  /** Tool calls seal the reply but do NOT stop the idle clock. */
  noteToolCall(): void {
    this.seal();
  }

  addAgentText(text: string, messageId?: string | null): void {
    if (!text) return;
    const base = messageId && messageId.length > 0 ? messageId : `turn-${this.turnSeq}`;
    if (this.draft && this.draft.base !== base) this.seal();
    if (!this.draft) {
      this.draftSerial += 1;
      this.draft = { id: `${base}#${this.draftSerial}`, base, parts: [] };
    }
    this.draft.parts.push(text);
  }

  /** Store the current draft as the latest complete reply. */
  private seal(): void {
    if (!this.draft) return;
    const { id, parts } = this.draft;
    this.draft = null;
    const text = parts.join('');
    if (text.trim()) this.lastCompleteReply = { id, text };
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
    if (this.now() - this.lastProgressAt < this.idleMs) {
      this.arm();
      return;
    }
    const reply = this.lastCompleteReply;
    if (!reply || this.fallbackDoneForId === reply.id) {
      this.arm();
      return;
    }
    this.fallbackDoneForId = reply.id;
    this.lastProgressAt = this.now();
    this.emit(capText(reply.text, this.maxChars), 'fallback');
    this.arm();
  }
}
