// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { useDraftSection } from '../draft-section';

/**
 * useDraftSection pins:
 * - committed 是「每次渲染新引用的对象」（设置页 logging 这类多字段草稿）时
 *   不得自激更新——effect 只按内容跟随，不能每轮 setState（否则 React 抛
 *   "Maximum update depth exceeded"，进设置页即崩）；
 * - 内容变化才触发草稿同步；本节有未提交编辑时保留用户输入；
 * - dirty 由内容比较得出，cancel 回落到已提交值。
 */

interface ProbeProps {
  committed: { a: number; b?: number };
  onValue?: (value: { a: number; b?: number }) => void;
  onSave?: (value: { a: number; b?: number }) => Promise<void>;
}

function Probe({ committed, onValue, onSave }: ProbeProps) {
  const section = useDraftSection(committed, onSave ?? (async () => undefined));
  onValue?.(section.value);
  return (
    <div data-dirty={String(section.dirty)} data-value={JSON.stringify(section.value)}>
      <button type="button" onClick={() => section.setValue({ ...section.value, a: section.value.a + 1 })}>
        bump
      </button>
      <button type="button" onClick={section.cancel}>
        cancel
      </button>
    </div>
  );
}

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const current = (): HTMLElement => container!.firstElementChild as HTMLElement;

describe('useDraftSection', () => {
  it('does not loop when committed is a fresh object identity every render', () => {
    let renders = 0;
    function Counting() {
      renders += 1;
      useDraftSection({ a: 1, b: 2 }, async () => undefined);
      return <span />;
    }
    expect(() => {
      act(() => root!.render(<Counting />));
      act(() => root!.render(<Counting />));
    }).not.toThrow();
    expect(renders).toBeLessThanOrEqual(4);
  });

  it('keeps the first render state when committed is a fresh object identity every render', () => {
    expect(() => {
      act(() => root!.render(<Probe committed={{ a: 1, b: 2 }} />));
      act(() => root!.render(<Probe committed={{ a: 1, b: 2 }} />));
    }).not.toThrow();
    expect(current().dataset.dirty).toBe('false');
    expect(JSON.parse(current().dataset.value!)).toEqual({ a: 1, b: 2 });
  });

  it('marks dirty on edit and cancel restores the committed value', () => {
    act(() => root!.render(<Probe committed={{ a: 1 }} />));
    const [, cancel] = Array.from(current().querySelectorAll('button'));
    act(() => current().querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(current().dataset.dirty).toBe('true');
    expect(JSON.parse(current().dataset.value!)).toEqual({ a: 2 });
    act(() => cancel.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(current().dataset.dirty).toBe('false');
    expect(JSON.parse(current().dataset.value!)).toEqual({ a: 1 });
  });

  it('follows a committed content change only when the section is clean', () => {
    act(() => root!.render(<Probe committed={{ a: 1 }} />));
    act(() => root!.render(<Probe committed={{ a: 5 }} />));
    expect(JSON.parse(current().dataset.value!)).toEqual({ a: 5 });

    act(() => current().querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(JSON.parse(current().dataset.value!)).toEqual({ a: 6 });
    act(() => root!.render(<Probe committed={{ a: 9 }} />));
    // 有未提交编辑：保留用户输入，不被外部提交覆盖。
    expect(JSON.parse(current().dataset.value!)).toEqual({ a: 6 });
  });
});
