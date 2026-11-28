import { useCallback, useEffect, useState } from 'react';
import type { WayangConfig } from '@wayang-ai/protocol';
import { wayang } from '@/renderer/shared/lib/wayang-api';
import { notifyConfigSaved } from './config-save-notice';

export type ConfigLoadState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready' };

export interface ConfigCommitState {
  load: ConfigLoadState;
  config: WayangConfig | null;
  desktop: Record<string, unknown>;
  /**
   * 整份配置回传（没有分段保存的 IPC——每次提交都带着完整
   * WayangConfig，后端按整份做必要核心校验）。desktop 缺省沿用当前值。
   * 提交成功后刷新 committed 基线，使其它卡片的只读引用（如 Models 卡
   * 下拉里的 Providers 列表）跟着更新；保存后的反馈（已生效 / 需重启）
   * 走 toast（config-save-notice）。
   */
  commit: (next: WayangConfig, nextDesktop?: Record<string, unknown>) => Promise<void>;
  reload: () => void;
}

/**
 * 设置页的唯一 config 读写落点：每个分组/卡片都经这里的 commit 提交
 * 自己的改动，不再有页面级整体保存按钮（设置页保存策略：卡片独立
 * 保存，详见各 group 组件）。
 */
export function useConfigCommit(): ConfigCommitState {
  const [load, setLoad] = useState<ConfigLoadState>({ kind: 'loading' });
  const [config, setConfig] = useState<WayangConfig | null>(null);
  const [desktop, setDesktop] = useState<Record<string, unknown>>({});
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setLoad({ kind: 'loading' });
    void wayang
      .readConfig()
      .then((result) => {
        setConfig(result.config);
        setDesktop(result.desktop);
        setLoad({ kind: 'ready' });
      })
      .catch((err: unknown) => setLoad({ kind: 'error', message: err instanceof Error ? err.message : String(err) }));
  }, [reloadKey]);

  const commit = useCallback(
    async (next: WayangConfig, nextDesktop?: Record<string, unknown>): Promise<void> => {
      const desktopPatch = nextDesktop ?? desktop;
      const result = await wayang.saveConfig(next, desktopPatch);
      setConfig(next);
      setDesktop(desktopPatch);
      notifyConfigSaved(result);
    },
    [desktop],
  );

  return {
    load,
    config,
    desktop,
    commit,
    reload: (): void => setReloadKey((k) => k + 1),
  };
}
