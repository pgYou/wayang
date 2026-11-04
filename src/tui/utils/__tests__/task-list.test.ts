import { describe, it, expect } from 'vitest';
import {
  TASK_LIST_DESCRIPTION_MAX_WIDTH,
  TASK_LIST_MAX_ITEMS,
  formatTaskList,
  formatTaskRow,
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
    expect(row).toContain(' — demo (/w/demo)');
    expect(row).toContain(' → ok');
    expect(row).toContain('…');
    expect(row).not.toContain(task.description);
  });

  it('renders one line per task even for multi-line descriptions', () => {
    const row = formatTaskRow(makeTask({ description: 'a\nb\nc' }));

    expect(row).toBe('[completed] t-1: a b c');
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
});
