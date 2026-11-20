// Kitty keyboard protocol: decoding the CSI u Enter reports Ink 4 cannot parse.

/**
 * Decode a CSI u key report for Enter coming from a terminal with the kitty
 * keyboard protocol active (its "report all keys as escape codes" mode).
 * Ink 4 cannot parse these sequences, so they arrive as their literal text
 * with the leading ESC already stripped: `'[13;5u'` for Ctrl+Enter,
 * `'[13;3u'` for Alt+Enter. Per the protocol: `13` is Enter's code point,
 * the second field is `1 + modifier bits` (shift=1, alt=2, ctrl=4), and an
 * optional `:event` suffix distinguishes press (1), repeat (2) and release
 * (3).
 *
 * Returns the decoded modifiers and event type when the sequence is an
 * Enter with Alt or Ctrl held — the newline variants — and `null` for
 * everything else (other keys, plain or shift-only Enter).
 */
const CSI_ENTER_RE = /^\[13;(\d+)(?::(\d))?u$/;
export function matchCsiEnter(s: string): { modifiers: number; event: number } | null {
  const m = CSI_ENTER_RE.exec(s);
  if (!m) return null;
  const modifiers = Number(m[1]) - 1; // the wire value is 1 + the bit field
  // Shift-only Enter stays unbound: in every legacy terminal it is
  // byte-identical to plain Enter, so it must not grow a meaning only an
  // enhanced keyboard can trigger.
  if ((modifiers & 0b110) === 0) return null;
  return { modifiers, event: m[2] === undefined ? 1 : Number(m[2]) };
}
