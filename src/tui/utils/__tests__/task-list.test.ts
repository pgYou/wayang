import { describe, it, expect } from 'vitest';
import {
  TASK_LIST_DESCRIPTION_MAX_WIDTH,
  TASK_LIST_MAX_ITEMS,
  TASK_LIST_RESULT_MAX_WIDTH,
  formatTaskList,
  formatTaskRow,
  isActiveTask,
  limitForList,
  truncateForList,
} from '@/tui/utils/task-list';
import { stringWidth } from '@/tui/utils/text-width';
import type { TaskDetail } from '@/types/index';

const makeTask = (overrides: Partial<TaskDetail> = {}): TaskDetail => ({
  id: 't-1',
  title: 'title',
  description: 'do the thing',
  priority: 'normal',
  status: 'completed',
  createdAt: 1,
  ...overrides,
});

/** A description long enough to blow past the cap in plain ASCII. */
const longDescription = (width: number): string => 'x'.repeat(width + 40);

/**
 * Build tasks in the order the engine returns them: `pending` first, then
 * `running`, then `history` — history is append-ordered, so its tail is newest.
 */
const makeEngineList = (
  active: Array<{ id: string; status: 'pending' | 'running' }>,
  historyIds: string[],
): TaskDetail[] => [
  ...active.map(({ id, status }) => makeTask({ id, status, description: `desc ${id}` })),
  ...historyIds.map(id => makeTask({ id, description: `desc ${id}` })),
];

const historyIds = (count: number): string[] => Array.from({ length: count }, (_, i) => `h-${i}`);

describe('truncateForList', () => {
  it('keeps a short description verbatim, without an ellipsis', () => {
    const text = 'short task';

    expect(truncateForList(text)).toBe(text);
    expect(truncateForList(text)).not.toContain('…');
  });

  it('keeps a description exactly at the cap verbatim', () => {
    const text = 'a'.repeat(TASK_LIST_DESCRIPTION_MAX_WIDTH);

    expect(truncateForList(text)).toBe(text);
    expect(stringWidth(truncateForList(text))).toBe(TASK_LIST_DESCRIPTION_MAX_WIDTH);
  });

  it('truncates a long description to the cap and ends with an ellipsis', () => {
    const result = truncateForList(longDescription(TASK_LIST_DESCRIPTION_MAX_WIDTH));

    expect(result.endsWith('…')).toBe(true);
    expect(stringWidth(result)).toBeLessThanOrEqual(TASK_LIST_DESCRIPTION_MAX_WIDTH);
  });

  it('counts CJK as two columns and never exceeds the cap', () => {
    // 60 CJK chars = 120 columns; truncation must cut by columns, not chars.
    const text = '任务描述'.repeat(15);

    const result = truncateForList(text);

    expect(result.endsWith('…')).toBe(true);
    expect(stringWidth(result)).toBeLessThanOrEqual(TASK_LIST_DESCRIPTION_MAX_WIDTH);
    // 80 columns - 1 for the ellipsis => 79 columns of CJK => 39 chars + ellipsis.
    expect([...result]).toHaveLength(40);
  });

  it('counts emoji as two columns and respects the cap', () => {
    // 40 emoji = 80 columns (exactly at the cap) — kept as is.
    const atCap = '🙂'.repeat(40);
    expect(stringWidth(atCap)).toBe(TASK_LIST_DESCRIPTION_MAX_WIDTH);
    expect(truncateForList(atCap)).toBe(atCap);

    // One more emoji pushes it over: cut to 39 emoji + ellipsis = 79 columns.
    const overCap = '🙂'.repeat(41);
    const result = truncateForList(overCap);

    expect(result.endsWith('…')).toBe(true);
    expect(stringWidth(result)).toBeLessThanOrEqual(TASK_LIST_DESCRIPTION_MAX_WIDTH);
    expect([...result]).toHaveLength(40);
  });

  it('flattens multi-line descriptions to a single line', () => {
    const text = 'line one\n\nline two\r\n  line three  ';

    const result = truncateForList(text);

    expect(result).toBe('line one line two line three');
    expect(result).not.toContain('\n');
  });

  it('flattens newlines before truncating', () => {
    // Each line is 30 columns; 6 lines = 180 columns + whitespace.
    const text = Array.from({ length: 6 }, () => 'y'.repeat(30)).join('\n');

    const result = truncateForList(text);

    expect(result).not.toContain('\n');
    expect(result.endsWith('…')).toBe(true);
    expect(stringWidth(result)).toBeLessThanOrEqual(TASK_LIST_DESCRIPTION_MAX_WIDTH);
  });

  it('honours an explicit width limit', () => {
    const result = truncateForList('abcdefghij', 5);

    expect(result).toBe('abcd…');
    expect(stringWidth(result)).toBe(5);
  });
});

