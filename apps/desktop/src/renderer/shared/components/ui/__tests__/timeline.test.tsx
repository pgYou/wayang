// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

/**
 * Timeline pins：一排节点按 `current` 分成 已完成 / 当前 / 未到 三种状态
 * （data-state），只有当前节点带 aria-current="step"；走过的线段是主色、
 * 没走的是边框色；最后一个节点后面没有线段；hint 弱化跟在 label 后面。
 */

vi.mock('lucide-react', () => ({
  CheckIcon: () => <span data-icon="check" />,
}));

import { Timeline } from '../timeline';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ITEMS = [
  { key: 'a', label: 'Provider' },
  { key: 'b', label: '模型' },
  { key: 'c', label: '模型绑定' },
  { key: 'd', label: 'Worker', hint: '（可选）' },
];

describe('Timeline', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const items = (): HTMLElement[] => Array.from(container.querySelectorAll<HTMLElement>('[data-slot="timeline-item"]'));
  const connectorClass = (li: HTMLElement): string => li.querySelector('[data-slot="timeline-connector"]')?.className ?? '';

  it('marks done / current / pending from `current`, with only the current node aria-current', () => {
    act(() => root.render(<Timeline items={ITEMS} current={2} />));
    const nodes = items();
    expect(nodes.length).toBe(4);
    expect(nodes.map((li) => li.dataset.state)).toEqual(['done', 'done', 'current', 'pending']);
    expect(nodes.map((li) => li.getAttribute('aria-current'))).toEqual([null, null, 'step', null]);
    // 完成的节点是对勾，其余是序号。
    expect(nodes[0]!.querySelector('[data-icon="check"]')).not.toBeNull();
    expect(nodes[2]!.querySelector('[data-icon="check"]')).toBeNull();
    expect(nodes[2]!.querySelector('[data-slot="timeline-marker"]')!.textContent).toBe('3');
  });

  it('connectors: the walked part is primary, the rest is the border color, and the last node has none', () => {
    act(() => root.render(<Timeline items={ITEMS} current={2} />));
    const nodes = items();
    expect(connectorClass(nodes[0]!)).toContain('bg-primary');
    expect(connectorClass(nodes[1]!)).toContain('bg-primary');
    expect(connectorClass(nodes[2]!)).toContain('bg-border');
    expect(connectorClass(nodes[3]!)).toBe('');
  });

  it('renders label and hint, and passes className through', () => {
    act(() => root.render(<Timeline items={ITEMS} current={0} className="mt-4" />));
    const last = items()[3]!;
    expect(last.textContent).toContain('Worker');
    expect(last.textContent).toContain('（可选）');
    expect(container.querySelector('[data-slot="timeline"]')!.classList.contains('mt-4')).toBe(true);
  });
});
