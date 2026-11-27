import { useSyncExternalStore } from 'react';

/**
 * 轻量页面路由（单窗口 Electron，file:// 环境——无 URL 可路由，react-router 的
 * BrowserRouter 不可用，MemoryRouter 等于自维护栈，故自持最小实现）：
 * - 外部单例 + `useSyncExternalStore`（与 wayangStore 同风格，per-route 订阅）；
 * - 栈式导航：`navigate` 入栈、`back` 出栈、`replace` 换栈顶（boot 门控切换用）；
 * - route params 承载跨页传参（如 onboard 的 problem 文案）。
 * 全局只有 App.tsx 消费路由表；页面间跳转经 router 单例调用。
 */

export type RoutePath = '/onboard' | '/chat' | '/settings';

export interface Route {
  path: RoutePath;
  params: Record<string, unknown>;
  /** 每次入栈自增：作为 React key 强制新路由实例挂载。 */
  key: number;
}

class SimpleRouter {
  private stack: Route[] = [{ path: '/chat', params: {}, key: 0 }];
  private seq = 0;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): Route => this.stack[this.stack.length - 1];

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /** 入栈导航（可返回）。 */
  navigate = (path: RoutePath, params: Record<string, unknown> = {}): void => {
    this.stack = [...this.stack, { path, params, key: (this.seq += 1) }];
    this.notify();
  };

  /** 换栈顶（不留返回入口）：boot 门控切换（onboard → chat）用。 */
  replace = (path: RoutePath, params: Record<string, unknown> = {}): void => {
    this.stack = [...this.stack.slice(0, -1), { path, params, key: (this.seq += 1) }];
    this.notify();
  };

  /** 出栈返回；栈底（无可返回项）为 no-op。 */
  back = (): void => {
    if (this.stack.length <= 1) return;
    this.stack = this.stack.slice(0, -1);
    this.notify();
  };

  /** 清栈回单页（重置一切导航状态）。 */
  reset = (path: RoutePath): void => {
    this.stack = [{ path, params: {}, key: (this.seq += 1) }];
    this.notify();
  };
}

/** 模块级单例（与 wayangStore 同模式）。 */
export const router = new SimpleRouter();

/** 订阅当前路由（per-route 细粒度：路由不变不重渲染）。 */
export function useRoute(): Route {
  return useSyncExternalStore(router.subscribe, router.getSnapshot);
}