describe('limitForList', () => {
  it('keeps every entry and emits no note when at or below the cap', () => {
    const items = Array.from({ length: TASK_LIST_MAX_ITEMS }, (_, i) => i);

    const limited = limitForList(items);

    expect(limited.items).toEqual(items);
    expect(limited.total).toBe(TASK_LIST_MAX_ITEMS);
    expect(limited.hidden).toBe(0);
    expect(limited.note).toBeNull();
  });

  it('keeps only the most recent entries and reports the real total', () => {
    const items = Array.from({ length: 57 }, (_, i) => i);

    const limited = limitForList(items);

    expect(limited.items).toHaveLength(TASK_LIST_MAX_ITEMS);
    expect(limited.items[0]).toBe(37);
    expect(limited.items[19]).toBe(56);
    expect(limited.total).toBe(57);
    expect(limited.hidden).toBe(37);
    expect(limited.note).toBe('… 显示最近 20 / 共 57 条');
  });

  it('does not mutate the input list', () => {
    const items = Array.from({ length: 25 }, (_, i) => i);

    limitForList(items);

    expect(items).toHaveLength(25);
  });

  it('keeps active entries at the head instead of trimming them', () => {
    const tasks = makeEngineList(
      [
        { id: 'p-1', status: 'pending' },
        { id: 'r-1', status: 'running' },
      ],
      historyIds(30),
    );

    const limited = limitForList(tasks, TASK_LIST_MAX_ITEMS, { isActive: isActiveTask });

    expect(limited.items).toHaveLength(TASK_LIST_MAX_ITEMS);
    expect(limited.items.slice(0, 2).map(task => task.id)).toEqual(['p-1', 'r-1']);
    // Old history goes first: the newest 18 survive, h-0 … h-11 do not.
    expect(limited.items.map(task => task.id)).toEqual([
      'p-1',
      'r-1',
      ...Array.from({ length: 18 }, (_, i) => `h-${12 + i}`),
    ]);
    expect(limited.total).toBe(32);
    expect(limited.hidden).toBe(12);
    expect(limited.note).toBe('… 显示最近 20 / 共 32 条（另有 12 条历史未显示）');
  });

  it('keeps every active entry when actives alone exceed the cap', () => {
    const active = Array.from({ length: 25 }, (_, i) => ({
      id: `a-${i}`,
      status: (i % 2 === 0 ? 'pending' : 'running') as 'pending' | 'running',
    }));
    const tasks = makeEngineList(active, historyIds(5));

    const limited = limitForList(tasks, TASK_LIST_MAX_ITEMS, { isActive: isActiveTask });

    // Rows may exceed the cap — hiding a live task is worse than a long list.
    expect(limited.items).toHaveLength(25);
    expect(limited.items.map(task => task.id)).toEqual(active.map(task => task.id));
    expect(limited.total).toBe(30);
    expect(limited.hidden).toBe(5);
    expect(limited.note).toBe('… 显示最近 25 / 共 30 条（另有 5 条历史未显示）');
  });

  it('keeps the incoming order so no row jumps around', () => {
    const tasks = [...makeEngineList([], historyIds(30)), makeTask({ id: 'late', status: 'running' })];

    const limited = limitForList(tasks, 5, { isActive: isActiveTask });

    // Active row stays where it was in the list, not hoisted to the top.
    expect(limited.items.map(task => task.id)).toEqual(['h-26', 'h-27', 'h-28', 'h-29', 'late']);
  });

  it('emits no note when nothing was dropped, even with active entries', () => {
    const tasks = makeEngineList(
      [
        { id: 'p-1', status: 'pending' },
        { id: 'r-1', status: 'running' },
      ],
      historyIds(3),
    );

    const limited = limitForList(tasks, TASK_LIST_MAX_ITEMS, { isActive: isActiveTask });

    expect(limited.items).toHaveLength(5);
    expect(limited.hidden).toBe(0);
    expect(limited.note).toBeNull();
  });

  it('emits no note for an empty list', () => {
    const limited = limitForList<TaskDetail>([], TASK_LIST_MAX_ITEMS, { isActive: isActiveTask });

    expect(limited).toEqual({ items: [], total: 0, hidden: 0, note: null });
  });
});

