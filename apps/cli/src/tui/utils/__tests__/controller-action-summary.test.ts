import { describe, it, expect } from 'vitest';
import {
  ADD_TASK_WORKSPACE_TAG_MAX_WIDTH,
  formatAddTaskWorkspaceTag,
  previewLines,
  summarizeAddTask,
  summarizeWorkerMessage,
} from '@/tui/utils/controller-action-summary';
import { stringWidth } from '@/tui/utils/text-width';

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
    expect(ok.delivery).toBe('delivered');
  });

  it('marks a queued message as queued even though its text also says "not delivered yet"', () => {
    // The real chat_worker queued result mentions both words — with the old
    // parallel checks the "delivered" one won and the row showed 已送达.
    const queued = summarizeWorkerMessage(args, 80, {
      text: 'Message queued for worker w-1793326810019-soqy — QUEUED only, not delivered yet: the worker reads it at its next step (puppet), turn boundary (third-party — the current turn, including any running tool call, finishes first) or next stage start (idle).',
    });
    expect(queued.outcome).toBe('ok');
    expect(queued.failure).toBe('');
    expect(queued.delivery).toBe('queued');
  });

  it('leaves delivery unset when an ok result says neither queued nor delivered', () => {
    const s = summarizeWorkerMessage(args, 80, { text: 'Message accepted.' });
    expect(s.outcome).toBe('ok');
    expect(s.delivery).toBeUndefined();
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

describe('summarizeAddTask workspace', () => {
  const dispatch = (workspace?: string): string => JSON.stringify({
    title: '写测试',
    description: '补充单测',
    ...(workspace !== undefined && { workspace }),
  });

  it('resolves the slug of a declared workspace from the known identities', () => {
    const s = summarizeAddTask(dispatch('/w/other'), 80, undefined, {
      defaultWorkspacePath: '/w/default',
      workspaces: [{ path: '/w/other', slug: 'other-2' }],
    });

    expect(s.workspaceSlug).toBe('other-2');
    expect(formatAddTaskWorkspaceTag(s.workspaceSlug)).toBe(' — other-2');
  });

  it('adds nothing when the call declared no workspace (default dispatch)', () => {
    const s = summarizeAddTask(dispatch(), 80, undefined, { defaultWorkspacePath: '/w/default' });

    expect(s.workspaceSlug).toBeUndefined();
    expect(formatAddTaskWorkspaceTag(s.workspaceSlug)).toBe('');
  });

  it('adds nothing when the declared workspace is the default one', () => {
    const s = summarizeAddTask(dispatch('/w/default/'), 80, undefined, { defaultWorkspacePath: '/w/default' });

    expect(s.workspaceSlug).toBeUndefined();
  });

  it('falls back to the directory name when no slug is known', () => {
    const s = summarizeAddTask(dispatch('/w/Unregistered Project'), 80, undefined, {
      defaultWorkspacePath: '/w/default',
      workspaces: [],
    });

    expect(s.workspaceSlug).toBe('unregistered-project');
  });

  it('keeps the header inside the column budget once the tag is appended', () => {
    const longSlug = dispatch('/w/a-very-long-unregistered-workspace-name-here');
    const s = summarizeAddTask(longSlug, 80, { text: 'Task t-1-abcd added.' }, {
      defaultWorkspacePath: '/w/default',
      workspaces: [],
    });
    const tag = formatAddTaskWorkspaceTag(s.workspaceSlug);

    expect(stringWidth(tag)).toBeLessThanOrEqual(ADD_TASK_WORKSPACE_TAG_MAX_WIDTH);
    // Header chrome (icon+label+#id+outcome = 27) + tag (tag + 1 separator) +
    // title, measured against the 80-column terminal the row is drawn in.
    expect(27 + stringWidth(tag) + 1 + stringWidth(s.title)).toBeLessThanOrEqual(80);
  });

  it('never lets a CJK slug tag exceed its width cap', () => {
    for (let width = 1; width <= ADD_TASK_WORKSPACE_TAG_MAX_WIDTH; width += 1) {
      expect(stringWidth(formatAddTaskWorkspaceTag('数据平台工作区', width))).toBeLessThanOrEqual(width);
    }
  });
});
