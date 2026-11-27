import { useState } from 'react';
import { ChevronRightIcon, LoaderIcon } from 'lucide-react';
import type { ModelConfig, ProviderConfig, WayangConfig } from '@wayang-ai/protocol';
import { removeModel, removeProvider, upsertModel, upsertProvider } from '@/renderer/shared/lib/config-draft';
import { Button } from '@/renderer/shared/components/ui/button';
import { Card } from '@/renderer/shared/components/ui/card';
import { Collapse } from '@/renderer/shared/components/ui/collapse';
import { Input } from '@/renderer/shared/components/ui/input';
import { Label } from '@/renderer/shared/components/ui/label';
import { cn } from '@/renderer/shared/lib/cn';
import { useAutoSaveAction } from './draft-section';
import type { ConfigCommitState } from '../use-config-commit';

type CommitFn = ConfigCommitState['commit'];

interface ModelForm {
  originalKey: string | null;
  key: string;
  name: string;
  window: string;
}

interface ProviderForm {
  baseURL: string;
  apiKey: string;
}

/**
 * 一个 provider 一张卡片：头部可折叠（折叠时不渲染模型列表的高度，只保留
 * 概要行），展开后在卡内直接增删改其下的模型。
 */
export function ProviderCard({
  config,
  commit,
  providerKey,
  provider,
  open,
  onToggle,
}: {
  config: WayangConfig;
  commit: CommitFn;
  providerKey: string;
  provider: ProviderConfig;
  open: boolean;
  onToggle: () => void;
}) {
  const models = Object.entries(config.models ?? {}).filter(([, m]) => m.provider === providerKey);
  const [editing, setEditing] = useState<ProviderForm | null>(null);
  const [modelForm, setModelForm] = useState<ModelForm | null>(null);
  const action = useAutoSaveAction();

  const saveProvider = (): void => {
    if (!editing) return;
    action.run(async () => {
      await commit(upsertProvider(config, providerKey, { ...provider, baseURL: editing.baseURL.trim(), apiKey: editing.apiKey.trim() }));
      setEditing(null);
    });
  };

  const saveModel = (): void => {
    if (!modelForm) return;
    action.run(async () => {
      const windowTokens = Number(modelForm.window);
      const def: ModelConfig = {
        provider: providerKey,
        name: modelForm.name.trim(),
        contextWindowTokens: Number.isInteger(windowTokens) && windowTokens > 0 ? windowTokens : undefined,
      };
      const renamed = modelForm.originalKey !== null && modelForm.originalKey !== modelForm.key.trim();
      const next = renamed ? removeModel(config, modelForm.originalKey as string) : config;
      await commit(upsertModel(next, modelForm.key.trim(), def));
      setModelForm(null);
    });
  };

  return (
    <Card className="gap-0 border-transparent py-0 shadow-card">
      <div className="flex items-center gap-2 px-4 py-3">
        <button type="button" onClick={onToggle} aria-expanded={open} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left">
          <ChevronRightIcon className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
          <span className="font-mono text-sm font-medium">{providerKey}</span>
          <span className="truncate text-xs text-muted-foreground">{provider.baseURL ?? provider.endpoint}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{models.length} 个模型</span>
        </button>
        {editing === null && (
          <>
            <Button size="sm" variant="ghost" onClick={() => setEditing({ baseURL: provider.baseURL ?? '', apiKey: provider.apiKey })}>
              编辑
            </Button>
            <Button size="sm" variant="ghost" disabled={action.pending} onClick={() => action.run(() => commit(removeProvider(config, providerKey)))}>
              删除
            </Button>
          </>
        )}
      </div>
      <Collapse open={open}>
        <div className="divide-y divide-border border-t border-border">
          {editing !== null && (
            <div className="flex flex-col gap-3 px-4 py-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <Label>Base URL</Label>
                  <Input value={editing.baseURL} onChange={(e) => setEditing((prev) => (prev ? { ...prev, baseURL: e.target.value } : prev))} />
                </div>
                <div className="flex flex-col gap-1">
                  <Label>API Key</Label>
                  <Input type="password" value={editing.apiKey} onChange={(e) => setEditing((prev) => (prev ? { ...prev, apiKey: e.target.value } : prev))} />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={saveProvider} disabled={!editing.baseURL.trim() || !editing.apiKey.trim() || action.pending}>
                  {action.pending && <LoaderIcon className="animate-spin" />}
                  保存
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(null)} disabled={action.pending}>
                  取消
                </Button>
              </div>
              {action.error && <p className="text-xs text-destructive">{action.error}</p>}
            </div>
          )}

          {models.map(([key, m]) => (
            <div key={key} className="flex items-center gap-3 px-4 py-2">
              <span className="font-mono text-sm font-medium">{key}</span>
              <span className="truncate text-xs text-muted-foreground">{m.name}</span>
              {m.contextWindowTokens !== undefined && <span className="shrink-0 text-xs text-muted-foreground">{m.contextWindowTokens} tokens</span>}
              <div className="ml-auto flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setModelForm({ originalKey: key, key, name: m.name, window: String(m.contextWindowTokens ?? '') })}
                >
                  编辑
                </Button>
                <Button size="sm" variant="ghost" disabled={action.pending} onClick={() => action.run(() => commit(removeModel(config, key)))}>
                  删除
                </Button>
              </div>
            </div>
          ))}

          {modelForm !== null ? (
            <div className="flex flex-col gap-3 px-4 py-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="flex flex-col gap-1">
                  <Label>条目名</Label>
                  <Input value={modelForm.key} onChange={(e) => setModelForm((prev) => (prev ? { ...prev, key: e.target.value } : prev))} />
                </div>
                <div className="flex flex-col gap-1">
                  <Label>模型名</Label>
                  <Input value={modelForm.name} onChange={(e) => setModelForm((prev) => (prev ? { ...prev, name: e.target.value } : prev))} />
                </div>
                <div className="flex flex-col gap-1">
                  <Label>窗口 tokens</Label>
                  <Input
                    fieldSize="sm"
                    inputMode="numeric"
                    value={modelForm.window}
                    onChange={(e) => setModelForm((prev) => (prev ? { ...prev, window: e.target.value } : prev))}
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={saveModel} disabled={!modelForm.key.trim() || !modelForm.name.trim() || action.pending}>
                  {action.pending && <LoaderIcon className="animate-spin" />}
                  保存
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setModelForm(null)} disabled={action.pending}>
                  取消
                </Button>
              </div>
              {action.error && <p className="text-xs text-destructive">{action.error}</p>}
            </div>
          ) : (
            <div className="px-4 py-2">
              <Button size="sm" variant="secondary" onClick={() => setModelForm({ originalKey: null, key: '', name: '', window: '128000' })}>
                新增模型
              </Button>
            </div>
          )}
        </div>
      </Collapse>
    </Card>
  );
}
