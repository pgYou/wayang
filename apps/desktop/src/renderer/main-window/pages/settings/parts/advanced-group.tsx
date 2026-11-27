import type { WayangConfig } from '@wayang-ai/protocol';
import { parseDirList, setIdleTimeoutMs, setLogging, setSignalWindowSize, setSkillsDirs, setTavilyApiKey } from '@/renderer/shared/lib/config-draft';
import { Input } from '@/renderer/shared/components/ui/input';
import { Textarea } from '@/renderer/shared/components/ui/textarea';
import { useDraftSection } from './draft-section';
import { SaveCancelBar } from './field-controls';
import { FieldLabel, SettingsRow, SettingsSection } from './settings-section';
import type { ConfigCommitState } from '../use-config-commit';

type CommitFn = ConfigCommitState['commit'];

/** 把「留空=默认，否则正整数」的数字输入转成 commit 调用。 */
function optionalPositiveInt(name: string, apply: (n: number | undefined) => Promise<void>) {
  return async (value: string): Promise<void> => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return apply(undefined);
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} 必须是正整数，留空表示使用默认值`);
    return apply(n);
  };
}

/** 高级分组：低频字段，全部重启后生效。 */
export function AdvancedGroup({ config, commit }: { config: WayangConfig; commit: CommitFn }) {
  const tavily = useDraftSection(config.tavilyApiKey ?? '', (value) => commit(setTavilyApiKey(config, value)));
  const skillsDirs = useDraftSection((config.skillsDirs ?? []).join('\n'), (text) => commit(setSkillsDirs(config, parseDirList(text))));
  const idleTimeout = useDraftSection(
    config.idleTimeoutMs !== undefined ? String(config.idleTimeoutMs) : '',
    optionalPositiveInt('idleTimeoutMs', (n) => commit(setIdleTimeoutMs(config, n))),
  );
  const signalWindow = useDraftSection(
    config.signalWindowSize !== undefined ? String(config.signalWindowSize) : '',
    optionalPositiveInt('signalWindowSize', (n) => commit(setSignalWindowSize(config, n))),
  );
  const logging = useDraftSection(
    { maxFileSizeBytes: config.logging?.maxFileSizeBytes, maxFiles: config.logging?.maxFiles },
    (value) => commit(setLogging(config, value)),
  );

  return (
    <>
      <SettingsSection title="集成" restart>
        <SettingsRow>
          <FieldLabel>Tavily API Key</FieldLabel>
          <Input type="password" value={tavily.value} onChange={(e) => tavily.setValue(e.target.value)} />
          <SaveCancelBar dirty={tavily.dirty} saving={tavily.saving} error={tavily.error} onSave={tavily.save} onCancel={tavily.cancel} />
        </SettingsRow>
        <SettingsRow>
          <FieldLabel>Skills 目录（skillsDirs）</FieldLabel>
          <Textarea rows={3} placeholder="/Users/me/skills" value={skillsDirs.value} onChange={(e) => skillsDirs.setValue(e.target.value)} />
          <SaveCancelBar dirty={skillsDirs.dirty} saving={skillsDirs.saving} error={skillsDirs.error} onSave={skillsDirs.save} onCancel={skillsDirs.cancel} />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="运行参数" restart>
        <SettingsRow>
          <FieldLabel>空闲超时（idleTimeoutMs）</FieldLabel>
          <Input inputMode="numeric" fieldSize="sm" placeholder="留空表示使用默认值" value={idleTimeout.value} onChange={(e) => idleTimeout.setValue(e.target.value)} />
          <SaveCancelBar dirty={idleTimeout.dirty} saving={idleTimeout.saving} error={idleTimeout.error} onSave={idleTimeout.save} onCancel={idleTimeout.cancel} />
        </SettingsRow>
        <SettingsRow>
          <FieldLabel>信号窗口大小（signalWindowSize）</FieldLabel>
          <Input inputMode="numeric" fieldSize="sm" placeholder="留空表示使用默认值" value={signalWindow.value} onChange={(e) => signalWindow.setValue(e.target.value)} />
          <SaveCancelBar dirty={signalWindow.dirty} saving={signalWindow.saving} error={signalWindow.error} onSave={signalWindow.save} onCancel={signalWindow.cancel} />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="日志滚动" restart>
        <SettingsRow>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <FieldLabel>单文件最大字节（maxFileSizeBytes）</FieldLabel>
              <Input
                inputMode="numeric"
                fieldSize="sm"
                placeholder="默认 10MB"
                value={logging.value.maxFileSizeBytes !== undefined ? String(logging.value.maxFileSizeBytes) : ''}
                onChange={(e) => logging.setValue({ ...logging.value, maxFileSizeBytes: e.target.value.trim() === '' ? undefined : Number(e.target.value) })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <FieldLabel>保留文件数（maxFiles）</FieldLabel>
              <Input
                inputMode="numeric"
                fieldSize="sm"
                placeholder="默认 3"
                value={logging.value.maxFiles !== undefined ? String(logging.value.maxFiles) : ''}
                onChange={(e) => logging.setValue({ ...logging.value, maxFiles: e.target.value.trim() === '' ? undefined : Number(e.target.value) })}
              />
            </div>
          </div>
          <SaveCancelBar dirty={logging.dirty} saving={logging.saving} error={logging.error} onSave={logging.save} onCancel={logging.cancel} />
        </SettingsRow>
      </SettingsSection>
    </>
  );
}
