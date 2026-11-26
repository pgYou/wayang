import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 新会话懒加载 pin：确认动作只重置本地视图；首条输入才实际创建 server 会话；
 * 创建失败回滚 pending 标记（下次输入重试）且不上送半途消息。
 */

vi.mock('../wayang-api', () => ({
  wayang: {
    newSession: vi.fn(),
    sendInput: vi.fn(),
  },
}));

vi.mock('../store', () => ({
  wayangStore: { resetSlices: vi.fn(), rehydrate: vi.fn() },
}));

import { wayang } from '../wayang-api';
import { wayangStore } from '../store';
import { beginNewSession, cancelLazyNewSession, isLazyNewPending, submitInput } from '../session-lazy';

beforeEach(() => {
  vi.clearAllMocks();
  // 模块级 pending 标记是跨用例共享的单例状态，逐用例显式归零。
  cancelLazyNewSession();
});

describe('session-lazy (新会话懒加载)', () => {
  it('beginNewSession resets the local view and arms the pending flag', () => {
    expect(isLazyNewPending()).toBe(false);
    beginNewSession();
    expect(wayangStore.resetSlices).toHaveBeenCalledTimes(1);
    expect(isLazyNewPending()).toBe(true);
    // server 不被触碰。
    expect(wayang.newSession).not.toHaveBeenCalled();
  });

  it('submitInput without pending sends directly', async () => {
    await submitInput('hello');
    expect(wayang.sendInput).toHaveBeenCalledWith('hello');
    expect(wayang.newSession).not.toHaveBeenCalled();
  });

  it('first input after beginNewSession creates the session, rehydrates, then sends', async () => {
    vi.mocked(wayang.newSession).mockResolvedValue({ sessionId: 'fresh' });
    beginNewSession();

    await submitInput('hello');

    const order = [
      vi.mocked(wayangStore.resetSlices).mock.invocationCallOrder[0],
      vi.mocked(wayang.newSession).mock.invocationCallOrder[0],
      vi.mocked(wayangStore.rehydrate).mock.invocationCallOrder[0],
      vi.mocked(wayang.sendInput).mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(wayang.sendInput).toHaveBeenCalledWith('hello');
    expect(isLazyNewPending()).toBe(false);
  });

  it('a failed creation re-arms pending and never sends the message', async () => {
    vi.mocked(wayang.newSession).mockRejectedValue(new Error('switch failed'));
    beginNewSession();

    await expect(submitInput('hello')).rejects.toThrow('switch failed');
    expect(wayang.sendInput).not.toHaveBeenCalled();
    expect(isLazyNewPending()).toBe(true);
  });
});
