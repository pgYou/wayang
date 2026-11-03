import { describe, it, expect } from 'vitest';
import {
  formatContextUsage,
  contextUsageColor,
  formatElapsedSeconds,
  buildWorkerRows,
  buildStatusSegments,
  CONTEXT_SEGMENT_MAX_WIDTH,
  type WorkerRow,
} from '@/tui/components/status-bar';
import { theme } from '@/tui/theme';
import type { ActiveWorkerInfo, ContextUsage, TaskDetail } from '@/types/index';

const makeUsage = (usedTokens: number, contextWindowTokens = 100_000): ContextUsage => ({
  usedTokens,
  contextWindowTokens,
  ratio: contextWindowTokens > 0 ? usedTokens / contextWindowTokens : 0,
  source: 'usage',
});

describe('formatContextUsage', () => {
  it('should render used/limit token counts with a percent, no prefix label', () => {
    expect(formatContextUsage(12_300, 100_000)).toBe('12.3k/100k (12%)');
    expect(formatContextUsage(999, 100_000)).toBe('999/100k (1%)');
    expect(formatContextUsage(227_900, 1_000_000)).toBe('227.9k/1M (23%)');
  });

  it('should keep the token counts on a 0% reading', () => {
    expect(formatContextUsage(0, 100_000)).toBe('0/100k (0%)');
  });

  it('should round to integer without clamping to 100', () => {
    expect(formatContextUsage(100_000, 100_000)).toBe('100k/100k (100%)');
    expect(formatContextUsage(125_000, 100_000)).toBe('125k/100k (125%)');
    expect(formatContextUsage(1_234_567, 2_000_000)).toBe('1.2M/2M (62%)');
  });

  it('should render near the limit, rounding half up', () => {
    expect(formatContextUsage(99_900, 100_000)).toBe('99.9k/100k (100%)');
    expect(formatContextUsage(97_500, 100_000)).toBe('97.5k/100k (98%)');
  });

  it('should render values above 1M with the M unit, over 100 included', () => {
    expect(formatContextUsage(1_500_000, 1_000_000)).toBe('1.5M/1M (150%)');
    expect(formatContextUsage(2_400_000, 2_000_000)).toBe('2.4M/2M (120%)');
  });

  it('should render 0/0 (0%) when the window is zero', () => {
    expect(formatContextUsage(0, 0)).toBe('0/0 (0%)');
  });

  it('should cap the segment at CONTEXT_SEGMENT_MAX_WIDTH', () => {
    const samples: Array<[number, number]> = [
      [999, 100_000],
      [12_345, 100_000],
      [999_999, 999_999],
      [105_400, 100_000],
      [12_345_678, 999_999],
      [0, 0],
    ];
    for (const [used, max] of samples) {
      expect(formatContextUsage(used, max).length)
        .toBeLessThanOrEqual(CONTEXT_SEGMENT_MAX_WIDTH);
    }
  });
});

describe('formatElapsedSeconds', () => {
  it('should render seconds under a minute', () => {
    expect(formatElapsedSeconds(0)).toBe('0s');
    expect(formatElapsedSeconds(42)).toBe('42s');
    expect(formatElapsedSeconds(59)).toBe('59s');
  });

  it('should render minutes + seconds from one minute, neither padded', () => {
    expect(formatElapsedSeconds(60)).toBe('1m0s');
    expect(formatElapsedSeconds(61)).toBe('1m1s');
    expect(formatElapsedSeconds(101)).toBe('1m41s');
    expect(formatElapsedSeconds(3599)).toBe('59m59s');
  });

  it('should render hours with zero-padded minutes from one hour', () => {
    expect(formatElapsedSeconds(3600)).toBe('1h00m');
    expect(formatElapsedSeconds(3661)).toBe('1h01m');
    expect(formatElapsedSeconds(36_000)).toBe('10h00m');
    expect(formatElapsedSeconds(36_725)).toBe('10h12m');
  });

  it('should clamp negative input to 0s', () => {
    expect(formatElapsedSeconds(-3)).toBe('0s');
  });
});

describe('contextUsageColor', () => {
  it('should use error at ratio >= 0.9', () => {
    expect(contextUsageColor(0.9)).toBe(theme.baseToken.color.error);
    expect(contextUsageColor(1.25)).toBe(theme.baseToken.color.error);
  });

  it('should use warning at 0.7 <= ratio < 0.9', () => {
    expect(contextUsageColor(0.7)).toBe(theme.baseToken.color.warning);
    expect(contextUsageColor(0.89)).toBe(theme.baseToken.color.warning);
  });

  it('should stay default below 0.7', () => {
    expect(contextUsageColor(0.69)).toBeUndefined();
    expect(contextUsageColor(0)).toBeUndefined();
  });
});

const NOW = Date.parse('2026-11-03T12:00:00.000+08:00');

