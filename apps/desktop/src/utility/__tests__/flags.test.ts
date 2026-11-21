import { describe, it, expect } from 'vitest';
import { parseHostFlags } from '../flags';

describe('parseHostFlags', () => {
  it('parses value flags, boolean flags, and log-level default', () => {
    const flags = parseHostFlags([
      '--config', '/tmp/c.json',
      '--data-dir', '/tmp/data',
      '--workspace-dir', '/tmp/ws',
      '--session', 'new',
      '--inject-previous-tasks',
    ]);
    expect(flags).toEqual({
      config: '/tmp/c.json',
      dataDir: '/tmp/data',
      workspaceDir: '/tmp/ws',
      session: 'new',
      logLevel: 'info',
      injectPreviousTasks: true,
    });
  });

  it('keeps an explicit log level and rejects missing required flags', () => {
    const flags = parseHostFlags([
      '--config', 'c', '--data-dir', 'd', '--workspace-dir', 'w',
      '--session', 'resume:abc-1', '--log-level', 'debug',
    ]);
    expect(flags.logLevel).toBe('debug');
    expect(flags.session).toBe('resume:abc-1');
    expect(() => parseHostFlags(['--config', 'c'])).toThrow(/Missing --data-dir/);
  });
});
