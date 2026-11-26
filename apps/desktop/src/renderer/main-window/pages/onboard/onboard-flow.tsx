import { useState } from 'react';
import { UploadIcon } from 'lucide-react';
import type { WayangConfig } from '@wayang-ai/protocol';
import { checkCoreCompleteness } from '@/shared/onboard';
import { wayang } from '@/renderer/shared/lib/wayang-api';
import { emptyDraft, setMaxConcurrency, upsertModel, upsertProvider, setControllerModel, setWorkerModel } from '@/renderer/shared/lib/config-draft';
import { Badge } from '@/renderer/shared/components/ui/badge';
import { Button } from '@/renderer/shared/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/renderer/shared/components/ui/card';
import { Input } from '@/renderer/shared/components/ui/input';
import { Label } from '@/renderer/shared/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/shared/components/ui/select';
import { ConfigSummary } from '@/renderer/shared/components/shared/config-summary';
import { WIZARD_STEPS, buildFallbackConfig, canSkip, stepProblem, wizardComplete, type WizardStepId } from './wizard-state';

/**
 * 首启配置流：欢迎页（两入口）→ 向导 / CLI 导入
 * → 最终确认页（全量展示 + 核心完整性校验）→ 确认写入 userData 信封 → 主界面。
 */

type FlowPhase = 'welcome' | 'wizard' | 'confirm';

interface OnboardFlowProps {
  /** The cold-start problem text (why the welcome page is showing). */
  problem?: string;
  /** Called after the envelope is saved and the server boot has started. */
  onFinished: () => void;
}

