import { describe, it, expect } from 'vitest';
import {
  previewLines,
  summarizeAddTask,
  summarizeWorkerMessage,
} from '@/tui/utils/controller-action-summary';

// --- previewLines ---

describe('previewLines', () => {
  it('keeps the first non-empty lines and counts the rest', () => {
    const p = previewLines('a\n\nb\nc\n  \nd', 2, 80);
    expect(p.lines).toEqual(['a', 'b']);
    expect(p.hidden).toBe(2);
  });

  it('truncates each line to the width', () => {
    const p = previewLines('x'.repeat(50), 3, 10);
    expect(p.lines[0]).toHaveLength(10);
    expect(p.lines[0].endsWith('…')).toBe(true);
  });
});

// --- summarizeWorkerMessage ---

describe('summarizeWorkerMessage', () => {
  const args = JSON.stringify({
    workerId: 'w-1793326810019-soqy',
    message: '补充已核实的事实：\n\n1) 第一点\n2) 第二点\n3) 第三点',
  });

  it('extracts the worker id and previews the message', () => {
    const s = summarizeWorkerMessage(args, 80);
    expect(s.workerId).toBe('w-1793326810019-soqy');
    expect(s.lines).toEqual(['补充已核实的事实：', '1) 第一点', '2) 第二点']);
    expect(s.hiddenLines).toBe(1);
    expect(s.outcome).toBe('pending');
  });

  it('marks delivery from the paired result', () => {
    const ok = summarizeWorkerMessage(args, 80, { text: 'Message delivered to worker w-1793326810019-soqy.' });
    expect(ok.outcome).toBe('ok');
    expect(ok.failure).toBe('');
  });

  it('marks undeliverable messages as failed and strips the [ERROR] marker', () => {
    const s = summarizeWorkerMessage(args, 80, { text: '[ERROR] Worker w-1 not found or not running.' });
    expect(s.outcome).toBe('failed');
    expect(s.failure).toBe('Worker w-1 not found or not running.');
  });

  it('falls back to the raw arguments when they are not JSON', () => {
    const s = summarizeWorkerMessage('not json', 80);
    expect(s.workerId).toBeUndefined();
    expect(s.lines).toEqual(['not json']);
  });
});

// --- summarizeAddTask ---

describe('summarizeAddTask', () => {
  const args = JSON.stringify({
    title: '设计 compact 摘要持久化恢复方案',
    description: '仓库：/data/home/lukegypeng/code/wayang。\n只读分析 + 出方案。\n不要改代码。',
    priority: 'high',
    workerType: 'claude-code',
    multiStage: true,
  });

  it('extracts title, worker type, flags and a description preview', () => {
    const s = summarizeAddTask(args, 80);
    expect(s.title).toBe('设计 compact 摘要持久化恢复方案');
    expect(s.workerType).toBe('claude-code');
    expect(s.priority).toBe('high');
    expect(s.multiStage).toBe(true);
    expect(s.lines).toHaveLength(2);
    expect(s.hiddenLines).toBe(1);
    expect(s.outcome).toBe('pending');
  });

  it('defaults the worker type to puppet like the tool does', () => {
    expect(summarizeAddTask(JSON.stringify({ title: 't', description: 'd' }), 80).workerType).toBe('puppet');
  });

  it('parses the created task id from an "added" result', () => {
    const s = summarizeAddTask(args, 80, {
      text: 'Task t-1793326810016-rr4f added (priority: high, worker: claude-code). You will be notified when the task completes.',
    });
    expect(s.outcome).toBe('ok');
    expect(s.taskShortId).toBe('rr4f');
  });

  it('recognizes reuse of an idle worker', () => {
    const reuse = JSON.stringify({ title: 't', description: 'd', assignToWorker: 'w-9-abcd' });
    const s = summarizeAddTask(reuse, 80, { text: 'Task t-9-wxyz assigned to worker w-9-abcd (reusing its context).' });
    expect(s.assignToWorker).toBe('w-9-abcd');
    expect(s.outcome).toBe('ok');
    expect(s.taskShortId).toBe('wxyz');
  });

  it('treats any other result as a failed dispatch', () => {
    const s = summarizeAddTask(args, 80, { text: 'Unknown worker type "foo".' });
    expect(s.outcome).toBe('failed');
    expect(s.failure).toBe('Unknown worker type "foo".');
    expect(s.taskShortId).toBeUndefined();
  });
});
