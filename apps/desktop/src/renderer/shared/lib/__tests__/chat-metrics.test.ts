import { describe, it, expect } from 'vitest';
import type { ContextUsage } from '@wayang-ai/protocol';
import { buildTurnDirectory, contextPercent, formatDuration, formatMessageTime, formatTokens, shouldFold, turnBarVisualState, TURN_BAR_MAX_SCALE } from '../chat-metrics';

/**
 * 折叠阈值与导航窗口（≤20 圆点）行为符合参数。
 */

const usage = (used: number, window: number): ContextUsage =>
  ({ usedTokens: used, contextWindowTokens: window, contextWindow: 0 }) as unknown as ContextUsage;

describe('contextPercent (上下文圆环)', () => {
  it('computes and clamps the ring percentage', () => {
    expect(contextPercent(usage(25_000, 100_000))).toBe(25);
    expect(contextPercent(usage(0, 100_000))).toBe(0);
    expect(contextPercent(usage(150_000, 100_000))).toBe(100);
    expect(contextPercent(null)).toBeNull();
    expect(contextPercent(usage(10, 0))).toBeNull();
  });

  it('formats compact token labels', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(12_340)).toBe('12.1k');
    expect(formatTokens(256 * 1024)).toBe('256.0k');
  });
});

describe('shouldFold (长消息折叠 >300px)', () => {
  it('folds only when the rendered height exceeds the threshold and is not expanded', () => {
    expect(shouldFold(300, false)).toBe(false);
    expect(shouldFold(301, false)).toBe(true);
    expect(shouldFold(640, true)).toBe(false);
    expect(shouldFold(null, false)).toBe(false);
  });
});

describe('formatMessageTime (消息时间戳)', () => {
  it('当天只显示时分秒；非当天带年月日；非法值空串', () => {
    const now = Date.now();
    // 同一天内的时刻（今天 09:05:07）。
    const today = new Date();
    today.setHours(9, 5, 7, 0);
    expect(formatMessageTime(today.getTime())).toBe('09:05:07');
    // 昨天同一时刻：带日期前缀。
    const yesterday = new Date(today.getTime() - 86_400_000);
    const expected = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')} 09:05:07`;
    expect(formatMessageTime(yesterday.getTime())).toBe(expected);
    // 边界防御。
    expect(formatMessageTime(0)).toBe('');
    expect(formatMessageTime(Number.NaN)).toBe('');
    // now 变量仅说明语义：同日判定基于运行时钟。
    expect(typeof now).toBe('number');
  });
});

describe('formatDuration (思考耗时标签)', () => {
  // 不足 1 分钟只显示秒；满 1 分钟显示 xm ys；非法值按 0 防御。
  it.each([
    [0, '0s'],
    [999, '0s'],
    [3_000, '3s'],
    [59_999, '59s'],
    [60_000, '1m 0s'],
    [65_000, '1m 5s'],
    [125_000, '2m 5s'],
    [3_600_000, '60m 0s'],
    [-5_000, '0s'],
    [Number.NaN, '0s'],
  ])('formats %d ms as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe('buildTurnDirectory (轮次导航目录)', () => {
  type Row = { role: string; id: string; content: string };
  const user = (id: string, content: string): Row => ({ role: 'user', id, content });
  const assistant = (id: string, content: string): Row => ({ role: 'assistant', id, content });

  it('每条 user 提问一项；assistant 摘要取该轮内首条带正文的步骤（纯工具步骤跳过）', () => {
    const rows: Row[] = [
      user('u1', '第一个问题'),
      assistant('a1', ''), // 纯工具步骤：无正文
      assistant('a2', '第一轮的回复正文'),
      user('u2', '第二个问题'),
      assistant('a3', '第二轮的回复正文'),
    ];
    expect(buildTurnDirectory(rows, false)).toEqual([
      { id: 'u1', preview: '第一个问题', assistantPreview: '第一轮的回复正文', running: false },
      { id: 'u2', preview: '第二个问题', assistantPreview: '第二轮的回复正文', running: false },
    ]);
  });

  it('assistant 摘要不会越过下一条 user（不串轮）；signal/system 行不进摘要', () => {
    const rows: Row[] = [
      user('u1', '问题一'),
      { role: 'signal', id: 's1', content: 'worker 完成信号' },
      user('u2', '问题二'),
      assistant('a2', '只属于第二轮'),
    ];
    const items = buildTurnDirectory(rows, false);
    expect(items[0].assistantPreview).toBeUndefined();
    expect(items[1].assistantPreview).toBe('只属于第二轮');
  });

  it('busy 且为最后一条 user 时标 running；非尾轮或非 busy 不标', () => {
    const rows: Row[] = [user('u1', '问题一'), assistant('a1', '回复一'), user('u2', '问题二')];
    expect(buildTurnDirectory(rows, true).map((item) => item.running)).toEqual([false, true]);
    expect(buildTurnDirectory(rows, false).map((item) => item.running)).toEqual([false, false]);
  });

  it('空会话或只有一条提问时目录如实返回（显隐由组件按 <2 判定）', () => {
    expect(buildTurnDirectory([], false)).toEqual([]);
    expect(buildTurnDirectory([user('u1', '唯一问题')], false)).toHaveLength(1);
  });
});

describe('turnBarVisualState (hover 山峰状态机，ZCode 1:1)', () => {
  it('无交互焦点回落 idle', () => {
    expect(turnBarVisualState(3, null)).toEqual({ colorTone: 'muted', opacity: 0.58, scaleX: 1, tone: 'idle' });
  });

  it.each([
    [0, { colorTone: 'focus', opacity: 1, scaleX: 2.6, tone: 'peak' }],
    [1, { colorTone: 'muted', opacity: 0.86, scaleX: 1.7, tone: 'near' }],
    [2, { colorTone: 'muted', opacity: 0.72, scaleX: 1.25, tone: 'mid' }],
    [5, { colorTone: 'muted', opacity: 0.58, scaleX: 1, tone: 'idle' }],
  ] as const)('距离 %i 的横条状态', (distance, expected) => {
    // 焦点两侧对称：上方与下方同距离同状态。
    expect(turnBarVisualState(10 + distance, 10)).toEqual(expected);
    expect(turnBarVisualState(10 - distance, 10)).toEqual(expected);
  });

  it('山峰 scale 封顶为 2（渲染时 min，peak 2.6 → 2）', () => {
    expect(Math.min(turnBarVisualState(0, 0).scaleX, TURN_BAR_MAX_SCALE)).toBe(2);
  });
});