export function OnboardFlow({ problem, onFinished }: OnboardFlowProps) {
  const [phase, setPhase] = useState<FlowPhase>('welcome');
  const [draft, setDraft] = useState<WayangConfig>(emptyDraft());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const saveAndEnter = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await wayang.saveConfig(draft);
      onFinished();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-background p-8">
      <div className="flex w-full max-w-xl flex-col gap-4">
        {phase === 'welcome' && (
          <WelcomePage
            problem={problem}
            error={error}
            onStart={() => {
              setError(null);
              setPhase('wizard');
            }}
            onImport={async () => {
              setError(null);
              try {
                const { config } = await wayang.importCliConfig();
                setDraft(config);
                setPhase('confirm');
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
          />
        )}
        {phase === 'wizard' && (
          <OnboardWizard
            draft={draft}
            onChange={setDraft}
            onComplete={() => setPhase('confirm')}
            onCancel={() => setPhase('welcome')}
          />
        )}
        {phase === 'confirm' && (
          <FinalConfirm
            draft={draft}
            saving={saving}
            error={error}
            onBack={() => setPhase('wizard')}
            onConfirm={() => void saveAndEnter()}
          />
        )}
      </div>
    </div>
  );
}

/* ------------------------------ welcome ------------------------------ */

function WelcomePage({
  problem,
  error,
  onStart,
  onImport,
}: {
  problem?: string;
  error: string | null;
  onStart: () => void;
  onImport: () => void;
}) {
  return (
    <Card className="gap-4">
      <CardHeader>
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-lg font-bold text-primary-foreground">W</div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div>
          <CardTitle className="text-xl">欢迎使用 Wayang</CardTitle>
          <CardDescription className="mt-2">
            {problem ?? '尚未配置'}——完成两步必要配置（Provider 与模型绑定）即可开始。
          </CardDescription>
        </div>
        <div className="flex flex-col gap-2">
          <Button size="lg" onClick={onStart}>
            开始配置
          </Button>
          <Button size="lg" variant="outline" onClick={() => void onImport()}>
            <UploadIcon />
            导入 CLI 配置（~/.wayang.config.json，只读）
          </Button>
        </div>
        {error && <p className="rounded-md border border-destructive/30 bg-destructive-soft px-3 py-2 text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

/* ------------------------------ wizard ------------------------------ */

interface WizardProps {
  draft: WayangConfig;
  onChange: (next: WayangConfig) => void;
  onComplete: () => void;
  onCancel: () => void;
}

function OnboardWizard({ draft, onChange, onComplete, onCancel }: WizardProps) {
  const [step, setStep] = useState<WizardStepId>('provider');
  const index = WIZARD_STEPS.findIndex((s) => s.id === step);
  const problem = stepProblem(draft, step);
  const coreComplete = wizardComplete(draft);

  const next = (): void => {
    if (index < WIZARD_STEPS.length - 1) setStep(WIZARD_STEPS[index + 1].id);
    else onComplete();
  };
  const back = (): void => {
    if (index > 0) setStep(WIZARD_STEPS[index - 1].id);
    else onCancel();
  };

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>初始配置向导</CardTitle>
        <div className="flex items-center gap-2">
          {WIZARD_STEPS.map((s, i) => (
            <Badge key={s.id} variant={i < index ? 'success' : i === index ? 'default' : 'outline'}>
              {i + 1}. {s.title}
            </Badge>
          ))}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {step === 'provider' && <ProviderStep draft={draft} onChange={onChange} />}
        {step === 'binding' && <BindingStep draft={draft} onChange={onChange} />}
        {step === 'concurrency' && <ConcurrencyStep draft={draft} onChange={onChange} />}

        {problem && <p className="text-sm text-destructive">{problem}</p>}
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={back}>
            {index > 0 ? '上一步' : '返回欢迎页'}
          </Button>
          <div className="ml-auto flex items-center gap-2">
            {canSkip(draft, step) && (
              <Button variant="outline" onClick={next}>
                跳过此步
              </Button>
            )}
            {coreComplete ? (
              <Button onClick={onComplete}>完成，去确认</Button>
            ) : (
              <Button onClick={next} disabled={problem !== null}>
                {index < WIZARD_STEPS.length - 1 ? '下一步' : '完成，去确认'}
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------ steps ------------------------------ */

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ProviderStep({ draft, onChange }: { draft: WayangConfig; onChange: (c: WayangConfig) => void }) {
  const existing = Object.keys(draft.providers ?? {});
  const [key, setKey] = useState(existing[0] ?? 'default');
  const [baseURL, setBaseURL] = useState(existing[0] ? (draft.providers[existing[0]].baseURL ?? '') : '');
  const [apiKey, setApiKey] = useState(existing[0] ? (draft.providers[existing[0]].apiKey ?? '') : '');

  const apply = (): void => {
    onChange(
      upsertProvider(draft, key.trim() || 'default', {
        type: 'openai-compatible',
        baseURL: baseURL.trim(),
        apiKey: apiKey.trim(),
      }),
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Button
          variant="secondary"
          onClick={() =>
            onChange(
              buildFallbackConfig({
                providerKey: key.trim() || 'default',
                baseURL: baseURL.trim() || 'https://api.example.com/v1',
                apiKey: apiKey.trim() || 'sk-...',
                modelKey: 'main',
                modelName: 'gpt-x',
              }),
            )
          }
        >
          创建默认 provider + model（兜底，一步完成必做步骤）
        </Button>
        <p className="text-xs text-muted-foreground">填好下方字段后点击，将生成可运行的默认配置；随后可继续微调。</p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Provider 名称">
          <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="default" />
        </Field>
        <Field label="Base URL">
          <Input value={baseURL} onChange={(e) => setBaseURL(e.target.value)} placeholder="https://api.example.com/v1" />
        </Field>
        <Field label="API Key">
          <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" />
        </Field>
      </div>
      <Button onClick={apply} disabled={!key.trim() || !baseURL.trim() || !apiKey.trim()}>
        保存 provider
      </Button>
      {existing.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {existing.map((name) => (
            <Badge key={name} variant="outline">
              {name}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

function BindingStep({ draft, onChange }: { draft: WayangConfig; onChange: (c: WayangConfig) => void }) {
  const modelKeys = Object.keys(draft.models ?? {});
  const providerKeys = Object.keys(draft.providers ?? {});
  const [modelKey, setModelKey] = useState('main');
  const [modelName, setModelName] = useState('');
  const [windowTokens, setWindowTokens] = useState('128000');

  return (
    <div className="flex flex-col gap-4">
      {modelKeys.length === 0 && (
        <div className="flex flex-col gap-4 rounded-lg border border-border bg-muted p-4">
          <p className="text-sm font-medium">还没有模型条目 — 先创建一个：</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="模型条目名">
              <Input value={modelKey} onChange={(e) => setModelKey(e.target.value)} placeholder="main" />
            </Field>
            <Field label="模型名（发给 provider）">
              <Input value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder="gpt-x" />
            </Field>
            <Field label="Provider">
              <Select value={providerKeys[0]} onValueChange={(v) => onChange(upsertModel(draft, modelKey, { provider: v, name: modelName || 'gpt-x' }))}>
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
            </Field>
          </div>
          <div className="flex items-center gap-2">
            <Field label="上下文窗口（tokens）">
              <Input inputMode="numeric" value={windowTokens} onChange={(e) => setWindowTokens(e.target.value)} />
            </Field>
            <Button
              className="mt-6"
              onClick={() => {
                const provider = providerKeys[0] ?? 'default';
                onChange(upsertModel(draft, modelKey.trim() || 'main', { provider, name: modelName.trim() || 'gpt-x', contextWindowTokens: Number(windowTokens) || undefined }));
              }}
              disabled={providerKeys.length === 0}
            >
              创建模型条目
            </Button>
          </div>
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Controller 模型">
          <ModelRefSelect
            value={typeof draft.controller?.model === 'string' ? draft.controller.model : undefined}
            modelKeys={modelKeys}
            providerKeys={providerKeys}
            onChange={(v) => onChange(setControllerModel(draft, v))}
          />
        </Field>
        <Field label="Worker 模型">
          <ModelRefSelect
            value={typeof draft.worker?.model === 'string' ? draft.worker.model : undefined}
            modelKeys={modelKeys}
            providerKeys={providerKeys}
            onChange={(v) => onChange(setWorkerModel(draft, v))}
          />
        </Field>
      </div>
    </div>
  );
}

function ModelRefSelect({
  value,
  modelKeys,
  providerKeys,
  onChange,
}: {
  value: string | undefined;
  modelKeys: string[];
  providerKeys: string[];
  onChange: (value: string | undefined) => void;
}) {
  return (
    <Select value={value ?? ''} onValueChange={(v) => onChange(v || undefined)}>
      <SelectTrigger>
        <SelectValue placeholder="选择模型" />
      </SelectTrigger>
      <SelectContent>
        {modelKeys.map((k) => (
          <SelectItem key={`m:${k}`} value={k}>
            {k}（models 条目）
          </SelectItem>
        ))}
        {providerKeys.map((p) => (
          <SelectItem key={`c:${p}`} value={`${p}/`}>
            {p}/…（组合引用）
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ConcurrencyStep({ draft, onChange }: { draft: WayangConfig; onChange: (c: WayangConfig) => void }) {
  const value = draft.worker?.maxConcurrency ?? 3;
  return (
    <Field label="Worker 最大并发（maxConcurrency）" hint="可跳过 — 默认 3，后续可在设置页修改并热更生效。">
      <Input
        inputMode="numeric"
        value={String(value)}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isInteger(n) && n > 0) onChange(setMaxConcurrency(draft, n));
        }}
      />
    </Field>
  );
}

/* --------------------------- final confirm --------------------------- */

function FinalConfirm({
  draft,
  saving,
  error,
  onBack,
  onConfirm,
}: {
  draft: WayangConfig;
  saving: boolean;
  error: string | null;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const coreProblem = checkCoreCompleteness(draft);
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>确认配置</CardTitle>
        <CardDescription>确认后将写入应用配置（userData/config.json）并以新配置启动 server。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ConfigSummary config={draft} />
        {coreProblem && <p className="rounded-md border border-destructive/30 bg-destructive-soft px-3 py-2 text-sm text-destructive">{coreProblem}</p>}
        {error && <p className="rounded-md border border-destructive/30 bg-destructive-soft px-3 py-2 text-sm text-destructive">{error}</p>}
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onBack}>
            返回修改
          </Button>
          <Button className="ml-auto" onClick={onConfirm} disabled={coreProblem !== null || saving}>
            {saving ? '写入并启动中…' : '确认写入并进入主界面'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** 全量展示已拆至 components/shared/config-summary（onboard 与设置页共用）。 */
