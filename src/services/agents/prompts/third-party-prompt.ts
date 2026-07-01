/**
 * System prompt for third-party agent workers (e.g. Claude Code).
 *
 * Prepended to the task description via the SDK prompt parameter,
 * since third-party SDKs typically don't expose a separate system prompt field.
 */

import type { SkillRegistry } from '@/services/skills/registry';
import { buildSkillCatalog } from './prompt-utils';

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
 *
 * Third-party workers have no access to Wayang's `use_skill` tool, so when
 * skills exist the catalog includes each skill's directory — the worker is
 * expected to read `<dir>/SKILL.md` with its own file tools to load one.
 * Returns the instruction block followed by a separator, ready to concatenate
 * with the task description.
 */
export function buildThirdPartyPrompt(skills: SkillRegistry): string {
  const catalog = buildSkillCatalog(skills, true);
  const skillsNote = catalog
    ? `${catalog}\n\nYou do NOT have a use_skill tool. To use a skill, read its \`SKILL.md\` (at the directory shown above) with your own file-reading tools.`
    : '';
  return [RULES, skillsNote, '---'].filter(Boolean).join('\n\n') + '\n\n';
}
