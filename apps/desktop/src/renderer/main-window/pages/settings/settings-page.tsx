import { useState } from 'react';
import { AppHeader } from '@/renderer/shared/components/shared/app-header';
import { Skeleton } from '@/renderer/shared/components/ui/skeleton';
import { AdvancedGroup } from './parts/advanced-group';
import { ModelsGroup } from './parts/models-group';
import { PermissionGroup } from './parts/permission-group';
import { AgentGroup } from './parts/agent-group';
import { WorkspaceGroup } from './parts/workspace-group';
import { SettingsNav, type SettingsGroup } from './settings-nav';
import { useConfigCommit } from './use-config-commit';

interface SettingsPageProps {
  onClose: () => void;
}

/**
 * 设置页——左栏分组导航 + 右栏当前分组内容的两栏布局。保存策略（卡片级）：
 * 选项/开关类字段即时生效，输入类字段走草稿+显式保存（见 parts/draft-section）。
 * 唯一 config 读写落点是 useConfigCommit；没有页面级整体保存按钮。保存后的
 * 反馈（已生效 / 需重启）是 toast（config-save-notice），页面本身不放提示条。
 */
export function SettingsPage({ onClose }: SettingsPageProps) {
  const [active, setActive] = useState<SettingsGroup>('models');
  const { load, config, desktop, commit } = useConfigCommit();

  return (
    <div className="flex h-full flex-col bg-grey-1">
      <AppHeader className="bg-grey-1" left={<span className="text-sm font-semibold">设置</span>} />
      <div className="flex-1 overflow-y-auto">
        {/* 底部留得比顶部多：滚到头时，最后一排的按钮不要贴着窗口下沿——贴边的交互区不好点。 */}
        <div className="mx-auto flex w-full max-w-4xl gap-6 px-6 pt-8 pb-24">
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
                {active === 'models' && <ModelsGroup config={config} commit={commit} />}
                {active === 'agent' && <AgentGroup config={config} commit={commit} />}
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
