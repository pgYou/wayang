import { describe, it, expect } from 'vitest';
import { entryToDisplayItem, signalToDisplayItem } from '@/tui/types/display-item';
import { EEntryType, ESignalSubtype, ESystemSubtype } from '@/types/conversation';
import type { ConversationEntry, UserEntry, AssistantEntry, SignalEntry, SystemEntry } from '@/types/conversation';
import type { ControllerSignal } from '@/types/signal';

// --- entryToDisplayItem ---

describe('entryToDisplayItem', () => {
  const makeUserEntry = (content: string): UserEntry => ({
    type: EEntryType.User,
    uuid: 'u-1',
    parentUuid: null,
    sessionId: 'controller',
    timestamp: new Date().toISOString(),
    message: { role: 'user', content },
  });

  const makeAssistantEntry = (content: string, overrides?: Partial<AssistantEntry>): AssistantEntry => ({
    type: EEntryType.Assistant,
    uuid: 'a-1',
    parentUuid: null,
    sessionId: 'controller',
    timestamp: new Date().toISOString(),
    message: { role: 'assistant', content },
    ...overrides,
  });

  const makeSignalEntry = (overrides?: Partial<SignalEntry>): SignalEntry => ({
    type: EEntryType.Signal,
    uuid: 'sig-1',
    parentUuid: null,
    sessionId: 'controller',
    timestamp: new Date().toISOString(),
    subtype: ESignalSubtype.WorkerProgress,
    workerId: 'w-001',
    workerType: 'puppet',
    emoji: '\u{1F9F8}',
    taskId: 't-001',
    taskTitle: 'Build module',
    content: 'Compiling...',
    ...overrides,
  });

  const makeSystemEntry = (overrides?: Partial<SystemEntry>): SystemEntry => ({
    type: EEntryType.System,
    uuid: 'sys-1',
    parentUuid: null,
    sessionId: 'controller',
    timestamp: new Date().toISOString(),
    subtype: ESystemSubtype.Error,
    content: 'something happened',
    ...overrides,
  });

  it('should convert user entry', () => {
    const item = entryToDisplayItem(makeUserEntry('hello'));
    expect(item).toMatchObject({ role: 'user', content: 'hello' });
  });

  it('should convert assistant entry with sections', () => {
    const entry = makeAssistantEntry('response text', {
      toolCalls: [{ toolCallId: 'tc-1', toolName: 'add_task', arguments: '{}' }],
      toolResults: [{ toolCallId: 'tc-1', toolName: 'add_task', output: { type: 'text', value: 'ok' } }],
    });
    const item = entryToDisplayItem(entry)!;
    expect(item.role).toBe('assistant');
    expect(item.sections).toHaveLength(3); // content + tool_call + tool_result
  });

  it('should return null for skip_reply entries', () => {
    const entry = makeAssistantEntry('', {
      toolCalls: [{ toolCallId: 'tc-1', toolName: 'skip_reply', arguments: '{}' }],
    });
    expect(entryToDisplayItem(entry)).toBeNull();
  });

  it('should extract workerType, emoji, taskTitle from signal entry', () => {
    const item = entryToDisplayItem(makeSignalEntry());
    expect(item).toMatchObject({
      role: 'signal',
      subtype: 'worker_progress',
      content: 'Compiling...',
      workerType: 'puppet',
      emoji: '\u{1F9F8}',
      taskId: 't-001',
      taskTitle: 'Build module',
      workerId: 'w-001',
    });
  });

  it('should handle completed signal entry with all fields', () => {
    const item = entryToDisplayItem(makeSignalEntry({
      subtype: ESignalSubtype.WorkerCompleted,
      content: 'Done successfully',
      workerType: 'claude-code',
      emoji: '\u{1F9E0}',
      taskTitle: 'Refactor code',
    }));
    expect(item).toMatchObject({
      subtype: 'worker_completed',
      content: 'Done successfully',
      workerType: 'claude-code',
      emoji: '\u{1F9E0}',
      taskTitle: 'Refactor code',
    });
  });

  it('should handle signal entry with optional fields missing', () => {
    const item = entryToDisplayItem(makeSignalEntry({
      workerType: undefined,
      emoji: undefined,
      taskId: undefined,
    }));
    expect(item!.workerType).toBeUndefined();
    expect(item!.emoji).toBeUndefined();
    expect(item!.taskId).toBeUndefined();
    expect(item!.taskTitle).toBe('Build module'); // still present from makeSignalEntry
  });

  it('should pass permissionMeta through for permission_request signal entries', () => {
    const item = entryToDisplayItem(makeSignalEntry({
      subtype: ESignalSubtype.PermissionRequest,
      content: '[PERMISSION REQUEST] Worker w-001 wants to run bash.',
      permissionMeta: {
        requestId: 'perm-1-abcd',
        toolName: 'bash',
        toolArgs: { command: 'rm -rf /tmp' },
        description: 'Execute shell command: rm -rf /tmp',
      },
    }));
    expect(item).toMatchObject({
      role: 'signal',
      subtype: 'permission_request',
      content: '[PERMISSION REQUEST] Worker w-001 wants to run bash.',
      permissionMeta: {
        requestId: 'perm-1-abcd',
        toolName: 'bash',
        toolArgs: { command: 'rm -rf /tmp' },
        description: 'Execute shell command: rm -rf /tmp',
      },
    });
  });

  it('should leave permissionMeta undefined for legacy permission_request entries', () => {
    const item = entryToDisplayItem(makeSignalEntry({
      subtype: ESignalSubtype.PermissionRequest,
      content: '[PERMISSION REQUEST] legacy flattened text',
    }));
    expect(item!.permissionMeta).toBeUndefined();
    expect(item!.subtype).toBe('permission_request');
    expect(item!.content).toBe('[PERMISSION REQUEST] legacy flattened text');
  });

  it('should pass compactMeta through for system entries', () => {
    const item = entryToDisplayItem(makeSystemEntry({
      subtype: ESystemSubtype.Compact,
      content: 'compaction summary',
      compactMeta: { summarizedTokenCount: 42 },
    }));
    expect(item).toMatchObject({
      role: 'system',
      subtype: 'compact',
      content: 'compaction summary',
      compactMeta: { summarizedTokenCount: 42 },
    });
  });

  it('should leave compactMeta undefined for entries without it', () => {
    // Legacy subtype=compact record without compactMeta
    const legacy = entryToDisplayItem(makeSystemEntry({
      subtype: ESystemSubtype.Compact,
      content: 'legacy worker success record',
    }));
    expect(legacy!.compactMeta).toBeUndefined();

    // New-style task_result record
    const taskResult = entryToDisplayItem(makeSystemEntry({
      subtype: ESystemSubtype.TaskResult,
      content: 'task finished successfully',
    }));
    expect(taskResult).toMatchObject({
      role: 'system',
      subtype: 'task_result',
      content: 'task finished successfully',
    });
    expect(taskResult!.compactMeta).toBeUndefined();
  });
});

