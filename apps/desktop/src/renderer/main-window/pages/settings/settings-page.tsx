import { useState } from 'react';
import { LoaderIcon, RotateCcwIcon } from 'lucide-react';
import { AppHeader } from '@/renderer/shared/components/shared/app-header';
import { Button } from '@/renderer/shared/components/ui/button';
import { Skeleton } from '@/renderer/shared/components/ui/skeleton';
import { wayang } from '@/renderer/shared/lib/wayang-api';
import { AdvancedGroup } from './parts/advanced-group';
import { ModelsGroup } from './parts/models-group';
import { PermissionGroup } from './parts/permission-group';
import { WorkerGroup } from './parts/worker-group';
import { WorkspaceGroup } from './parts/workspace-group';
import { SettingsNav, type SettingsGroup } from './settings-nav';
import { useConfigCommit } from './use-config-commit';

interface SettingsPageProps {
  onClose: () => void;
}

/**
 * 设置页——左栏分组导航 + 右栏当前分组内容的两栏布局。保存策略（卡片级）：
 * 选项/开关类字段即时生效，输入类字段走草稿+显式保存（见 parts/draft-section）。
 * 唯一 config 读写落点是 useConfigCommit；没有页面级整体保存按钮。
 */
export function SettingsPage({ onClose }: SettingsPageProps) {
  const [active, setActive] = useState<SettingsGroup>('models');
  const { load, config, desktop, notice, dismissNotice, commit } = useConfigCommit();
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);

  const restart = (): void => {
    setRestarting(true);
    setRestartError(null);
    wayang
      .restartServer()
      .then(dismissNotice)
      .catch((err: unknown) => setRestartError(err instanceof Error ? err.message : String(err)))
      .finally(() => setRestarting(false));
  };

  return (
    <div className="flex h-full flex-col bg-grey-1">
      <AppHeader className="bg-grey-1" left={<span className="text-sm font-semibold">设置</span>} />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-4xl gap-12 px-6 py-8">
          <SettingsNav active={active} onSelect={setActive} onBack={onClose} />
          <div className="flex min-w-0 flex-1 flex-col gap-8">
            {load.kind === 'loading' && (
              <div className="flex flex-col gap-4">
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            )}
            {load.kind === 'error' && (
              <p className="rounded-md border border-destructive/30 bg-destructive-soft px-3 py-2 text-sm text-destructive">{load.message}</p>
            )}
            {load.kind === 'ready' && config && (
              <>
                {notice && (
                  <div className="flex flex-col gap-2 rounded-xl bg-card px-4 py-3 text-sm shadow-card">
                    {notice.applied.length > 0 && (
                      <p>
                        <span className="font-medium text-primary-strong">已生效：</span>
                        {notice.applied.join('、')}
                      </p>
                    )}
                    {notice.restartRequired.length > 0 && (
                      <p>
                        <span className="font-medium">重启 server 后生效：</span>
                        {notice.restartRequired.join('、')}
                      </p>
                    )}
                    {restartError && <p className="text-xs text-destructive">{restartError}</p>}
                    <div className="flex items-center gap-2">
                      {notice.restartRequired.length > 0 ? (
                        <Button size="sm" variant="outline" disabled={restarting} onClick={restart}>
                          {restarting ? <LoaderIcon className="animate-spin" /> : <RotateCcwIcon />}
                          重启 server 以生效
                        </Button>
                      ) : null}
                      <Button size="sm" variant="ghost" onClick={dismissNotice}>
                        知道了
                      </Button>
                    </div>
                  </div>
                )}
                {active === 'models' && <ModelsGroup config={config} commit={commit} />}
                {active === 'worker' && <WorkerGroup config={config} commit={commit} />}
                {active === 'permission' && <PermissionGroup config={config} commit={commit} />}
                {active === 'workspace' && <WorkspaceGroup config={config} desktop={desktop} commit={commit} />}
                {active === 'advanced' && <AdvancedGroup config={config} commit={commit} />}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
