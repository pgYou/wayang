import { useState } from 'react';
import { LoaderIcon } from 'lucide-react';
import type { WayangConfig } from '@wayang-ai/protocol';
import {
  removeModel,
  removeProvider,
  setControllerModel,
  setWorkerModel,
  upsertModel,
  upsertProvider,
} from '@/renderer/shared/lib/config-draft';
import { Button } from '@/renderer/shared/components/ui/button';
import { Input } from '@/renderer/shared/components/ui/input';
import { Label } from '@/renderer/shared/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/shared/components/ui/select';
import { useAutoSaveAction } from './draft-section';
import { SettingsRow, SettingsSection } from './settings-section';
import type { ConfigCommitState } from '../use-config-commit';

type CommitFn = ConfigCommitState['commit'];

/**
 * 模型分组：Providers / Models / 绑定——三者共享同一份 config，增删改
 * 都是「结构化操作」而非单字段，直接整份回传给 commit（热更：8 个细粒度
 * update 覆盖这些操作，见 config-update-plan）。
 */
export function ModelsGroup({ config, commit }: { config: WayangConfig; commit: CommitFn }) {
  return (
    <>
      <BindingsSection config={config} commit={commit} />
      <ProvidersSection config={config} commit={commit} />
      <ModelsSection config={config} commit={commit} />
    </>
  );
}

function ProvidersSection({ config, commit }: { config: WayangConfig; commit: CommitFn }) {
  const rows = Object.entries(config.providers ?? {});
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ key: '', baseURL: '', apiKey: '' });
  const action = useAutoSaveAction();

  const startEdit = (key: string): void => {
    const p = config.providers[key];
    setEditing(key);
    setForm({ key, baseURL: p?.baseURL ?? '', apiKey: p?.apiKey ?? '' });
  };

  const save = (): void => {
    action.run(async () => {
      await commit(
        upsertProvider(config, form.key.trim(), { type: 'openai-compatible', baseURL: form.baseURL.trim(), apiKey: form.apiKey.trim() }),
      );
      setEditing(null);
    });
  };

  return (
    <SettingsSection title="Providers">
      {rows.map(([key, p]) => (
        <SettingsRow key={key} className="flex-row items-center gap-3 py-3 text-sm">
          <span className="font-mono font-medium">{key}</span>
          <span className="truncate text-xs text-muted-foreground">{p.baseURL ?? p.endpoint}</span>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => startEdit(key)}>
            编辑
          </Button>
          <Button size="sm" variant="ghost" disabled={action.pending} onClick={() => action.run(() => commit(removeProvider(config, key)))}>
            删除
          </Button>
        </SettingsRow>
      ))}
      <SettingsRow>
        {editing !== null ? (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="flex flex-col gap-1">
                <Label>名称</Label>
                <Input value={form.key} disabled={editing !== '__new__'} onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))} />
              </div>
              <div className="flex flex-col gap-1">
                <Label>Base URL</Label>
                <Input value={form.baseURL} onChange={(e) => setForm((f) => ({ ...f, baseURL: e.target.value }))} />
              </div>
              <div className="flex flex-col gap-1">
                <Label>API Key</Label>
                <Input type="password" value={form.apiKey} onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))} />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={save} disabled={!form.key.trim() || !form.baseURL.trim() || !form.apiKey.trim() || action.pending}>
                {action.pending && <LoaderIcon className="animate-spin" />}
                保存
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)} disabled={action.pending}>
                取消
              </Button>
            </div>
          </>
        ) : (
          <Button size="sm" variant="outline" className="self-start" onClick={() => { setEditing('__new__'); setForm({ key: '', baseURL: '', apiKey: '' }); }}>
            新增 provider
          </Button>
        )}
        {action.error && <p className="text-xs text-destructive">{action.error}</p>}
      </SettingsRow>
    </SettingsSection>
  );
}

