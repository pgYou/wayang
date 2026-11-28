import type { LoggingConfig, WayangConfig } from '@wayang-ai/protocol';
import { parseDirList, setIdleTimeoutMs, setLogging, setSignalWindowSize, setSkillsDirs, setTavilyApiKey } from '@/renderer/shared/lib/config-draft';
import { Input } from '@/renderer/shared/components/ui/input';
import { Textarea } from '@/renderer/shared/components/ui/textarea';
import { FormField, parsePositiveInt } from '@/renderer/main-window/components/settings';
import { DraftRow } from './draft-row';
import { SettingsSection } from './settings-section';
import type { ConfigCommitState } from '../use-config-commit';

type CommitFn = ConfigCommitState['commit'];

/**
 * 「留空 = 用默认值，否则必须是正整数」的输入框：草稿里是文本，校验交给
 * DraftRow 就近显示，保存时才转成数字（留空即 undefined）。
 */
function positiveIntField(name: string): {
  problem: (text: string) => string | null;
  parse: (text: string) => number | undefined;
} {
  return {
    problem: (text) => (parsePositiveInt(text).invalid ? `${name} 必须是正整数，留空表示使用默认值` : null),
    parse: (text) => parsePositiveInt(text).value,
  };
}

/** 日志滚动两项的草稿（都是文本）。 */
interface LoggingForm {
  maxFileSizeBytes: string;
  maxFiles: string;
}

/** 高级分组：低频字段，全部重启后生效。 */
export function AdvancedGroup({ config, commit }: { config: WayangConfig; commit: CommitFn }) {
  const idleTimeout = positiveIntField('idleTimeoutMs');
  const signalWindow = positiveIntField('signalWindowSize');
  const logSize = positiveIntField('maxFileSizeBytes');
  const logFiles = positiveIntField('maxFiles');

  const loggingCommitted: LoggingForm = {
    maxFileSizeBytes: config.logging?.maxFileSizeBytes !== undefined ? String(config.logging.maxFileSizeBytes) : '',
    maxFiles: config.logging?.maxFiles !== undefined ? String(config.logging.maxFiles) : '',
  };
  const saveLogging = (form: LoggingForm): Promise<void> => {
    // 两项都留空即整个 logging 段落清掉。
    const logging: LoggingConfig = {};
    const size = logSize.parse(form.maxFileSizeBytes);
    const files = logFiles.parse(form.maxFiles);
    if (size !== undefined) logging.maxFileSizeBytes = size;
    if (files !== undefined) logging.maxFiles = files;
    return commit(setLogging(config, logging));
  };

  return (
    <>
      <SettingsSection title="集成" restart>
        <DraftRow label="Tavily API Key" committed={config.tavilyApiKey ?? ''} onSave={(value) => commit(setTavilyApiKey(config, value))}>
          {(value, set) => <Input type="password" value={value} onChange={(e) => set(e.target.value)} />}
        </DraftRow>
        <DraftRow
          label="Skills 目录（skillsDirs）"
          committed={(config.skillsDirs ?? []).join('\n')}
          onSave={(text) => commit(setSkillsDirs(config, parseDirList(text)))}
        >
          {(text, set) => <Textarea placeholder="/Users/me/skills" value={text} onChange={(e) => set(e.target.value)} />}
        </DraftRow>
      </SettingsSection>

      <SettingsSection title="运行参数" restart>
        <DraftRow
          label="空闲超时（idleTimeoutMs）"
          committed={config.idleTimeoutMs !== undefined ? String(config.idleTimeoutMs) : ''}
          onSave={(text) => commit(setIdleTimeoutMs(config, idleTimeout.parse(text)))}
          problem={idleTimeout.problem}
        >
          {(value, set) => <Input inputMode="numeric" fieldSize="sm" placeholder="留空表示使用默认值" value={value} onChange={(e) => set(e.target.value)} />}
        </DraftRow>
        <DraftRow
          label="信号窗口大小（signalWindowSize）"
          committed={config.signalWindowSize !== undefined ? String(config.signalWindowSize) : ''}
          onSave={(text) => commit(setSignalWindowSize(config, signalWindow.parse(text)))}
          problem={signalWindow.problem}
        >
          {(value, set) => <Input inputMode="numeric" fieldSize="sm" placeholder="留空表示使用默认值" value={value} onChange={(e) => set(e.target.value)} />}
        </DraftRow>
      </SettingsSection>

      <SettingsSection title="日志滚动" restart>
        <DraftRow committed={loggingCommitted} onSave={saveLogging} problem={(form) => logSize.problem(form.maxFileSizeBytes) ?? logFiles.problem(form.maxFiles)}>
          {(form, set) => (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField label="单文件最大字节（maxFileSizeBytes）">
                {(id) => (
                  <Input
                    id={id}
                    inputMode="numeric"
                    fieldSize="sm"
                    placeholder="默认 10MiB"
                    value={form.maxFileSizeBytes}
                    onChange={(e) => set({ ...form, maxFileSizeBytes: e.target.value })}
                  />
                )}
              </FormField>
              <FormField label="保留文件数（maxFiles）">
                {(id) => (
                  <Input
                    id={id}
                    inputMode="numeric"
                    fieldSize="sm"
                    placeholder="默认 3"
                    value={form.maxFiles}
                    onChange={(e) => set({ ...form, maxFiles: e.target.value })}
                  />
                )}
              </FormField>
            </div>
          )}
        </DraftRow>
      </SettingsSection>
    </>
  );
}
