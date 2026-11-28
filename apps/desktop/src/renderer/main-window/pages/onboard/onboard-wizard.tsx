import { useState } from 'react';
import type { WayangConfig } from '@wayang-ai/protocol';
import { Badge } from '@/renderer/shared/components/ui/badge';
import { Button } from '@/renderer/shared/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/renderer/shared/components/ui/card';
import { ConfigSummary } from './config-summary';
import { WIZARD_STEPS, draftProblem, stepIndex, stepProblem, type WizardStepId } from './wizard-state';
import { BindingStep, ModelStep, ProviderStep } from './wizard-steps';
import { WorkerStep } from './wizard-worker-step';

interface OnboardWizardProps {
  draft: WayangConfig;
  onChange: (next: WayangConfig) => void;
  /** 进入向导时停在的步骤（从确认页「返回修改」时定位到第一个没填好的步骤）。 */
  initialStep?: WizardStepId;
  onComplete: () => void;
  onCancel: () => void;
}

/**
 * 向导外壳：步骤指示 + 当前步骤内容 + 上一步 / 下一步。步骤内容由原子设置
 * 组件组装（wizard-steps / wizard-worker-step），这里只管推进与放行：
 * 本步校验不过、或步骤报告了阻塞原因（未保存的表单、不合法输入）时不能前进。
 */
export function OnboardWizard({ draft, onChange, initialStep = 'provider', onComplete, onCancel }: OnboardWizardProps) {
  const [step, setStep] = useState<WizardStepId>(initialStep);
  const [blockReason, setBlockReason] = useState<string | null>(null);
  const index = stepIndex(step);
  const isLast = index === WIZARD_STEPS.length - 1;
  const problem = stepProblem(draft, step);
  // 步骤自身的问题优先；有表单开着时由步骤给的原因解释（可能为空串）。
  const hint = problem && blockReason === null ? problem : blockReason || null;

  const move = (next: WizardStepId): void => {
    setBlockReason(null);
    setStep(next);
  };

  return (
    <Card className="gap-4">
      <CardHeader className="flex-col items-start gap-2">
        <CardTitle>初始配置向导</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          {WIZARD_STEPS.map((s, i) => (
            <Badge key={s.id} variant={i < index ? 'success' : i === index ? 'default' : 'outline'}>
              {i + 1}. {s.title}
              {!s.required && '（可选）'}
            </Badge>
          ))}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">{WIZARD_STEPS[index].description}</p>
        {step === 'provider' && <ProviderStep draft={draft} onChange={onChange} onBlock={setBlockReason} />}
        {step === 'model' && <ModelStep draft={draft} onChange={onChange} onBlock={setBlockReason} />}
        {step === 'binding' && <BindingStep draft={draft} onChange={onChange} onBlock={setBlockReason} />}
        {step === 'worker' && <WorkerStep draft={draft} onChange={onChange} onBlock={setBlockReason} />}
        {/* 「还差什么」是引导不是报错：灰色说明。表单刚打开还没动时什么都不显示（空串）。 */}
        {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => (index > 0 ? move(WIZARD_STEPS[index - 1].id) : onCancel())}>
            {index > 0 ? '上一步' : '返回欢迎页'}
          </Button>
          <Button className="ml-auto" onClick={() => (isLast ? onComplete() : move(WIZARD_STEPS[index + 1].id))} disabled={problem !== null || blockReason !== null}>
            {isLast ? '完成，去确认' : '下一步'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** 最终确认页：全量展示 + 与保存同口径的校验 → 确认写入。 */
export function FinalConfirm({
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
  const problem = draftProblem(draft);
  return (
    <Card className="gap-4">
      <CardHeader className="flex-col items-start gap-2">
        <CardTitle>确认配置</CardTitle>
        <CardDescription>确认后写入应用配置（userData/config.json），并以此为 server 启动。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ConfigSummary config={draft} />
        {problem && <p className="rounded-md border border-destructive/30 bg-destructive-soft px-3 py-2 text-sm text-destructive">{problem}</p>}
        {error && <p className="rounded-md border border-destructive/30 bg-destructive-soft px-3 py-2 text-sm text-destructive">{error}</p>}
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onBack}>
            返回修改
          </Button>
          <Button className="ml-auto" onClick={onConfirm} disabled={problem !== null || saving}>
            {saving ? '写入并启动中…' : '确认写入并进入主界面'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
