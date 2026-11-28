import type { WayangConfig } from '@wayang-ai/protocol';
import { parseDirList, setApprovalMemory, setPermissionList, setSensitiveMode } from '@/renderer/shared/lib/config-draft';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/shared/components/ui/select';
import { Textarea } from '@/renderer/shared/components/ui/textarea';
import { useAutoSaveAction } from '@/renderer/main-window/components/settings/draft-section';
import { DraftRow } from './draft-row';
import { FieldLabel, SettingsRow, SettingsSection } from '@/renderer/main-window/components/settings/settings-section';
import type { ConfigCommitState } from '../use-config-commit';

type CommitFn = ConfigCommitState['commit'];

/** 权限分组：目录类字段（草稿+保存）+ 两个模式选项（即时生效）。全部重启后生效。 */
export function PermissionGroup({ config, commit }: { config: WayangConfig; commit: CommitFn }) {
  const modeAction = useAutoSaveAction();
  return (
    <>
      <SettingsSection title="策略" restart>
        <SettingsRow>
          <FieldLabel>敏感目录命中时</FieldLabel>
          <Select
            value={config.permission?.sensitiveMode ?? 'ask'}
            onValueChange={(v) => modeAction.run(() => commit(setSensitiveMode(config, v as 'ask' | 'deny')))}
          >
            <SelectTrigger fieldSize="md">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ask">询问（ask）</SelectItem>
              <SelectItem value="deny">直接拒绝（deny）</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow>
          <FieldLabel>审批记忆</FieldLabel>
          <Select
            value={config.permission?.approvalMemory ?? 'task'}
            onValueChange={(v) => modeAction.run(() => commit(setApprovalMemory(config, v as 'task' | 'off')))}
          >
            <SelectTrigger fieldSize="md">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="task">同任务内记住（task）</SelectItem>
              <SelectItem value="off">每次都问（off）</SelectItem>
            </SelectContent>
          </Select>
          {modeAction.error && <p className="text-xs text-destructive">{modeAction.error}</p>}
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="目录" restart>
        <DirListRow
          title="始终允许（allowedDirs）"
          value={(config.permission?.allowedDirs ?? []).join('\n')}
          onSave={(dirs) => commit(setPermissionList(config, 'allowedDirs', dirs))}
        />
        <DirListRow
          title="自动允许根目录（autoAllowRoots）"
          value={(config.permission?.autoAllowRoots ?? []).join('\n')}
          onSave={(dirs) => commit(setPermissionList(config, 'autoAllowRoots', dirs))}
        />
        <DirListRow
          title="敏感目录（sensitiveDirs）"
          value={(config.permission?.sensitiveDirs ?? []).join('\n')}
          onSave={(dirs) => commit(setPermissionList(config, 'sensitiveDirs', dirs))}
        />
        <DirListRow
          title="额外工作区根目录（extraWorkspaceRoots）"
          value={(config.permission?.extraWorkspaceRoots ?? []).join('\n')}
          onSave={(dirs) => commit(setPermissionList(config, 'extraWorkspaceRoots', dirs))}
        />
      </SettingsSection>
    </>
  );
}

function DirListRow({ title, value, onSave }: { title: string; value: string; onSave: (dirs: string[]) => Promise<void> }) {
  return (
    <DraftRow label={title} committed={value} onSave={(text) => onSave(parseDirList(text))}>
      {(text, set) => <Textarea placeholder={'/Users/me/projects\n/Users/me/work'} value={text} onChange={(e) => set(e.target.value)} />}
    </DraftRow>
  );
}
