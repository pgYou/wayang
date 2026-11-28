import type { MouseEvent } from 'react';
import { toast } from 'sonner';
import { wayang } from '@/renderer/shared/lib/wayang-api';
import type { SaveConfigResult } from '@/shared/ipc-contract';

const APPLIED_TOAST = 'config-applied';
const RESTART_TOAST = 'config-restart-required';

/**
 * 设置保存后的反馈（toast，不再在页面顶部手写提示条）：
 * - 全部热更生效 → 一条短暂的「已保存并生效」；
 * - 有需要重启才生效的项 → 一条常驻提示，列出是哪些，带「重启」按钮。
 * 两种都用固定 id：连续保存时更新同一条，不堆一摞。
 *
 * 标题永远是一句短话、不换行（toast 的标题是 nowrap 的）；动作按钮也只有
 * 两三个字。具体是哪些设置、出了什么错这类可能很长的内容一律放 description，
 * 它可以换行。
 */
export function notifyConfigSaved(result: SaveConfigResult): void {
  if (result.restartRequired.length > 0) {
    toast('已保存，需重启生效', {
      id: RESTART_TOAST,
      description: `以下设置重启后生效：${result.restartRequired.join('、')}`,
      duration: Infinity,
      action: restartAction('重启'),
    });
    return;
  }
  if (result.applied.length > 0) toast.success('已保存并生效', { id: APPLIED_TOAST, duration: 2000 });
}

/** 正在重启中：按钮可能被连点，同一时间只跑一次。 */
let restarting = false;

/**
 * 「重启 / 重试」按钮。sonner 在动作按钮点完会自动关掉这条提示，而这里是把
 * 同一条原地把内容换成「正在重启…」再换成结果，所以要点下时拦下这个默认
 * 行为（preventDefault），否则提示会带着正在重启的状态一起消失。
 */
function restartAction(label: string) {
  return {
    label,
    onClick: (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      void restartServer();
    },
  };
}

/** 重启期间原提示变成「正在重启」，成功 / 失败都落在同一条上。 */
async function restartServer(): Promise<void> {
  if (restarting) return;
  restarting = true;
  toast.loading('正在重启…', { id: RESTART_TOAST, description: 'server 正在以新配置启动', duration: Infinity, action: null });
  try {
    await wayang.restartServer();
    toast.success('server 已重启', { id: RESTART_TOAST, description: '需要重启的设置已生效', duration: 3000 });
  } catch (err) {
    toast.error('重启失败', {
      id: RESTART_TOAST,
      description: err instanceof Error ? err.message : String(err),
      duration: Infinity,
      action: restartAction('重试'),
    });
  } finally {
    restarting = false;
  }
}
