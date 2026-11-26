import { describe, it, expect, beforeEach } from 'vitest';
import { router } from '../router';

/**
 * 轻量路由 pin：栈式导航语义（navigate 入栈 / back 出栈 / replace 换栈顶 / reset 清栈）
 * 与订阅通知。App 路由表消费这些语义，此处钉住行为契约。
 */
describe('simple router (lib/router)', () => {
  beforeEach(() => {
    router.reset('/chat');
  });

  it('starts on the chat route', () => {
    expect(router.getSnapshot()).toMatchObject({ path: '/chat' });
  });

  it('navigate pushes and back pops, returning to the previous route', () => {
    router.navigate('/settings');
    expect(router.getSnapshot().path).toBe('/settings');

    router.back();
    expect(router.getSnapshot().path).toBe('/chat');
  });

  it('back is a no-op at the bottom of the stack', () => {
    router.back();
    expect(router.getSnapshot().path).toBe('/chat');
  });

  it('replace swaps the top of the stack without a back entry', () => {
    router.replace('/onboard', { problem: 'x' });
    expect(router.getSnapshot()).toMatchObject({ path: '/onboard' });
    expect(router.getSnapshot().params).toEqual({ problem: 'x' });

    // 换栈顶后无可返回项：back 不弹回 replace 前的 /chat。
    router.back();
    expect(router.getSnapshot().path).toBe('/onboard');
  });

  it('route keys increase per navigation (fresh remount keys)', () => {
    const first = router.getSnapshot().key;
    router.navigate('/settings');
    const second = router.getSnapshot().key;
    router.navigate('/chat');
    expect(second).toBeGreaterThan(first);
    expect(router.getSnapshot().key).toBeGreaterThan(second);
  });

  it('notifies subscribers on every navigation and unsubscribe stops them', () => {
    const calls: string[] = [];
    const unsubscribe = router.subscribe(() => calls.push('tick'));

    router.navigate('/settings');
    router.back();
    expect(calls).toHaveLength(2);

    unsubscribe();
    router.navigate('/settings');
    expect(calls).toHaveLength(2);
  });
});
