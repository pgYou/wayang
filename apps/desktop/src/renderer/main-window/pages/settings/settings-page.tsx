import { useEffect, useState } from 'react';
import { FolderOpenIcon, LoaderIcon, RotateCcwIcon, SaveIcon } from 'lucide-react';
import type { WayangConfig } from '@wayang-ai/protocol';
import { wayang } from '@/renderer/shared/lib/wayang-api';
import {
  parseDirList,
  removeModel,
  removeProvider,
  setAllowedDirs,
  setControllerModel,
  setMaxConcurrency,
  setWorkerModel,
  setWorkspacePref,
  upsertModel,
  upsertProvider,
} from '@/renderer/shared/lib/config-draft';
import { Badge } from '@/renderer/shared/components/ui/badge';
import { Button } from '@/renderer/shared/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/renderer/shared/components/ui/card';
import { Input } from '@/renderer/shared/components/ui/input';
import { Label } from '@/renderer/shared/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/shared/components/ui/select';
import { Skeleton } from '@/renderer/shared/components/ui/skeleton';
import { Textarea } from '@/renderer/shared/components/ui/textarea';
import { ConfigSummary } from '@/renderer/shared/components/shared/config-summary';

/**
 * 设置页— 最终确认页的同源同校验常驻形态：读取/编辑/保存
 * 信封；运行中可热更的字段经 8 个细粒度 update 方法走热更（保存返回
 * applied 列表），白名单外字段（workers/permission/logging/工作区等）写
 * 信封并提示重启（restartServer 生效）。
 */

interface SettingsPageProps {
  onClose: () => void;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; config: WayangConfig; desktop: Record<string, unknown> };