describe('isActiveTask', () => {
  it('treats pending and running as active and every other status as history', () => {
    expect(isActiveTask({ status: 'pending' })).toBe(true);
    expect(isActiveTask({ status: 'running' })).toBe(true);
    expect(isActiveTask({ status: 'completed' })).toBe(false);
    expect(isActiveTask({ status: 'failed' })).toBe(false);
    expect(isActiveTask({ status: 'cancelled' })).toBe(false);
  });
});

describe('formatTaskRow', () => {
  it('keeps every existing column and only digests the description', () => {
    const task = makeTask({
      id: 't-42',
      status: 'running',
      description: longDescription(TASK_LIST_DESCRIPTION_MAX_WIDTH),
      workspace: { path: '/w/demo', slug: 'demo' },
      result: 'ok',
    });

    const row = formatTaskRow(task);

    expect(row).toContain('[running] t-42: ');
    expect(row).toContain(' — demo');
    expect(row).toContain(' → ok');
    expect(row).toContain('…');
    expect(row).not.toContain(task.description);
  });

  it('marks a task that runs outside the session default workspace with its slug', () => {
    const task = makeTask({
      id: 't-42',
      status: 'running',
      description: 'write tests',
      workspace: { path: '/w/other', slug: 'other' },
      result: 'ok',
    });

    expect(formatTaskRow(task, { defaultWorkspacePath: '/w/default' }))
      .toBe('[running] t-42: write tests — other → ok');
  });

  it('prints a default-workspace task exactly as an unmarked task', () => {
    const task = makeTask({
      id: 't-42',
      status: 'running',
      description: 'write tests',
      workspace: { path: '/w/default', slug: 'default' },
      result: 'ok',
    });

    const row = formatTaskRow(task, { defaultWorkspacePath: '/w/default' });

    expect(row).toBe('[running] t-42: write tests → ok');
    expect(row).toBe(formatTaskRow(makeTask({ id: 't-42', status: 'running', description: 'write tests', result: 'ok' })));
  });

  it('compares canonicalized paths, not raw spellings', () => {
    const task = makeTask({
      description: 'write tests',
      workspace: { path: '/w/default/', slug: 'default' },
    });

    expect(formatTaskRow(task, { defaultWorkspacePath: '/w/default' }))
      .toBe('[completed] t-1: write tests');
  });

  it('keeps the slug when the default workspace is unknown', () => {
    // Without a default there is nothing to compare against — showing the slug
    // beats silently dropping the attribution.
    const task = makeTask({ description: 'ctx', workspace: { path: '/w/impl', slug: 'impl' } });

    expect(formatTaskRow(task)).toBe('[completed] t-1: ctx — impl');
  });

  it('falls back to the slugified directory name when the task carries no slug', () => {
    const task = makeTask({ description: 'ctx', workspace: { path: '/w/My Project', slug: '' } });

    expect(formatTaskRow(task, { defaultWorkspacePath: '/w/default' }))
      .toBe('[completed] t-1: ctx — my-project');
  });

  it('appends no marker for a task without workspace identity', () => {
    expect(formatTaskRow(makeTask({ description: 'ctx' }), { defaultWorkspacePath: '/w/default' }))
      .toBe('[completed] t-1: ctx');
  });

  it('renders one line per task even for multi-line descriptions', () => {
    const row = formatTaskRow(makeTask({ description: 'a\nb\nc' }));

    expect(row).toBe('[completed] t-1: a b c');
  });

  it('flattens a multi-line result onto the same row', () => {
    // Worker reports arrive as free-form markdown: headings, indented bullets,
    // tabbed code. Every line break here used to become a wrapped row.
    const row = formatTaskRow(
      makeTask({ description: 'fix it', result: 'done:\n\t- one\n\t- two\n\n### notes\r\nend' }),
    );

    expect(row).toBe('[completed] t-1: fix it → done: - one - two ### notes end');
    expect(row).not.toContain('\n');
    expect(row).not.toContain('\t');
  });

  it('caps a very long result at the result budget, counting display columns', () => {
    // >1000 CJK chars = >2000 columns; must be cut to the 60-column budget.
    const huge = '任务结果'.repeat(300);
    expect(huge.length).toBeGreaterThan(1000);

    const row = formatTaskRow(makeTask({ description: 'd', result: huge }));
    const digest = row.slice(' → '.length + '[completed] t-1: d'.length);

    expect(row).toContain(' → ');
    expect(digest.endsWith('…')).toBe(true);
    expect(stringWidth(digest)).toBeLessThanOrEqual(TASK_LIST_RESULT_MAX_WIDTH);
    // Budget - 1 column for the ellipsis => 59 columns => 29 CJK chars + "…".
    expect([...digest]).toHaveLength(30);
  });

  it('keeps a result that already fits verbatim, with no ellipsis', () => {
    const task = makeTask({ description: 'd', result: 'ok' });

    expect(formatTaskRow(task)).toBe('[completed] t-1: d → ok');
    expect(formatTaskRow(task)).not.toContain('…');
  });

  it('appends no arrow when the result is empty or absent', () => {
    expect(formatTaskRow(makeTask({ description: 'd', result: '' }))).toBe('[completed] t-1: d');
    expect(formatTaskRow(makeTask({ description: 'd' }))).toBe('[completed] t-1: d');
    // Whitespace-only collapses to nothing — a bare " → " would be noise.
    expect(formatTaskRow(makeTask({ description: 'd', result: ' \n\t ' }))).toBe('[completed] t-1: d');
    expect(formatTaskRow(makeTask({ description: 'd', result: '' }))).not.toContain(' → ');
  });

  it('honours an explicit result width without touching the description width', () => {
    const task = makeTask({ description: 'd', result: 'abcdefghij' });

    expect(formatTaskRow(task, { resultMaxWidth: 5 })).toBe('[completed] t-1: d → abcd…');
    expect(formatTaskRow(task, { resultMaxWidth: 0 })).toBe('[completed] t-1: d');
  });
});

