import { describe, it, expect } from 'vitest';
import {
  WORKER_LIST_STAGE_MAX_WIDTH,
  WORKER_LIST_TITLE_MAX_WIDTH,
  formatWorkerList,
  formatWorkerRow,
} from '@/tui/utils/worker-list';
import { stringWidth } from '@/tui/utils/text-width';
import type { ActiveWorkerInfo } from '@/types/index';

const makeWorker = (overrides: Partial<ActiveWorkerInfo> = {}): ActiveWorkerInfo => ({
  workerId: 'w-1731000001-ab12',
  taskId: 'task-1731000001-cd34',
  startedAt: 1_000,
  workerType: 'puppet',
  taskTitle: 'scan repo',
  emoji: '🧸',
  status: 'running',
  ...overrides,
});

describe('formatWorkerRow', () => {
  it('shows handle, status, worker type, parent task and elapsed time', () => {
    const row = formatWorkerRow(makeWorker(), { now: 31_000 });

    expect(row).toBe('#ab12 [running] 🧸 puppet · task #cd34 scan repo · 已运行 30.0s');
  });

  it('shows the idle duration and last stage for a parked multi-stage worker', () => {
    const worker = makeWorker({
      status: 'idle',
      idleSinceMs: 20_000,
      lastStageSummary: '第一阶段完成，产物已落盘',
    });

    const row = formatWorkerRow(worker, { now: 32_000 });

    expect(row).toContain('#ab12 [idle] 🧸 puppet');
    expect(row).toContain('task #cd34');
    expect(row).toContain('空闲 12.0s');
    expect(row).toContain('上阶段: 第一阶段完成，产物已落盘');
    expect(row).not.toContain('已运行');
  });

  it('falls back to the start time when an idle worker lacks idleSinceMs', () => {
    const worker = makeWorker({ status: 'idle' });

    const row = formatWorkerRow(worker, { now: 6_000 });

    expect(row).toContain('空闲 5.0s');
  });

  it('drops the stage fragment when the summary is blank', () => {
    const worker = makeWorker({ status: 'idle', idleSinceMs: 2_000, lastStageSummary: ' \n\t ' });

    expect(formatWorkerRow(worker, { now: 4_000 })).not.toContain('上阶段');
  });

  it('truncates a long task title to the title budget', () => {
    const worker = makeWorker({ taskTitle: 'T'.repeat(100) });

    const row = formatWorkerRow(worker, { now: 1_500 });
    const title = row.split('task #cd34 ')[1]?.split(' · ')[0];

    expect(title!.endsWith('…')).toBe(true);
    expect(stringWidth(title!)).toBeLessThanOrEqual(WORKER_LIST_TITLE_MAX_WIDTH);
  });

  it('truncates a long stage summary to the stage budget', () => {
    const worker = makeWorker({
      status: 'idle',
      idleSinceMs: 2_000,
      lastStageSummary: 'S'.repeat(100),
    });

    const row = formatWorkerRow(worker, { now: 3_000 });
    const digest = row.split('上阶段: ')[1];

    expect(digest!.endsWith('…')).toBe(true);
    expect(stringWidth(digest!)).toBeLessThanOrEqual(WORKER_LIST_STAGE_MAX_WIDTH);
  });

  it('caps the whole row to rowMaxWidth so one worker is one line', () => {
    const worker = makeWorker({
      taskTitle: 'run the entire release pipeline and verify every artifact',
      workerType: 'claude-code',
      emoji: '🤖',
    });

    const row = formatWorkerRow(worker, { now: 61_000, rowMaxWidth: 60 });

    expect(row).not.toContain('\n');
    expect(stringWidth(row)).toBeLessThanOrEqual(60);
    expect(row.endsWith('…')).toBe(true);
  });

  it('keeps CJK titles within the row budget, counting double columns', () => {
    const worker = makeWorker({ taskTitle: '扫描仓库并输出结果'.repeat(10) });

    const row = formatWorkerRow(worker, { now: 2_000, rowMaxWidth: 76 });

    expect(stringWidth(row)).toBeLessThanOrEqual(76);
  });
});

describe('formatWorkerList', () => {
  it('renders one row per active worker', () => {
    const output = formatWorkerList(
      [makeWorker(), makeWorker({ workerId: 'w-1731000002-ef56', taskId: 'task-1731000002-gh78', taskTitle: 'build' })],
      { now: 2_000 },
    );

    const lines = output.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('#ab12');
    expect(lines[1]).toContain('#ef56');
    expect(lines[1]).toContain('build');
  });

  it('renders "No active workers" for an empty list', () => {
    expect(formatWorkerList([])).toBe('No active workers');
  });
});
