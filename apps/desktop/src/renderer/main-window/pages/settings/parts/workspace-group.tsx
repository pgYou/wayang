import { FolderOpenIcon } from 'lucide-react';
import type { WayangConfig } from '@wayang-ai/protocol';
import { setWorkspacePref } from '@/renderer/shared/lib/config-draft';
import { Badge } from '@/renderer/shared/components/ui/badge';
import { Button } from '@/renderer/shared/components/ui/button';
import { wayang } from '@/renderer/shared/lib/wayang-api';
import { useAutoSaveAction } from './draft-section';
import { SettingsRow, SettingsSection } from './settings-section';
import type { ConfigCommitState } from '../use-config-commit';

type CommitFn = ConfigCommitState['commit'];

/** 工作区分组：worker 未显式指定项目目录时使用的默认工作区（desktop 偏好，重启后生效）。 */
export function WorkspaceGroup({
  config,
  desktop,
  commit,
}: {
  config: WayangConfig;
  desktop: Record<string, unknown>;
  commit: CommitFn;
}) {
  const workspace = typeof desktop.defaultWorkerWorkspace === 'string' ? desktop.defaultWorkerWorkspace : null;
  const action = useAutoSaveAction();

  const pick = (): void => {
    action.run(async () => {
      const { path } = await wayang.chooseDirectory();
      if (path) await commit(config, setWorkspacePref(desktop, path));
    });
  };

  return (
    <SettingsSection title="默认工作区" restart>
      <SettingsRow className="flex-row items-center gap-3">
        <span className="flex-1 truncate font-mono text-xs text-muted-foreground">{workspace ?? '默认（~/.agents/wayang-workspace）'}</span>
        <Badge variant={workspace ? 'default' : 'outline'}>{workspace ? '已自定义' : '默认'}</Badge>
        <Button size="sm" variant="outline" disabled={action.pending} onClick={pick}>
          <FolderOpenIcon />
          选择目录
        </Button>
      </SettingsRow>
      {action.error && <p className="px-4 pb-3 text-xs text-destructive">{action.error}</p>}
    </SettingsSection>
  );
}
