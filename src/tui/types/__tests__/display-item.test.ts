import { describe, it, expect } from 'vitest';
import { entryToDisplayItem, signalToDisplayItem } from '@/tui/types/display-item';
import { EEntryType, ESignalSubtype } from '@/types/conversation';
import type { ConversationEntry, UserEntry, AssistantEntry, SignalEntry } from '@/types/conversation';
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
});

// --- signalToDisplayItem ---

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
