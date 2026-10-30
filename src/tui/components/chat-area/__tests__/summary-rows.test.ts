import { describe, it, expect } from 'vitest';
import type { DisplayItem, DisplaySection } from '@/tui/types/display-item';
import { buildChatLookups, EMPTY_CHAT_LOOKUPS } from '@/tui/utils/chat-lookups';
import { AssistantStepRow } from '@/tui/components/chat-area/assistant-step-row';
import { SignalRow } from '@/tui/components/chat-area/signal-row';
import { renderToString, h } from './render-to-string';

// --- self-contained fixtures (fresh objects per call) ---

function step(sections: DisplaySection[], content = ''): DisplayItem {
  return { id: `a-${Math.random().toString(36).slice(2)}`, timestamp: 0, read: true, role: 'assistant', content, sections };
}

function call(id: string, toolName: string, args: unknown): DisplaySection {
  return { kind: 'tool_call', id, toolName, text: JSON.stringify(args) };
}

function result(id: string, toolName: string, text: string, isError = false): DisplaySection {
  return { kind: 'tool_result', id, toolName, text, isError };
}

function permissionSignal(): DisplayItem {
  return {
    id: 'sig-perm',
    timestamp: 0,
    read: true,
    role: 'signal',
    content: 'Execute shell command: git status',
    subtype: 'permission_request',
    workerId: 'w-1-t0sr',
    workerType: 'puppet',
    emoji: '🧸',
    taskTitle: 'context command',
    permissionMeta: {
      requestId: 'perm-1-7xvt',
      toolName: 'bash',
      toolArgs: { command: 'git status' },
      description: 'Execute shell command: git status',
    },
  };
}

describe('AssistantStepRow summary rows', () => {
  it('renders a permission resolution with the original request and folds the result', () => {
    const lookups = buildChatLookups([permissionSignal()]);
    const out = renderToString(h(AssistantStepRow, {
      item: step([
        call('c1', 'respond_permission', { requestId: 'perm-1-7xvt', approved: true }),
        result('c1', 'respond_permission', 'Permission granted for request perm-1-7xvt.'),
      ]),
      lookups,
    }));

    expect(out).toContain('✔ 已批准 bash git status #7xvt');
    expect(out).toContain('🧸 context command · w:t0sr');
    expect(out).not.toContain('Permission granted'); // paired result folded in
  });

  it('renders an undeterminable resolution as unknown, not denied', () => {
    const out = renderToString(h(AssistantStepRow, {
      item: step([{ kind: 'tool_call', id: 'c2', toolName: 'respond_permission', text: '{bad json' }]),
      lookups: EMPTY_CHAT_LOOKUPS,
    }));
    expect(out).toContain('? 结果未知');
    expect(out).not.toContain('已拒绝');
  });

  it('renders a delivered worker message with a preview', () => {
    const lookups = buildChatLookups([permissionSignal()]);
    const out = renderToString(h(AssistantStepRow, {
      item: step([
        call('c3', 'chat_worker', { workerId: 'w-1-t0sr', message: 'first line\nsecond line' }),
        result('c3', 'chat_worker', 'Message delivered to worker w-1-t0sr.'),
      ]),
      lookups,
    }));

    expect(out).toContain('✉ 发送给 🧸 context command · w:t0sr');
    expect(out).toContain('✔ 已送达');
    expect(out).toContain('first line');
    expect(out).not.toContain('Message delivered');
  });

  it('renders a successful add_task with the task handle and a success mark', () => {
    const out = renderToString(h(AssistantStepRow, {
      item: step([
        call('c4', 'add_task', { title: 'Build it', description: 'do the thing', workerType: 'claude-code', multiStage: true }),
        result('c4', 'add_task', 'Task t-1-rr4f added (priority: normal, worker: claude-code). You will be notified when the task completes.'),
      ]),
      lookups: EMPTY_CHAT_LOOKUPS,
    }));

    expect(out).toContain('⊕ 派发任务 Build it #rr4f');
    expect(out).not.toContain('▶');
    expect(out).toContain('✔ 已派发');
    expect(out).toContain('claude-code · 多阶段');
    expect(out).not.toContain('You will be notified');
  });

  it('keeps generic result rows for tools without a summary row', () => {
    const out = renderToString(h(AssistantStepRow, {
      item: step([call('c5', 'list_tasks', {}), result('c5', 'list_tasks', 'no tasks')]),
      lookups: EMPTY_CHAT_LOOKUPS,
    }));
    expect(out).toContain('list_tasks: no tasks');
  });

  it('gives each summary header exactly one lead-in icon', () => {
    const lookups = buildChatLookups([permissionSignal()]);
    const out = renderToString(h(AssistantStepRow, {
      item: step([
        call('d1', 'respond_permission', { requestId: 'perm-1-7xvt', approved: true }),
        call('d2', 'chat_worker', { workerId: 'w-1-t0sr', message: 'hi' }),
        call('d3', 'add_task', { title: 'Reuse', description: 'd', assignToWorker: 'w-1-t0sr' }),
        call('d4', 'add_task', { title: 'Fresh', description: 'd' }),
      ]),
      lookups,
    }));
    const lines = out.split('\n').map(l => l.trimStart());
    expect(lines.some(l => l.startsWith('✔ 已批准'))).toBe(true);
    expect(lines.some(l => l.startsWith('✉ 发送给'))).toBe(true);
    expect(lines.some(l => l.startsWith('↻ 续派任务'))).toBe(true);
    expect(lines.some(l => l.startsWith('⊕ 派发任务'))).toBe(true);
    expect(out).not.toMatch(/· [✔✘?✉↻⊕]/);
  });

  it('renders nothing for a whitespace-only step without sections', () => {
    const out = renderToString(h(AssistantStepRow, { item: step([], '  \n '), lookups: EMPTY_CHAT_LOOKUPS }));
    expect(out.trim()).toBe('');
  });
});

describe('SignalRow permission request', () => {
  it('renders the structured request row without restating the command', () => {
    const out = renderToString(h(SignalRow, { item: permissionSignal() }));
    expect(out).toContain('• 权限申请 bash git status');
    expect(out).toContain('🧸 context command · w:t0sr  #7xvt');
    expect(out).not.toContain('Execute shell command');
  });

  it('falls back to the default row for legacy entries without meta', () => {
    const legacy = { ...permissionSignal(), permissionMeta: undefined, content: '[PERMISSION REQUEST] legacy text' };
    const out = renderToString(h(SignalRow, { item: legacy }));
    expect(out).toContain('legacy text');
    expect(out).not.toContain('权限申请');
  });
});