// --- signalToDisplayItem ---

describe('entryToDisplayItem: whitespace-only sections', () => {
  const base = {
    type: EEntryType.Assistant,
    uuid: 'a-ws',
    parentUuid: null,
    sessionId: 'controller',
    timestamp: new Date().toISOString(),
  } as const;

  it('skips whitespace-only reasoning and content (no empty thinking row)', () => {
    const item = entryToDisplayItem({
      ...base,
      message: { role: 'assistant', content: '  \n', reasoning: ' \n ' },
      toolCalls: [{ toolCallId: 'tc-1', toolName: 'respond_permission', arguments: '{}' }],
    } as AssistantEntry);
    const kinds = item!.sections!.map(s => s.kind);
    expect(kinds).not.toContain('reasoning');
    expect(kinds).not.toContain('content');
    expect(kinds).toContain('tool_call');
  });

  it('keeps non-empty reasoning, trimmed', () => {
    const item = entryToDisplayItem({
      ...base,
      message: { role: 'assistant', content: '', reasoning: '\n Approve it.\n' },
    } as AssistantEntry);
    expect(item!.sections!.find(s => s.kind === 'reasoning')?.text).toBe('Approve it.');
  });
});

describe('signalToDisplayItem', () => {
  it('should convert input signal to user display item', () => {
    const signal: ControllerSignal = {
      id: 'sig-in',
      source: 'user',
      type: 'input',
      payload: { text: 'hello world' },
      timestamp: Date.now(),
      status: 'unread',
    };

    const item = signalToDisplayItem(signal);
    expect(item).toMatchObject({
      role: 'user',
      content: 'hello world',
      read: false,
    });
  });

  it('should convert completed signal with all metadata', () => {
    const signal: ControllerSignal = {
      id: 'sig-comp',
      source: 'worker',
      type: 'completed',
      payload: {
        taskId: 't-1',
        workerId: 'w-1',
        workerType: 'claude-code',
        emoji: '\u{1F9E0}',
        taskTitle: 'Write tests',
        summary: 'Tests written',
      },
      timestamp: Date.now(),
      status: 'unread',
    };

    const item = signalToDisplayItem(signal);
    expect(item).toMatchObject({
      role: 'signal',
      subtype: 'worker_completed',
      content: 'Tests written',
      taskId: 't-1',
      workerId: 'w-1',
      workerType: 'claude-code',
      emoji: '\u{1F9E0}',
      taskTitle: 'Write tests',
      read: false,
    });
  });

  it('should convert failed signal with error content', () => {
    const signal: ControllerSignal = {
      id: 'sig-fail',
      source: 'worker',
      type: 'failed',
      payload: {
        taskId: 't-2',
        workerId: 'w-2',
        workerType: 'puppet',
        emoji: '\u{1F9F8}',
        taskTitle: 'Build',
        error: 'Build failed',
      },
      timestamp: Date.now(),
      status: 'unread',
    };

    const item = signalToDisplayItem(signal);
    expect(item).toMatchObject({
      subtype: 'worker_failed',
      content: 'Build failed',
      workerType: 'puppet',
      emoji: '\u{1F9F8}',
    });
  });

  it('should convert progress signal with message content', () => {
    const signal: ControllerSignal = {
      id: 'sig-prog',
      source: 'worker',
      type: 'progress',
      payload: {
        workerId: 'w-3',
        taskId: 't-3',
        taskTitle: 'Deploy',
        workerType: 'puppet',
        emoji: '\u{1F9F8}',
        message: 'Deploying...',
      },
      timestamp: Date.now(),
      status: 'unread',
    };

    const item = signalToDisplayItem(signal);
    expect(item).toMatchObject({
      subtype: 'worker_progress',
      content: 'Deploying...',
      taskTitle: 'Deploy',
    });
  });

  it('should convert permission_request signal with meta and description content', () => {
    const signal: ControllerSignal = {
      id: 'sig-perm',
      source: 'worker',
      type: 'permission_request',
      payload: {
        requestId: 'perm-7-aaaa',
        workerId: 'w-9',
        taskId: 't-9',
        taskTitle: 'Deploy',
        workerType: 'puppet',
        emoji: '\u{1F9F8}',
        toolName: 'bash',
        toolArgs: { command: 'sudo reboot' },
        description: 'Execute shell command: sudo reboot',
      },
      timestamp: Date.now(),
      status: 'unread',
    };

    const item = signalToDisplayItem(signal);
    expect(item).toMatchObject({
      role: 'signal',
      subtype: 'permission_request',
      content: 'Execute shell command: sudo reboot',
      taskId: 't-9',
      taskTitle: 'Deploy',
      workerId: 'w-9',
      workerType: 'puppet',
      emoji: '\u{1F9F8}',
      read: false,
      permissionMeta: {
        requestId: 'perm-7-aaaa',
        toolName: 'bash',
        toolArgs: { command: 'sudo reboot' },
        description: 'Execute shell command: sudo reboot',
      },
    });
  });

  it('should handle signal with missing optional fields', () => {
    const signal: ControllerSignal = {
      id: 'sig-min',
      source: 'worker',
      type: 'progress',
      payload: {
        workerId: 'w-4',
        taskId: 't-4',
        taskTitle: 'Minimal',
        message: 'working',
      },
      timestamp: Date.now(),
      status: 'unread',
    };

    const item = signalToDisplayItem(signal);
    expect(item.workerType).toBeUndefined();
    expect(item.emoji).toBeUndefined();
    expect(item.content).toBe('working');
  });
});