export function SettingsPage({ onClose }: SettingsPageProps) {
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [draft, setDraft] = useState<WayangConfig | null>(null);
  const [desktop, setDesktop] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ applied: string[]; restartRequired: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void wayang
      .readConfig()
      .then(({ config, desktop }) => {
        setLoad({ kind: 'ready', config, desktop });
        setDraft(config);
        setDesktop(desktop);
      })
      .catch((err: unknown) => setLoad({ kind: 'error', message: err instanceof Error ? err.message : String(err) }));
  }, []);

  const save = async (): Promise<void> => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    setSaveResult(null);
    try {
      const result = await wayang.saveConfig(draft, desktop);
      setSaveResult({ applied: result.applied, restartRequired: result.restartRequired });
      setLoad({ kind: 'ready', config: draft, desktop });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const restart = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await wayang.restartServer();
      setSaveResult(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const pickWorkspace = async (): Promise<void> => {
    try {
      const { path } = await wayang.chooseDirectory();
      if (path) setDesktop((prev) => setWorkspacePref(prev, path));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex items-center gap-2 border-b border-border bg-card/80 px-4 py-2">
        <span className="text-sm font-semibold">设置</span>
        <span className="text-xs text-muted-foreground">修改保存后：可热更字段即时生效，其余字段重启 server 后生效</span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onClose}>
          关闭
        </Button>
      </header>
      <div className="flex-1 overflow-y-auto p-4">
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          {load.kind === 'loading' && (
            <div className="flex flex-col gap-4">
              <Skeleton className="h-8 w-40" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          )}
          {load.kind === 'error' && (
            <Card className="gap-2">
              <CardContent className="flex flex-col gap-2 pt-6">
                <p className="text-sm text-destructive">{load.message}</p>
                <Button variant="outline" size="sm" onClick={() => setLoad({ kind: 'loading' })}>
                  重试读取
                </Button>
              </CardContent>
            </Card>
          )}
          {load.kind === 'ready' && draft && (
            <>
              <ProvidersSection draft={draft} onChange={setDraft} />
              <ModelsSection draft={draft} onChange={setDraft} />
              <BindingsSection draft={draft} onChange={setDraft} />
              <ConcurrencySection draft={draft} onChange={setDraft} />
              <WorkspaceSection desktop={desktop} workspace={typeof desktop.defaultWorkerWorkspace === 'string' ? desktop.defaultWorkerWorkspace : null} onPick={() => void pickWorkspace()} />
              <PermissionSection draft={draft} onChange={setDraft} />
              <Card className="gap-2">
                <CardHeader>
                  <CardTitle className="text-sm">配置预览</CardTitle>
                  <CardDescription>保存前的全量校验视图（与首启最终确认页同源）。</CardDescription>
                </CardHeader>
                <CardContent>
                  <ConfigSummary config={draft} />
                </CardContent>
              </Card>

              {saveResult && (
                <div className="flex flex-col gap-2 rounded-lg border border-primary-border bg-primary-soft/50 px-4 py-3 text-sm">
                  {saveResult.applied.length > 0 && (
                    <p>
                      <span className="font-medium text-primary-strong">已热更生效：</span>
                      {saveResult.applied.join('、')}
                    </p>
                  )}
                  {saveResult.restartRequired.length > 0 && (
                    <>
                      <p className="font-medium">以下修改已写入信封，重启 server 后生效：</p>
                      <ul className="list-disc pl-4 text-xs text-muted-foreground">
                        {saveResult.restartRequired.map((note) => (
                          <li key={note}>{note}</li>
                        ))}
                      </ul>
                      <Button size="sm" variant="outline" onClick={() => void restart()} disabled={saving}>
                        <RotateCcwIcon />
                        重启 server 以生效
                      </Button>
                    </>
                  )}
                </div>
              )}
              {error && <p className="rounded-md border border-destructive/30 bg-destructive-soft px-3 py-2 text-sm text-destructive">{error}</p>}
              <div className="flex items-center gap-2 pb-6">
                <Button onClick={() => void save()} disabled={saving}>
                  {saving ? <LoaderIcon className="animate-spin" /> : <SaveIcon />}
                  {saving ? '保存中…' : '保存'}
                </Button>
                <Button variant="ghost" onClick={onClose}>
                  取消
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ sections ------------------------------ */

function ProvidersSection({ draft, onChange }: { draft: WayangConfig; onChange: (c: WayangConfig) => void }) {
  const rows = Object.entries(draft.providers ?? {});
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ key: '', baseURL: '', apiKey: '' });

  const startEdit = (key: string): void => {
    const p = draft.providers[key];
    setEditing(key);
    setForm({ key, baseURL: p?.baseURL ?? '', apiKey: p?.apiKey ?? '' });
  };

  return (
    <Card className="gap-2">
      <CardHeader>
        <CardTitle className="text-sm">Providers</CardTitle>
        <CardDescription>增删改查（热更：add/update/remove provider）。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {rows.map(([key, p]) => (
          <div key={key} className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs">
            <span className="font-mono font-medium">{key}</span>
            <span className="truncate text-muted-foreground">{p.baseURL ?? p.endpoint}</span>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => startEdit(key)}>
              编辑
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onChange(removeProvider(draft, key))}>
              删除
            </Button>
          </div>
        ))}
        {editing !== null ? (
          <div className="flex flex-col gap-2 rounded-md border border-primary-border bg-primary-soft/40 p-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
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
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => {
                  onChange(upsertProvider(draft, form.key.trim(), { type: 'openai-compatible', baseURL: form.baseURL.trim(), apiKey: form.apiKey.trim() }));
                  setEditing(null);
                }}
                disabled={!form.key.trim() || !form.baseURL.trim() || !form.apiKey.trim()}
              >
                保存
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                取消
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="outline" onClick={() => { setEditing('__new__'); setForm({ key: '', baseURL: '', apiKey: '' }); }}>
            新增 provider
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function ModelsSection({ draft, onChange }: { draft: WayangConfig; onChange: (c: WayangConfig) => void }) {
  const rows = Object.entries(draft.models ?? {});
  const providerKeys = Object.keys(draft.providers ?? {});
  const [form, setForm] = useState<{ key: string; provider: string; name: string; window: string } | null>(null);

  return (
    <Card className="gap-2">
      <CardHeader>
        <CardTitle className="text-sm">Models</CardTitle>
        <CardDescription>模型条目（热更：add/update/remove model；修改模型名需重启）。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {rows.map(([key, m]) => (
          <div key={key} className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs">
            <span className="font-mono font-medium">{key}</span>
            <span className="truncate text-muted-foreground">
              {m.provider} / {m.name}
            </span>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setForm({ key, provider: m.provider, name: m.name, window: String(m.contextWindowTokens ?? '') })}>
              编辑
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onChange(removeModel(draft, key))}>
              删除
            </Button>
          </div>
        ))}
        {form !== null ? (
          <div className="flex flex-col gap-2 rounded-md border border-primary-border bg-primary-soft/40 p-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
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
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => {
                  const windowTokens = Number(form.window);
                  onChange(
                    upsertModel(draft, form.key.trim(), {
                      provider: form.provider,
                      name: form.name.trim(),
                      contextWindowTokens: Number.isInteger(windowTokens) && windowTokens > 0 ? windowTokens : undefined,
                    }),
                  );
                  setForm(null);
                }}
                disabled={!form.key.trim() || !form.name.trim() || !form.provider}
              >
                保存
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setForm(null)}>
                取消
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setForm({ key: '', provider: providerKeys[0] ?? '', name: '', window: '128000' })}>
            新增模型
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function BindingsSection({ draft, onChange }: { draft: WayangConfig; onChange: (c: WayangConfig) => void }) {
  const modelKeys = Object.keys(draft.models ?? {});
  return (
    <Card className="gap-2">
      <CardHeader>
        <CardTitle className="text-sm">模型绑定</CardTitle>
        <CardDescription>controller / worker 指向真实条目（热更：update controller model / worker settings）。</CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label>Controller 模型</Label>
          <Select
            value={typeof draft.controller?.model === 'string' ? draft.controller.model : ''}
            onValueChange={(v) => onChange(setControllerModel(draft, v || undefined))}
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
        <div className="flex flex-col gap-1">
          <Label>Worker 模型</Label>
          <Select
            value={typeof draft.worker?.model === 'string' ? draft.worker.model : ''}
            onValueChange={(v) => onChange(setWorkerModel(draft, v || undefined))}
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
      </CardContent>
    </Card>
  );
}

function ConcurrencySection({ draft, onChange }: { draft: WayangConfig; onChange: (c: WayangConfig) => void }) {
  return (
    <Card className="gap-2">
      <CardHeader>
        <CardTitle className="text-sm">并发</CardTitle>
        <CardDescription>worker 最大并发（热更：update worker settings，对后续 spawn 生效）。</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex max-w-40 flex-col gap-1">
          <Label>maxConcurrency</Label>
          <Input
            inputMode="numeric"
            value={String(draft.worker?.maxConcurrency ?? 3)}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n > 0) onChange(setMaxConcurrency(draft, n));
            }}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function WorkspaceSection({ desktop, workspace, onPick }: { desktop: Record<string, unknown>; workspace: string | null; onPick: () => void }) {
  return (
    <Card className="gap-2">
      <CardHeader>
        <CardTitle className="text-sm">默认工作区</CardTitle>
        <CardDescription>未显式指定项目目录时 worker 的默认工作区（重启后生效）。</CardDescription>
      </CardHeader>
      <CardContent className="flex items-center gap-2">
        <span className="flex-1 truncate rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
          {workspace ?? '默认（~/.agents/wayang-workspace）'}
        </span>
        <Badge variant={desktop.defaultWorkerWorkspace ? 'default' : 'outline'}>{desktop.defaultWorkerWorkspace ? '已自定义' : '默认'}</Badge>
        <Button size="sm" variant="outline" onClick={onPick}>
          <FolderOpenIcon />
          选择目录
        </Button>
      </CardContent>
    </Card>
  );
}

function PermissionSection({ draft, onChange }: { draft: WayangConfig; onChange: (c: WayangConfig) => void }) {
  const [text, setText] = useState((draft.permission?.allowedDirs ?? []).join('\n'));
  return (
    <Card className="gap-2">
      <CardHeader>
        <CardTitle className="text-sm">权限（allowedDirs）</CardTitle>
        <CardDescription>始终允许读写的目录，每行一个（重启后生效）。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <Textarea rows={3} value={text} placeholder={'/Users/me/projects\n/tmp/work'} onChange={(e) => setText(e.target.value)} />
        <Button size="sm" variant="outline" onClick={() => onChange(setAllowedDirs(draft, parseDirList(text)))}>
          应用到草稿
        </Button>
      </CardContent>
    </Card>
  );
}
