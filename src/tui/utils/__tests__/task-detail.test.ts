import { describe, it, expect } from 'vitest';
import {
  TASK_DETAIL_MAX_FIELD_LINES,
  formatTaskDetail,
  resolveTaskRef,
  wrapToWidth,
} from '@/tui/utils/task-detail';
import { stringWidth } from '@/tui/utils/text-width';
import type { TaskDetail } from '@/types/index';

const makeTask = (overrides: Partial<TaskDetail> = {}): TaskDetail => ({
  id: 'task-1731000001-abcd',
  title: 'Fix build',
  description: 'Run the full build pipeline.',
  priority: 'normal',
  status: 'completed',
  createdAt: 1_000,
  ...overrides,
});

describe('wrapToWidth', () => {
  it('keeps lines that already fit verbatim', () => {
    expect(wrapToWidth('short line', 20)).toEqual(['short line']);
  });

  it('wraps on word boundaries when the line exceeds the width', () => {
    const text = 'abcdefghij klmnopqrst uvwxyz';

    expect(wrapToWidth(text, 16)).toEqual(['abcdefghij', 'klmnopqrst', 'uvwxyz']);
  });

  it('hard-breaks an unbreakable word by display columns', () => {
    expect(wrapToWidth('aaaaabbbbbcccccddddd', 10)).toEqual([
      'aaaaabbbbb',
      'cccccddddd',
    ]);
  });

  it('counts CJK as two columns when wrapping', () => {
    // 6 CJK chars = 12 columns; width 5 fits 2 chars (4 columns) per line.
    expect(wrapToWidth('任务描述执行', 5)).toEqual(['任务', '描述', '执行']);
  });

  it('preserves explicit line breaks and blank lines', () => {
    expect(wrapToWidth('one\n\ntwo', 10)).toEqual(['one', '', 'two']);
  });

  it('normalizes CRLF before wrapping', () => {
    expect(wrapToWidth('one\r\ntwo', 10)).toEqual(['one', 'two']);
  });

  it('returns no lines for a non-positive width', () => {
    expect(wrapToWidth('anything', 0)).toEqual([]);
  });
});

describe('formatTaskDetail', () => {
  it('renders header, worker, timing, session ids and workspace', () => {
    const task = makeTask({
      status: 'failed',
      startedAt: 2_000,
      completedAt: 9_000,
      priority: 'high',
      workerType: 'puppet',
      workerSessionId: 'w-1731000001-ef01',
      workerTranscriptId: 'agent-1731000001-ef01',
      workspace: { path: '/w/demo', slug: 'demo' },
      error: 'boom',
    });

    const output = formatTaskDetail(task, { width: 80 });

    expect(output).toContain('Task #abcd (task-1731000001-abcd) · failed');
    expect(output).toContain('worker: 🧸 puppet');
    expect(output).toContain('优先级: high');
    expect(output).toContain('创建 1970-01-01T00:00:01.000Z');
    expect(output).toContain('开始 1970-01-01T00:00:02.000Z');
    expect(output).toContain('结束 1970-01-01T00:00:09.000Z · 耗时 7.0s');
    expect(output).toContain('worker 会话: w-1731000001-ef01');
    expect(output).toContain('transcript: agent-1731000001-ef01');
    expect(output).toContain('workspace: demo (/w/demo)');
  });

  it('shows the running elapsed time from the injected now', () => {
    const task = makeTask({ status: 'running', startedAt: 5_000 });

    const output = formatTaskDetail(task, { width: 80, now: 10_000 });

    expect(output).toContain('已运行 5.0s');
    expect(output).not.toContain('结束');
  });

  it('falls back to the description as the header label without a title', () => {
    const task = makeTask({ title: '  ', description: 'First line of the instruction' });

    expect(formatTaskDetail(task, { width: 80 })).toContain('— First line of the instruction');
  });

  it('shows the full multi-line error verbatim, wrapped to the width', () => {
    const task = makeTask({
      status: 'failed',
      startedAt: 1,
      completedAt: 2,
      error: 'AssertionError: expected 1 to equal 2\n  at spec.ts:42\n  at runner.ts:7',
    });

    const lines = formatTaskDetail(task, { width: 30 }).split('\n');
    const errorIndex = lines.indexOf('错误:');

    expect(errorIndex).toBeGreaterThanOrEqual(0);
    // The error's own line breaks survive; each rendered line fits the width.
    expect(lines[errorIndex + 1]).toBe('  AssertionError: expected 1');
    expect(lines).toContain('  to equal 2');
    expect(lines).toContain('    at spec.ts:42');
    expect(lines).toContain('    at runner.ts:7');
    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(30);
    }
  });

  it('caps a huge field at the line budget and says how much was cut', () => {
    const description = Array.from({ length: 200 }, (_, i) => `line ${i} of the instruction`).join('\n');
    const task = makeTask({ description });

    const lines = formatTaskDetail(task, { width: 80 }).split('\n');
    const descriptionIndex = lines.indexOf('描述:');

    expect(descriptionIndex).toBeGreaterThanOrEqual(0);
    // header(1) + worker(1) + timing(1) + 30 capped lines + note.
    expect(lines).toHaveLength(descriptionIndex + 1 + TASK_DETAIL_MAX_FIELD_LINES + 1);
    expect(lines[lines.length - 1]).toBe('  … 已截断（共 200 行）');
    expect(lines).not.toContain('  line 199 of the instruction');
  });

  it('keeps every line within the width for CJK content', () => {
    const task = makeTask({
      description: '构建并验证整个发布流程，输出每一步的产物路径与校验结果。'.repeat(20),
    });

    const lines = formatTaskDetail(task, { width: 36 }).split('\n');

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(36);
    }
  });

  it('omits the session line entirely when no worker ids are recorded', () => {
    const output = formatTaskDetail(makeTask(), { width: 80 });

    expect(output).not.toContain('worker 会话');
    expect(output).not.toContain('transcript');
  });

  it('renders the result section only when a result exists', () => {
    expect(formatTaskDetail(makeTask(), { width: 80 })).not.toContain('结果:');
    expect(formatTaskDetail(makeTask({ result: 'all green' }), { width: 80 })).toContain('结果:');
    expect(formatTaskDetail(makeTask({ result: 'all green' }), { width: 80 })).toContain('  all green');
  });

  it('marks a multi-stage task', () => {
    expect(formatTaskDetail(makeTask({ multiStage: true }), { width: 80 })).toContain('multi-stage');
  });
});

