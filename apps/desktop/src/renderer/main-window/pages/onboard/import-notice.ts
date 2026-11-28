import { toast } from 'sonner';
import type { ImportedWorkerDisabled } from '@/shared/config-envelope';

/**
 * 「导入 CLI 配置」落到确认页时，如果有第三方 worker 因为配置不合法被置为停用，
 * 用 toast 交代清楚：哪几行、为什么。确认页上不摆第三方 worker（onboard 不添加
 * 第三方 worker），所以这件事只能在这里说。这条常驻，点一下才关。
 * 没有被停用的行就不提示。
 */
export function notifyImportedWorkersDisabled(disabledWorkers: readonly ImportedWorkerDisabled[]): void {
  if (disabledWorkers.length === 0) return;
  const rows = disabledWorkers.map((row) => `${row.id}（${row.problem}）`).join('；');
  toast('导入的配置里有 worker 已置为停用', {
    description: `${disabledWorkers.length} 个第三方 worker 的配置不合法，已置为停用；「进入应用」之后可以在「设置 → Agent」里修正再启用：${rows}`,
    duration: Infinity,
  });
}
