import { wayang } from './wayang-api';
import { wayangStore } from './store';

/**
 * 新会话懒加载：点「新会话」只重置本地视图（空会话态），真正的 server 会话
 * 在用户发出第一条消息时才创建——避免空会话堆积。
 *
 * `beginNewSession`：置 pending 标记 + 清空 store slices（标题随之回到
 * 「新对话」——它取自首条 user 消息）；不触碰 server。
 *
 * `submitInput`：所有用户输入的统一入口。pending 时先 `newSession`
 * （main 侧 graceful stop → fresh boot）+ `rehydrate`（空快照确认），
 * 再 `sendInput`。失败时重新置回 pending（下次输入重试创建）。
 */

let lazyNewPending = false;

/** 进入懒新会话态：本地清空，server 不动。 */
export function beginNewSession(): void {
  lazyNewPending = true;
  wayangStore.resetSlices();
}

/** 当前是否处于「待创建」的懒新会话态。 */
export function isLazyNewPending(): boolean {
  return lazyNewPending;
}

/**
 * 取消懒新会话态（不触碰 server）：切换到历史会话等场景必须调用——
 * 否则恢复旧会话视图后，下一条输入会被误判为「新会话首条消息」而创建新会话。
 */
export function cancelLazyNewSession(): void {
  lazyNewPending = false;
}

/** 用户输入统一入口：懒新会话首条消息先实际创建会话。 */
export async function submitInput(text: string): Promise<void> {
  if (lazyNewPending) {
    lazyNewPending = false;
    try {
      await wayang.newSession();
      await wayangStore.rehydrate();
    } catch (err) {
      // 创建失败：不吞错重置标记，让下一次输入重试；本次输入随异常上抛。
      lazyNewPending = true;
      throw err;
    }
  }
  await wayang.sendInput(text);
}
