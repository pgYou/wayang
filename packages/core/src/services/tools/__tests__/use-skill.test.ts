import { describe, it, expect } from 'vitest';
import { useSkillTool } from '@/services/tools/use-skill';
import { SkillRegistry } from '@/services/skills/registry';

async function exec(toolObj: any, args: any): Promise<string> {
  return toolObj.execute(args);
}

describe('useSkillTool', () => {
  it('returns formatted content for an existing skill', async () => {
    const reg = new SkillRegistry([]);
    // Inject a descriptor + cached content directly to avoid fs setup here.
    (reg as any).descriptors.set('demo', { name: 'demo', description: 'Demo', dir: '/skills/demo' });
    (reg as any).cache.set('demo', {
      name: 'demo',
      description: 'Demo',
      dir: '/skills/demo',
      content: 'Step 1. Do the thing.',
      resources: ['run.sh'],
    });

    const tool = useSkillTool({ registry: reg });
    const result = await exec(tool, { name: 'demo' });

    expect(result).toContain('# Skill: demo');
    expect(result).toContain('Step 1. Do the thing.');
    expect(result).toContain('## Resources');
    expect(result).toContain('run.sh');
  });

  it('omits the Resources section when none exist', async () => {
    const reg = new SkillRegistry([]);
    (reg as any).descriptors.set('bare', { name: 'bare', description: 'Bare', dir: '/skills/bare' });
    (reg as any).cache.set('bare', {
      name: 'bare',
      description: 'Bare',
      dir: '/skills/bare',
      content: 'Just text.',
      resources: [],
    });

    const tool = useSkillTool({ registry: reg });
    const result = await exec(tool, { name: 'bare' });
    expect(result).not.toContain('## Resources');
  });

  it('returns error with available skills when name is unknown', async () => {
    const reg = new SkillRegistry([]);
    (reg as any).descriptors.set('alpha', { name: 'alpha', description: 'A', dir: '/x' });
    (reg as any).descriptors.set('beta', { name: 'beta', description: 'B', dir: '/y' });

    const tool = useSkillTool({ registry: reg });
    const result = await exec(tool, { name: 'missing' });
    expect(result).toContain('[ERROR]');
    expect(result).toContain('"missing" not found');
    expect(result).toContain('alpha');
    expect(result).toContain('beta');
  });

  it('returns plain error when no skills are registered', async () => {
    const reg = new SkillRegistry([]);
    const tool = useSkillTool({ registry: reg });
    const result = await exec(tool, { name: 'whatever' });
    expect(result).toContain('[ERROR]');
    expect(result).not.toContain('Available skills');
  });
});
