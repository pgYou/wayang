/**
 * System prompt for third-party agent workers (e.g. Claude Code).
 *
 * Prepended to the task description via the SDK prompt parameter,
 * since third-party SDKs typically don't expose a separate system prompt field.
 */

const RULES = [
  '<Rules>',
  'Output plain text only. No Markdown formatting.',
  'Report meaningful progress as you work (entering a new phase, completing a sub-step, recovering from an error).',
  'Do NOT output a final summary right before completing — the system already captures the result separately.',
  'Match the language of the task description.',
  '</Rules>',
].join('\n');

/**
 * Build a prefix to prepend to the task prompt for third-party workers.
 * Returns the instruction block followed by a separator, ready to concatenate with the task description.
 */
export function buildThirdPartyPrompt(): string {
  return `${RULES}\n\n---\n\n`;
}
