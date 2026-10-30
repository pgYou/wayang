import { describe, it, expect } from 'vitest';
import { buildChatLookups, formatWorkerTag } from '@/tui/utils/chat-lookups';
import type { DisplayItem } from '@/tui/types/display-item';

/** Self-contained signal item factory — no shared mutable fixtures. */
function signal(overrides: Partial<DisplayItem>): DisplayItem {
  return {
    id: `sig-${Math.random().toString(36).slice(2)}`,
    timestamp: 0,
    read: true,
    role: 'signal',
    content: '',
    ...overrides,
  };
}

describe('buildChatLookups', () => {
  it('indexes permission requests by requestId with the asking worker', () => {
    const lookups = buildChatLookups([
      signal({
        subtype: 'permission_request',
        workerId: 'w-1-t0sr',
        workerType: 'puppet',
        emoji: '🧸',
        taskTitle: '0.5.2-B2a /context',
        permissionMeta: { requestId: 'perm-1-7xvt', toolName: 'bash', toolArgs: { command: 'ls' } },
      }),
    ]);

    const req = lookups.permissionRequests.get('perm-1-7xvt');
    expect(req?.meta.toolName).toBe('bash');
    expect(req?.worker).toMatchObject({ workerId: 'w-1-t0sr', emoji: '🧸', taskTitle: '0.5.2-B2a /context' });
  });

  it('keeps the latest task title per worker and the first emoji per worker type', () => {
    const lookups = buildChatLookups([
      signal({ workerId: 'w-2', workerType: 'claude-code', emoji: '🦀', taskTitle: 'stage 1' }),
      signal({ workerId: 'w-2', taskTitle: 'stage 2' }),
    ]);

    expect(lookups.workers.get('w-2')).toMatchObject({ emoji: '🦀', workerType: 'claude-code', taskTitle: 'stage 2' });
    expect(lookups.workerTypeEmoji.get('claude-code')).toBe('🦀');
  });

  it('ignores non-signal items', () => {
    const lookups = buildChatLookups([
      { id: 'u1', timestamp: 0, read: true, role: 'user', content: 'hi', workerId: 'w-x' },
    ]);
    expect(lookups.workers.size).toBe(0);
  });
});

describe('formatWorkerTag', () => {
  it('joins emoji, task title and short worker id', () => {
    expect(formatWorkerTag({ emoji: '🧸', taskTitle: 'task', workerId: 'w-123-abcd' })).toBe('🧸 task · w:abcd');
  });

  it('omits unknown parts', () => {
    expect(formatWorkerTag({ workerId: 'w-123-abcd' })).toBe('w:abcd');
    expect(formatWorkerTag({})).toBe('');
  });
});