function activeWorker(overrides: Partial<ActiveWorkerInfo> = {}): ActiveWorkerInfo {
  return {
    workerId: 'w-1793670000001-aa01',
    taskId: 't-1793670000002-aa02',
    startedAt: NOW - 100_000,
    workerType: 'claude-code',
    taskTitle: 'Research the branch',
    emoji: '🤖',
    status: 'running',
    ...overrides,
  };
}

describe('buildWorkerRows', () => {
  it('running worker: label from the running task title, elapsed since start', () => {
    const w = activeWorker();
    const tasks: TaskDetail[] = [{
      id: w.taskId, title: 'Research the branch', description: 'long description',
      priority: 'normal', status: 'running', createdAt: NOW - 120_000, startedAt: NOW - 100_000,
    }];
    const rows = buildWorkerRows([w], tasks, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: 'Research the branch', idle: false, elapsed: 100 });
  });

  it('falls back to the task description when the title is empty', () => {
    const w = activeWorker();
    const tasks: TaskDetail[] = [{
      id: w.taskId, title: '', description: 'Investigate flaky CI',
      priority: 'normal', status: 'running', createdAt: NOW - 120_000,
    }];
    const rows = buildWorkerRows([w], tasks, NOW);
    expect(rows[0].label).toBe('Investigate flaky CI');
  });

  it('idle worker whose task already finished: label from the dispatch-stamped taskTitle, elapsed since parking', () => {
    // The multi-stage worker parked idle after its task completed and moved
    // to history — runningTasks no longer contains it. This is the exact
    // shape that used to render as a bare "t-179367".
    const w = activeWorker({
      status: 'idle',
      idleSinceMs: NOW - 30_000,
    });
    const rows = buildWorkerRows([w], [], NOW);
    expect(rows[0].label).toBe('Research the branch');
    expect(rows[0].idle).toBe(true);
    expect(rows[0].elapsed).toBe(30);
  });

  it('running worker with no running task entry: falls back to taskTitle, elapsed since start', () => {
    const w = activeWorker();
    const rows = buildWorkerRows([w], [], NOW);
    expect(rows[0].label).toBe('Research the branch');
    expect(rows[0].idle).toBe(false);
    expect(rows[0].elapsed).toBe(100);
  });

  it('title missing everywhere: worker type + unique id tail, never a truncated id', () => {
    const w = activeWorker({
      workerType: 'claude-code',
      taskId: 't-1793670123456-6h37',
      taskTitle: '',
    });
    const rows = buildWorkerRows([w], [], NOW);
    expect(rows[0].label).toBe('claude-code 6h37');
  });

  it('colliding titles are disambiguated with the task id tails', () => {
    const w1 = activeWorker({ taskId: 't-1793670000001-tail1' });
    const w2 = activeWorker({ workerId: 'w-1793670000003-bb03', taskId: 't-1793670000004-tail2' });
    const rows = buildWorkerRows([w1, w2], [], NOW);
    const labels = rows.map((r) => r.label);
    expect(labels).toEqual(['Research the branch tail1', 'Research the branch tail2']);
    expect(new Set(labels).size).toBe(2);
  });

  it('same-label rows whose tails cannot disambiguate escalate to the full (unique) task id', () => {
    // Both workers carry the same taskTitle AND the same id tail — appending
    // the tail cannot tell them apart, so one row escalates to its full id.
    const w1 = activeWorker({ taskId: 't-1793670000001-6h37', taskTitle: 'Research 6h37' });
    const w2 = activeWorker({
      workerId: 'w-1793670000003-bb03',
      taskId: 't-1793670000004-6h37',
      taskTitle: 'Research 6h37',
    });
    const rows = buildWorkerRows([w1, w2], [], NOW);
    const labels = rows.map((r) => r.label);
    expect(new Set(labels).size).toBe(2);
    expect(labels).toContain('t-1793670000001-6h37');
  });
});

function row(overrides: Partial<WorkerRow> = {}): WorkerRow {
  return {
    workerId: 'w-1', taskId: 't-1', label: 'build project', elapsed: 7, idle: false,
    ...overrides,
  };
}

