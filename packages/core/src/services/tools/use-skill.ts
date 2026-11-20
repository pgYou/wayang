import { z } from 'zod';
import { defineTool, safeExecute } from './common';
import type { SkillRegistry } from '@/services/skills/registry';
import type { SkillContent } from '@/services/skills/types';

/**
 * Format a loaded skill into a single text payload for the LLM.
 *
 * Includes the body verbatim and lists resource files (relative to the skill
 * dir) so the agent can invoke them with its existing shell/file tools.
 * Resource scripts are never executed here — the agent decides how to use them.
 */
function formatSkillContent(skill: SkillContent): string {
  const header = `# Skill: ${skill.name}\n\n${skill.description}\n\nLocation: ${skill.dir}`;
  const resources = skill.resources.length
    ? `\n\n## Resources\n${skill.resources.map((r: string) => `- \`${r}\``).join('\n')}\n\nInvoke resource files via your shell/file tools using the absolute path under the skill location above.`
    : '';
  return `${header}\n\n---\n\n${skill.content}${resources}`;
}

/**
 * `use_skill` — load a skill's full instructions on demand.
 *
 * Both the Controller and puppet Worker receive this tool, backed by the shared
 * {@link SkillRegistry}. The claude-code worker has no Wayang tools, so it can't
 * call this — it discovers skills via the catalog in its prompt instead.
 */
export function useSkillTool(deps: { registry: SkillRegistry }) {
  return defineTool({
    description:
      'Load a skill\'s full instructions by name. Skills are on-demand expertise ' +
      '(workflows, conventions, scripts). Use this when a task matches a skill ' +
      'in the "Skills" section. Returns the skill body plus a list of its ' +
      'resource files (invoke those with your shell/file tools, not here).',
    parameters: z.object({
      name: z.string().describe('Skill name, exactly as shown in the "Skills" section'),
    }),
    execute: safeExecute('use-skill', async ({ name }) => {
      const content = deps.registry.get(name);
      if (!content) {
        const available = deps.registry.list().map((s) => s.name).sort();
        const hint = available.length ? ` Available skills: ${available.join(', ')}` : '';
        return `[ERROR] use-skill: skill "${name}" not found.${hint}`;
      }
      return formatSkillContent(content);
    }),
  });
}
