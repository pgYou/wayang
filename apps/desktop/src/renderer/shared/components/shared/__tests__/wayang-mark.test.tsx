// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import markLightSvg from '@assets/logo/wayang-logo-light.svg?raw';
import markDarkSvg from '@assets/logo/wayang-logo-dark.svg?raw';
import { WayangMark } from '../wayang-mark';

/**
 * WayangMark pins：标是 assets/logo 那两份无边框 SVG 原样内联（图形只有一个
 * 来源，组件里不抄坐标和颜色），variant / background / size / animated 各自
 * 落在对应的类和属性上；两份文件的结构都满足律动依赖的约定——恰好三道
 * 折线、自上而下排列（wayang-mark.scss 把第 1 / 2 / 3 条对应到上 / 中 / 下，
 * 从底部开始依次亮起）。
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const polylines = (scope: ParentNode): Element[] => Array.from(scope.querySelectorAll('polyline'));
const strokes = (scope: ParentNode): string[] => polylines(scope).map((line) => line.getAttribute('stroke') ?? '');
const mark = (scope: ParentNode): HTMLElement => scope.querySelector<HTMLElement>('[data-slot="wayang-mark"]')!;

/** 折线第一个点的 y：用来确认三道线在文件里自上而下排列。 */
const firstY = (line: Element): number => Number((line.getAttribute('points') ?? '').split(/[ ,]/)[1]);

const assetStrokes = (svg: string): string[] => strokes(new DOMParser().parseFromString(svg, 'image/svg+xml'));

describe('WayangMark', () => {
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

  it('default: bare light mark at 32px, not animated', () => {
    act(() => root.render(<WayangMark />));
    const el = mark(container);
    expect(el.dataset.variant).toBe('light');
    expect(el.classList.contains('size-8')).toBe(true);
    expect(el.classList.contains('wayang-mark-tile')).toBe(false);
    expect(el.classList.contains('wayang-mark-animated')).toBe(false);
    // 无障碍名称沿用 SVG 文件自带的标注。
    const svg = el.querySelector('svg');
    expect(svg?.getAttribute('role')).toBe('img');
    expect(svg?.getAttribute('aria-label')).toBe('Wayang');
  });

  it('variant / background / size / animated / className each land where the styles expect them', () => {
    act(() => root.render(<WayangMark variant="dark" background size={64} animated className="ml-2" />));
    const el = mark(container);
    expect(el.dataset.variant).toBe('dark');
    for (const cls of ['wayang-mark-tile', 'wayang-mark-animated', 'size-16', 'ml-2']) {
      expect(el.classList.contains(cls), cls).toBe(true);
    }
  });

  it('the inlined strokes are the asset ones, per variant (no colors copied into the component)', () => {
    act(() => root.render(<WayangMark />));
    expect(strokes(container)).toEqual(assetStrokes(markLightSvg));
    act(() => root.render(<WayangMark variant="dark" />));
    expect(strokes(container)).toEqual(assetStrokes(markDarkSvg));
    // 两个变体确实不一样，上一条断言不是因为两份文件相同才成立。
    expect(assetStrokes(markLightSvg)).not.toEqual(assetStrokes(markDarkSvg));
  });
});

describe('WayangMark — asset contract', () => {
  it.each([
    ['light', markLightSvg],
    ['dark', markDarkSvg],
  ])('the %s asset keeps the contract the animation relies on: exactly three polylines, top to bottom', (_name, svg) => {
    // 直接读源码：不经过渲染，约定钉在文件本身上。
    const lines = polylines(new DOMParser().parseFromString(svg, 'image/svg+xml'));
    expect(lines.length).toBe(3);
    const ys = lines.map(firstY);
    expect(ys[0]).toBeLessThan(ys[1]);
    expect(ys[1]).toBeLessThan(ys[2]);
  });
});
