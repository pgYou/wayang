/**
 * Unified write-layer fallback cap for tool outputs stored in transcripts
 * (issue #53).
 *
 * First line of defense stays at the tool layer (`safeExecute`'s 8000 chars,
 * claude-code's `CLAUDE_TOOL_RESULT_STORE_CHARS`). This module is the LAST
 * line, applied where transcript entries are BUILT (`buildAssistantEntry`,
 * claude tool records): a tool that forgot the wrapper, or one that
 * deliberately raises its return cap (read-worker-conversation), must still
 * not write an unbounded payload into `conversation.jsonl` — a huge entry
 * bloats the transcript, the controller-side re-reads, and every later
 * context replay.
 *
 * Truncation strategy (matches the annotation style of the transcript
 * readers): keep head AND tail with a marker naming the omitted amount —
 * head-heavy, because tool output front matter (command echo, first
 * findings) is usually the informative part.
 */

/** Default fallback cap for one stored tool result (chars). */
export const TOOL_OUTPUT_MAX_CHARS = 20_000;

/**
 * Effective cap: `WAYANG_TOOL_OUTPUT_MAX_CHARS` overrides the constant at
 * runtime (positive integers only; anything else falls back to the default).
 * Read per call so environments (and tests) can switch it without a reload.
 */
export function resolveToolOutputMaxChars(): number {
  const raw = process.env.WAYANG_TOOL_OUTPUT_MAX_CHARS;
  if (!raw) return TOOL_OUTPUT_MAX_CHARS;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : TOOL_OUTPUT_MAX_CHARS;
}

/**
 * Clamp `text` to at most `maxChars` (result length never exceeds it):
 * `head + marker + tail`, the marker naming the omitted and total char
 * counts, e.g. `… [omitted 8123 of 1048576 chars] …`. Text at or under the
 * cap passes through untouched.
 */
export function clampToolOutput(text: string, maxChars: number = resolveToolOutputMaxChars()): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;

  const markerFor = (kept: number) => `… [omitted ${text.length - kept} of ${text.length} chars] …`;
  // Budget split: 70% head / 20% tail, ~10% left for the marker; shrink
  // head/tail until everything fits (a bigger marker number can grow the
  // marker by a digit, hence the loop instead of a one-shot split).
  let head = Math.floor(maxChars * 0.7);
  let tail = Math.floor(maxChars * 0.2);
  let marker = markerFor(head + tail);
  let overflow = head + marker.length + tail - maxChars;
  while (overflow > 0 && head + tail > 0) {
    if (head >= tail) head -= Math.min(overflow, head);
    else tail -= Math.min(overflow, tail);
    marker = markerFor(head + tail);
    overflow = head + marker.length + tail - maxChars;
  }
  if (head + tail === 0) {
    // Degenerate cap — too small for head + marker + tail: plain head cut
    // with a bare ellipsis, still exactly maxChars.
    return `${text.slice(0, Math.max(maxChars - 1, 0))}…`;
  }
  return text.slice(0, head) + marker + text.slice(text.length - tail);
}