describe('buildStatusSegments', () => {
  it('should render idle plus the context segment when there are no tasks', () => {
    const seg = buildStatusSegments({
      pendingCount: 0,
      activeCount: 0,
      workerRows: [],
      contextUsage: makeUsage(12_300),
    });
    expect(seg.countsText).toBe('idle');
    expect(seg.contextText).toBe('12.3k/100k (12%)');
    expect(seg.workerTexts).toEqual([]);
  });

  it('should always produce a counts segment even without context data', () => {
    const seg = buildStatusSegments({
      pendingCount: 0,
      activeCount: 0,
      workerRows: [],
      contextUsage: null,
    });
    expect(seg.countsText).toBe('idle');
    expect(seg.contextText).toBe('');
  });

  it('should keep the pending/active labels when tasks exist', () => {
    const seg = buildStatusSegments({
      pendingCount: 2,
      activeCount: 1,
      workerRows: [],
      contextUsage: null,
    });
    expect(seg.countsText).toBe('pending tasks:2 │ active workers:1');
    expect(seg.contextText).toBe('');
  });

  it('should keep the context segment complete and truncate workers on narrow terminals', () => {
    const seg = buildStatusSegments({
      pendingCount: 1,
      activeCount: 2,
      workerRows: [
        row({ label: 'a'.repeat(20), elapsed: 123 }),
        row({ label: 'b'.repeat(20), elapsed: 45 }),
      ],
      contextUsage: makeUsage(95_000),
      terminalCols: 60,
    });
    expect(seg.contextText).toBe('95k/100k (95%)');
    expect(seg.contextColor).toBe(theme.baseToken.color.error);
    // Whole line fits: padding(2) + ' counts ' + workers + ' │ context'
    const total = 4 + seg.countsText.length
      + seg.workerTexts.join(' · ').length
      + (seg.contextText.length + 3);
    expect(total).toBeLessThanOrEqual(60);
    // The overflowing worker row is hard-truncated, the rest dropped
    expect(seg.workerTexts).toHaveLength(1);
  });

  it('should keep whole worker rows when the terminal is wide enough', () => {
    const seg = buildStatusSegments({
      pendingCount: 0,
      activeCount: 1,
      workerRows: [row()],
      contextUsage: makeUsage(12_300),
      terminalCols: 120,
    });
    expect(seg.workerTexts).toEqual(['build project (7s)']);
    expect(seg.contextText).toBe('12.3k/100k (12%)');
  });

  it('should mark idle rows so a parked worker cannot be misread as running', () => {
    const seg = buildStatusSegments({
      pendingCount: 0,
      activeCount: 1,
      workerRows: [row({ idle: true, elapsed: 303 })],
      contextUsage: null,
      terminalCols: 120,
    });
    expect(seg.workerTexts).toEqual(['build project (idle 5m3s)']);
  });

  it('should format elapsed with the compact minute/hour format in rows', () => {
    const seg = buildStatusSegments({
      pendingCount: 0,
      activeCount: 2,
      workerRows: [row({ elapsed: 101 }), row({ workerId: 'w-2', taskId: 't-2', label: 'x', elapsed: 3661 })],
      contextUsage: null,
      terminalCols: 120,
    });
    expect(seg.workerTexts).toEqual(['build project (1m41s)', 'x (1h01m)']);
  });
});

describe('workspace attribution in worker rows', () => {
  /** A running task for the worker, with or without workspace identity. */
  function runningTask(workspace?: { path: string; slug: string }): TaskDetail[] {
    return [{
      id: 't-1793670000002-aa02',
      title: 'Research the branch',
      description: 'long description',
      priority: 'normal',
      status: 'running',
      createdAt: NOW - 120_000,
      startedAt: NOW - 100_000,
      ...(workspace ? { workspace } : {}),
    }];
  }

  it('shows the task workspace slug in the row when the task carries one', () => {
    const rows = buildWorkerRows(
      [activeWorker()],
      runningTask({ path: '/repo/wayang', slug: 'wayang' }),
      NOW,
    );
    expect(rows[0].workspaceSlug).toBe('wayang');

    const seg = buildStatusSegments({
      pendingCount: 0,
      activeCount: 1,
      workerRows: rows,
      contextUsage: null,
      terminalCols: 120,
    });
    expect(seg.workerTexts).toEqual(['Research the branch [wayang] (1m40s)']);
  });

  it('adds nothing (and never "undefined") when the task has no workspace identity', () => {
    const rows = buildWorkerRows([activeWorker()], runningTask(), NOW);
    expect(rows[0].workspaceSlug).toBeUndefined();

    const seg = buildStatusSegments({
      pendingCount: 0,
      activeCount: 1,
      workerRows: rows,
      contextUsage: null,
      terminalCols: 120,
    });
    expect(seg.workerTexts).toEqual(['Research the branch (1m40s)']);
    expect(seg.workerTexts.join(' ')).not.toContain('undefined');
    expect(seg.workerTexts.join(' ')).not.toContain('[');
  });

  it('omits the slug first when space is tight, keeping the title and elapsed', () => {
    const rows = buildWorkerRows(
      [activeWorker()],
      runningTask({ path: '/repo/wayang', slug: 'wayang' }),
      NOW,
    );

    // Budget fits the compact row (27 chars) but not the full one (36 chars).
    const seg = buildStatusSegments({
      pendingCount: 0,
      activeCount: 1,
      workerRows: rows,
      contextUsage: null,
      terminalCols: 50,
    });
    expect(seg.workerTexts).toEqual(['Research the branch (1m40s)']);
    expect(seg.workerTexts.join(' ')).not.toContain('[wayang]');
  });
});
