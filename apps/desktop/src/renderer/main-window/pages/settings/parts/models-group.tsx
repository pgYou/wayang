import { useState } from 'react';
import { LoaderIcon } from 'lucide-react';
import type { WayangConfig } from '@wayang-ai/protocol';
import { removeModel, setControllerModel, setWorkerModel, upsertProvider } from '@/renderer/shared/lib/config-draft';
import { Button } from '@/renderer/shared/components/ui/button';
import { Card } from '@/renderer/shared/components/ui/card';
import { Input } from '@/renderer/shared/components/ui/input';
import { Label } from '@/renderer/shared/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/shared/components/ui/select';
import { useAutoSaveAction } from './draft-section';
import { ProviderCard } from './provider-card';
import { SettingsRow, SettingsSection } from './settings-section';
import type { ConfigCommitState } from '../use-config-commit';

type CommitFn = ConfigCommitState['commit'];

interface ProviderForm {
  key: string;
  baseURL: string;
  apiKey: string;
}

/**
 * 模型分组：Provider → Model 两层树。每个 provider 一张可折叠卡片，其下
 * 的模型直接在该卡片内增删改；模型绑定是全局的两条引用，放在最下面。
 */
export function ModelsGroup({ config, commit }: { config: WayangConfig; commit: CommitFn }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [creating, setCreating] = useState<ProviderForm | null>(null);
  const providers = Object.entries(config.providers ?? {});
  const action = useAutoSaveAction();

  const providerKeys = new Set(Object.keys(config.providers ?? {}));
  const orphans = Object.entries(config.models ?? {}).filter(([, m]) => !providerKeys.has(m.provider));

  const saveProvider = (): void => {
    if (!creating) return;
    action.run(async () => {
      await commit(upsertProvider(config, creating.key.trim(), { type: 'openai-compatible', baseURL: creating.baseURL.trim(), apiKey: creating.apiKey.trim() }));
      setCreating(null);
    });
  };

  return (
    <>
      <section className="flex flex-col gap-2">
        <h3 className="px-1 text-sm font-medium">Providers</h3>
        {providers.map(([key, provider]) => (
          <ProviderCard
            key={key}
            config={config}
            commit={commit}
            providerKey={key}
            provider={provider}
            open={!collapsed[key]}
            onToggle={() => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))}
          />
        ))}
        {orphans.length > 0 && (
          <Card className="gap-0 divide-y divide-border border-transparent py-0 shadow-card">
            <div className="px-4 py-3 text-sm text-destructive">未归属 provider 的模型</div>
            {orphans.map(([key, model]) => (
              <div key={key} className="flex items-center gap-3 px-4 py-2 text-sm">
                <span className="font-mono font-medium">{key}</span>
                <span className="text-xs text-muted-foreground">
                  {model.provider} / {model.name}
                </span>
                <Button size="sm" variant="ghost" className="ml-auto" disabled={action.pending} onClick={() => action.run(() => commit(removeModel(config, key)))}>
                  删除
                </Button>
              </div>
            ))}
          </Card>
        )}
        {creating !== null ? (
          <Card className="gap-3 border-transparent p-4 shadow-card">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="flex flex-col gap-1">
                <Label>名称</Label>
                <Input value={creating.key} onChange={(e) => setCreating((prev) => (prev ? { ...prev, key: e.target.value } : prev))} />
              </div>
              <div className="flex flex-col gap-1">
                <Label>Base URL</Label>
                <Input value={creating.baseURL} onChange={(e) => setCreating((prev) => (prev ? { ...prev, baseURL: e.target.value } : prev))} />
              </div>
              <div className="flex flex-col gap-1">
                <Label>API Key</Label>
                <Input type="password" value={creating.apiKey} onChange={(e) => setCreating((prev) => (prev ? { ...prev, apiKey: e.target.value } : prev))} />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={saveProvider} disabled={!creating.key.trim() || !creating.baseURL.trim() || !creating.apiKey.trim() || action.pending}>
                {action.pending && <LoaderIcon className="animate-spin" />}
                保存
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCreating(null)} disabled={action.pending}>
                取消
              </Button>
            </div>
            {action.error && <p className="text-xs text-destructive">{action.error}</p>}
          </Card>
        ) : (
          <Button size="sm" variant="secondary" className="self-start" onClick={() => setCreating({ key: '', baseURL: '', apiKey: '' })}>
            新增 provider
          </Button>
        )}
      </section>
      <BindingsSection config={config} commit={commit} />
    </>
  );
}

function BindingsSection({ config, commit }: { config: WayangConfig; commit: CommitFn }) {
  const modelKeys = Object.keys(config.models ?? {});
  const action = useAutoSaveAction();
  return (
    <SettingsSection title="模型绑定">
      <SettingsRow>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Label>Controller 模型</Label>
            <Select
              value={typeof config.controller?.model === 'string' ? config.controller.model : ''}
              onValueChange={(v) => action.run(() => commit(setControllerModel(config, v || undefined)))}
            >
              <SelectTrigger fieldSize="md">
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
          <div className="flex flex-col gap-1">
            <Label>Worker 模型</Label>
            <Select
              value={typeof config.worker?.model === 'string' ? config.worker.model : ''}
              onValueChange={(v) => action.run(() => commit(setWorkerModel(config, v || undefined)))}
            >
              <SelectTrigger fieldSize="md">
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
        </div>
        {action.error && <p className="text-xs text-destructive">{action.error}</p>}
      </SettingsRow>
    </SettingsSection>
  );
}
