// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

/**
 * AppHeader pins（§2.1 自定义 header）：
 * - darwin：默认渲染系统红绿灯占位（w-16）；`wayang:window` 推送 fullscreen
 *   后占位收拢（macOS 全屏隐藏红绿灯，logo 从左缘排起）；
 * - 非 darwin：无占位，渲染自绘回退按钮（WindowControls）。
 * onWindowState 的订阅/退订生命周期一并钉住。
 */

type WindowStateListener = (state: { fullscreen: boolean }) => void;

const hoisted = vi.hoisted(() => ({
  listeners: new Set<WindowStateListener>(),
  subscribeSpy: vi.fn(),
}));

vi.mock('@/renderer/shared/lib/wayang-api', () => ({
  wayang: {
    onWindowState: (callback: WindowStateListener): (() => void) => {
      hoisted.listeners.add(callback);
      hoisted.subscribeSpy();
      return () => hoisted.listeners.delete(callback);
    },
    windowControl: vi.fn(),
  },
}));

vi.mock('lucide-react', () => ({
  Maximize2Icon: (props: Record<string, unknown>) => <span data-icon="zoom" {...props} />,
  MinusIcon: (props: Record<string, unknown>) => <span data-icon="minus" {...props} />,
  XIcon: (props: Record<string, unknown>) => <span data-icon="x" {...props} />,
}));

import { AppHeader } from '../app-header';

// React 19 act()：显式声明 act 环境（与 session-menu / store-render 同款）。
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalUA = navigator.userAgent;
const stubUA = (ua: string): void => {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
};

function renderHeader(container: HTMLElement): Root {
  const root = createRoot(container);
  act(() => {
    root.render(<AppHeader left={<span>标题</span>} right={<button type="button">动作</button>} />);
  });
  return root;
}

const fireWindow = (fullscreen: boolean): void => {
  act(() => {
    for (const listener of hoisted.listeners) listener({ fullscreen });
  });
};

describe('AppHeader (custom header §2.1)', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    hoisted.listeners.clear();
    hoisted.subscribeSpy.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    const current = root;
    if (current) {
      act(() => current.unmount());
      root = null;
    }
    stubUA(originalUA);
    container.remove();
  });

  it('darwin: reserves the traffic-light spacer, collapses it on fullscreen pushes', () => {
    stubUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    root = renderHeader(container);

    expect(container.querySelector('.w-16')).not.toBeNull();
    expect(hoisted.subscribeSpy).toHaveBeenCalledTimes(1);

    fireWindow(true);
    expect(container.querySelector('.w-16')).toBeNull();
    expect(container.querySelector('img[alt="Wayang"]')).not.toBeNull();

    fireWindow(false);
    expect(container.querySelector('.w-16')).not.toBeNull();
  });

  it('has no bottom border: the fade under the header lives in app-header.scss, not on the element', () => {
    stubUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    root = renderHeader(container);
    const header = container.querySelector('header.wayang-app-header')!;
    expect(header.classList.contains('border-b')).toBe(false);
  });

  it('unsubscribes from wayang:window on unmount', () => {
    stubUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    const local = renderHeader(container);
    act(() => {
      local.unmount();
    });
    expect(hoisted.listeners.size).toBe(0);
  });

  it('non-darwin: renders the fallback WindowControls instead of the spacer', () => {
    stubUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    root = renderHeader(container);

    expect(container.querySelector('.w-16')).toBeNull();
    expect(container.querySelectorAll('button[aria-label]').length).toBeGreaterThanOrEqual(3);
  });
});