describe('formatTaskList', () => {
  it('outputs 20 rows plus a note for 57 tasks', () => {
    const tasks = Array.from({ length: 57 }, (_, i) =>
      makeTask({ id: `t-${i}`, description: longDescription(TASK_LIST_DESCRIPTION_MAX_WIDTH) }),
    );

    const lines = formatTaskList(tasks).split('\n');

    expect(lines).toHaveLength(TASK_LIST_MAX_ITEMS + 1);
    expect(lines[TASK_LIST_MAX_ITEMS]).toBe('… 显示最近 20 / 共 57 条');
    // The newest 20 survive; the oldest are dropped.
    expect(lines[0]).toContain('t-37');
    expect(lines[TASK_LIST_MAX_ITEMS - 1]).toContain('t-56');
  });

  it('keeps pending and running rows at the head of an over-cap list', () => {
    const tasks = makeEngineList(
      [
        { id: 'p-1', status: 'pending' },
        { id: 'r-1', status: 'running' },
      ],
      historyIds(30),
    );

    const lines = formatTaskList(tasks).split('\n');

    expect(lines).toHaveLength(TASK_LIST_MAX_ITEMS + 1);
    expect(lines[0]).toContain('[pending] p-1:');
    expect(lines[1]).toContain('[running] r-1:');
    // The newest history fills the remaining budget, oldest first to go.
    expect(lines[2]).toContain('h-12');
    expect(lines[TASK_LIST_MAX_ITEMS - 1]).toContain('h-29');
    expect(lines[TASK_LIST_MAX_ITEMS]).toBe('… 显示最近 20 / 共 32 条（另有 12 条历史未显示）');
    expect(lines.join('\n')).not.toContain('h-11');
  });

  it('notes only the cut when terminal history is the only thing trimmed', () => {
    const tasks = historyIds(57).map(id => makeTask({ id }));

    const lines = formatTaskList(tasks).split('\n');

    expect(lines).toHaveLength(TASK_LIST_MAX_ITEMS + 1);
    expect(lines[TASK_LIST_MAX_ITEMS]).toBe('… 显示最近 20 / 共 57 条');
    expect(lines[TASK_LIST_MAX_ITEMS]).not.toContain('另有');
  });

  it('emits no note line when active rows fit under the cap', () => {
    const tasks = makeEngineList(
      [
        { id: 'p-1', status: 'pending' },
        { id: 'r-1', status: 'running' },
      ],
      historyIds(5),
    );

    const lines = formatTaskList(tasks).split('\n');

    expect(lines).toHaveLength(7);
    expect(lines.some(line => line.startsWith('…'))).toBe(false);
    expect(lines.join('\n')).toContain('[pending] p-1:');
  });

  it('outputs every row and no note when at or below the cap', () => {
    const tasks = Array.from({ length: 5 }, (_, i) => makeTask({ id: `t-${i}` }));

    const lines = formatTaskList(tasks).split('\n');

    expect(lines).toHaveLength(5);
    expect(lines.some(line => line.startsWith('…'))).toBe(false);
  });

  it('keeps every row on one line and the description within the cap', () => {
    const long = longDescription(TASK_LIST_DESCRIPTION_MAX_WIDTH);
    const tasks = [
      makeTask({ description: 'first\nsecond\nthird' }),
      makeTask({ id: 't-2', description: long }),
    ];

    const lines = formatTaskList(tasks).split('\n');

    // "[completed] t-1: " is 17 columns, so a capped description yields 97.
    expect(lines[0]).toBe('[completed] t-1: first second third');
    expect(lines[1]).toBe(`[completed] t-2: ${truncateForList(long)}`);
    expect(lines[1].endsWith('…')).toBe(true);
    expect(stringWidth(lines[1])).toBe(17 + TASK_LIST_DESCRIPTION_MAX_WIDTH);
  });

  it('keeps the whole list within maxItems + 1 rows when results are huge', () => {
    // The real-world shape: a worker report of a few dozen KB with hundreds of
    // lines, pasted verbatim into every completed task's result.
    const fixture = Array.from(
      { length: 420 },
      (_, i) => `第 ${i} 行：worker 的最终报告，说明改了什么、跑了哪些门槛。`,
    ).join('\n');
    expect(Buffer.byteLength(fixture, 'utf8')).toBeGreaterThanOrEqual(32 * 1024);
    expect(fixture.split('\n')).toHaveLength(420);

    const tasks = Array.from({ length: 25 }, (_, i) => makeTask({ id: `t-${i}`, result: fixture }));

    const output = formatTaskList(tasks);
    const lines = output.split('\n');

    // 20 rows + the trailing note: the result contributes columns, never rows.
    expect(lines).toHaveLength(TASK_LIST_MAX_ITEMS + 1);
    expect(lines.length).toBeLessThanOrEqual(TASK_LIST_MAX_ITEMS + 1);
    expect(lines[TASK_LIST_MAX_ITEMS]).toBe('… 显示最近 20 / 共 25 条');
    // ~32KB × 25 in, a few KB out — the digest is what keeps the panel alive.
    expect(output.length).toBeLessThan(20 * 200);

    for (const line of lines.slice(0, TASK_LIST_MAX_ITEMS)) {
      expect(line).not.toContain('\n');
      expect(line).not.toContain('\t');
      expect(line.endsWith('…')).toBe(true);
      // '[completed] t-24: ' = 18 columns, then description + ' → ' + result.
      expect(stringWidth(line)).toBeLessThanOrEqual(
        18 + TASK_LIST_DESCRIPTION_MAX_WIDTH + 3 + TASK_LIST_RESULT_MAX_WIDTH,
      );
    }
  });

  it('caps results under the 20-row budget even with no note line', () => {
    const tasks = Array.from({ length: 5 }, (_, i) =>
      makeTask({ id: `t-${i}`, result: 'a\nb\nc\nd\ne' }),
    );

    const lines = formatTaskList(tasks).split('\n');

    expect(lines).toHaveLength(5);
    expect(lines.every(line => line.includes(' → a b c d e'))).toBe(true);
  });
});