describe('resolveTaskRef', () => {
  const tasks: TaskDetail[] = [
    makeTask({ id: 'task-1731000001-aaaa' }),
    makeTask({ id: 'task-1731000002-bbbb' }),
    makeTask({ id: 'task-1731000003-aabb' }),
  ];

  it('resolves an exact id', () => {
    expect(resolveTaskRef(tasks, 'task-1731000002-bbbb'))
      .toEqual({ task: tasks[1] });
  });

  it('resolves the #tail handle with or without the hash', () => {
    expect(resolveTaskRef(tasks, '#aaaa')).toEqual({ task: tasks[0] });
    expect(resolveTaskRef(tasks, 'bbbb')).toEqual({ task: tasks[1] });
  });

  it('resolves a unique prefix', () => {
    expect(resolveTaskRef(tasks, 'task-1731000003')).toEqual({ task: tasks[2] });
  });

  it('errors with the candidates when the reference is ambiguous', () => {
    // 'bb' suffix-matches both bbbb and aabb.
    const resolved = resolveTaskRef(tasks, 'bb');

    expect('task' in resolved).toBe(false);
    if (!('task' in resolved)) {
      expect(resolved.error).toContain('matches 2 tasks');
      expect(resolved.error).toContain('task-1731000002-bbbb');
      expect(resolved.error).toContain('task-1731000003-aabb');
    }
  });

  it('errors when nothing matches', () => {
    const resolved = resolveTaskRef(tasks, 'zzzz');

    expect('task' in resolved).toBe(false);
    if (!('task' in resolved)) {
      expect(resolved.error).toBe('No task matches "zzzz" — run /tasks to list ids');
    }
  });

  it('errors on an empty reference', () => {
    const resolved = resolveTaskRef(tasks, '  ');

    expect('task' in resolved).toBe(false);
  });

  it('caps the candidate list at five ids', () => {
    const many = Array.from({ length: 7 }, (_, i) => makeTask({ id: `task-173100000${i}-dup` }));
    const resolved = resolveTaskRef(many, 'dup');

    expect('task' in resolved).toBe(false);
    if (!('task' in resolved)) {
      expect(resolved.error).toContain('matches 7 tasks');
      expect(resolved.error).toContain('(+2)');
    }
  });
});