function ModelsSection({ config, commit }: { config: WayangConfig; commit: CommitFn }) {
  const rows = Object.entries(config.models ?? {});
  const providerKeys = Object.keys(config.providers ?? {});
  const [form, setForm] = useState<{ key: string; provider: string; name: string; window: string } | null>(null);
  const action = useAutoSaveAction();

  const save = (): void => {
    if (!form) return;
    action.run(async () => {
      const windowTokens = Number(form.window);
      await commit(
        upsertModel(config, form.key.trim(), {
          provider: form.provider,
          name: form.name.trim(),
          contextWindowTokens: Number.isInteger(windowTokens) && windowTokens > 0 ? windowTokens : undefined,
        }),
      );
      setForm(null);
    });
  };

  return (
    <SettingsSection title="Models">
      {rows.map(([key, m]) => (
        <SettingsRow key={key} className="flex-row items-center gap-3 py-3 text-sm">
          <span className="font-mono font-medium">{key}</span>
          <span className="truncate text-xs text-muted-foreground">
            {m.provider} / {m.name}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => setForm({ key, provider: m.provider, name: m.name, window: String(m.contextWindowTokens ?? '') })}
          >
            编辑
          </Button>
          <Button size="sm" variant="ghost" disabled={action.pending} onClick={() => action.run(() => commit(removeModel(config, key)))}>
            删除
          </Button>
        </SettingsRow>
      ))}
      <SettingsRow>
        {form !== null ? (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <div className="flex flex-col gap-1">
                <Label>条目名</Label>
                <Input value={form.key} onChange={(e) => setForm((f) => (f ? { ...f, key: e.target.value } : f))} />
              </div>
              <div className="flex flex-col gap-1">
                <Label>Provider</Label>
                <Select value={form.provider} onValueChange={(v) => setForm((f) => (f ? { ...f, provider: v } : f))}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择 provider" />
                  </SelectTrigger>
                  <SelectContent>
                    {providerKeys.map((p) => (
                      <SelectItem key={p} value={p}>
                        {p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <Label>模型名</Label>
                <Input value={form.name} onChange={(e) => setForm((f) => (f ? { ...f, name: e.target.value } : f))} />
              </div>
              <div className="flex flex-col gap-1">
                <Label>窗口 tokens</Label>
                <Input inputMode="numeric" value={form.window} onChange={(e) => setForm((f) => (f ? { ...f, window: e.target.value } : f))} />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={save} disabled={!form.key.trim() || !form.name.trim() || !form.provider || action.pending}>
                {action.pending && <LoaderIcon className="animate-spin" />}
                保存
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setForm(null)} disabled={action.pending}>
                取消
              </Button>
            </div>
          </>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            onClick={() => setForm({ key: '', provider: providerKeys[0] ?? '', name: '', window: '128000' })}
          >
            新增模型
          </Button>
        )}
        {action.error && <p className="text-xs text-destructive">{action.error}</p>}
      </SettingsRow>
    </SettingsSection>
  );
}

function BindingsSection({ config, commit }: { config: WayangConfig; commit: CommitFn }) {
  const modelKeys = Object.keys(config.models ?? {});
  const action = useAutoSaveAction();
  return (
    <SettingsSection title="模型绑定">
      <SettingsRow className="gap-4 sm:flex-row">
        <div className="flex flex-1 flex-col gap-1">
          <Label>Controller 模型</Label>
          <Select
            value={typeof config.controller?.model === 'string' ? config.controller.model : ''}
            onValueChange={(v) => action.run(() => commit(setControllerModel(config, v || undefined)))}
          >
            <SelectTrigger>
              <SelectValue placeholder="选择模型" />
            </SelectTrigger>
            <SelectContent>
              {modelKeys.map((k) => (
                <SelectItem key={k} value={k}>
                  {k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <Label>Worker 模型</Label>
          <Select
            value={typeof config.worker?.model === 'string' ? config.worker.model : ''}
            onValueChange={(v) => action.run(() => commit(setWorkerModel(config, v || undefined)))}
          >
            <SelectTrigger>
              <SelectValue placeholder="选择模型" />
            </SelectTrigger>
            <SelectContent>
              {modelKeys.map((k) => (
                <SelectItem key={k} value={k}>
                  {k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </SettingsRow>
      {action.error && <p className="px-4 pb-3 text-xs text-destructive">{action.error}</p>}
    </SettingsSection>
  );
}
