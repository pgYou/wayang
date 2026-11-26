// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

/**
 * Thinking 耗时标签（fake timers）：
 * - 进行中每秒 tick「思考中 Xs」（起点 startedAt，晚挂载不漂移；≥1m 转 xm ys）；
 * - 同一 mount 内结束：定格；durationMs（权威记录）已知时覆盖为它；
 * - 挂载即完成：有 durationMs →「已思考 Xs」；无（历史数据无 timing）→「已思考」；
 * - 显式 title 传入时完全优先（既有语义保持）。
 */

vi.mock('lucide-react', () => ({
  ChevronRightIcon: (props: Record<string, unknown>) => <span data-icon="chevron" {...props} />,
}));
vi.mock('../collapse', () => ({
  Collapse: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { Thinking } from '../thinking';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const headerText = (container: HTMLElement): string =>
  (container.querySelector('.wayang-thinking-header span.select-none') as HTMLElement | null)?.textContent ?? '';

function render(container: HTMLElement, props: React.ComponentProps<typeof Thinking>): Root {
  const root = createRoot(container);
  act(() => {
    root.render(<Thinking {...props} />);
  });
  return root;
}

describe('Thinking — 耗时标签', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-26T12:00:00Z'));
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => {
      vi.runOnlyPendingTimers();
    });
    vi.useRealTimers();
    container.remove();
  });

  it('进行中每秒 tick「思考中 Xs」，起点取 startedAt（晚挂载不漂移）', () => {
    // startedAt 比 fake now 早 30s：挂载瞬间就应显示 30s，而不是从 0s 起算。
    const startedAt = Date.now() - 30_000;
    const root = render(container, { loading: true, startedAt, children: '推理文本' });

    expect(headerText(container)).toBe('思考中 30s');

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(headerText(container)).toBe('思考中 33s');

    // 满 1 分钟切换为 xm ys 格式。
    act(() => {
      vi.advanceTimersByTime(28_000);
    });
    expect(headerText(container)).toBe('思考中 1m 1s');

    act(() => root.unmount());
  });

  it('同一 mount 内结束：durationMs 已知时定格为权威记录值', () => {
    const root = render(container, { loading: true, startedAt: Date.now(), children: '推理文本' });
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(headerText(container)).toBe('思考中 5s');

    // 结束：记录的 durationMs=4.2s 覆盖最后一次 tick（5s）。
    act(() => {
      root.render(<Thinking loading={false} startedAt={Date.now()} durationMs={4_200} children="推理文本" />);
    });
    expect(headerText(container)).toBe('已思考 4s');

    // 定格后不再随时间变化。
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(headerText(container)).toBe('已思考 4s');

    act(() => root.unmount());
  });

  it('挂载即完成：有 durationMs 显示秒数，无 timing 的历史数据退化为「已思考」', () => {
    render(container, { loading: false, durationMs: 65_000, children: '推理文本' });
    expect(headerText(container)).toBe('已思考 1m 5s');

    const legacy = document.createElement('div');
    document.body.appendChild(legacy);
    render(legacy, { loading: false, children: '推理文本' });
    expect(headerText(legacy)).toBe('已思考');
    legacy.remove();
  });

  it('显式 title 传入时完全优先', () => {
    render(container, { loading: true, startedAt: Date.now(), title: '自定义标题', children: '推理文本' });
    expect(headerText(container)).toBe('自定义标题');
  });
});
