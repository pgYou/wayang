import { useState } from 'react';
import type { WayangConfig } from '@wayang-ai/protocol';
import { AgentGroup } from '@/renderer/main-window/components/settings/agent-group';
import { ModelsGroup } from '@/renderer/main-window/components/settings/models-group';
import { Button } from '@/renderer/shared/components/ui/button';
import { Timeline } from '@/renderer/shared/components/ui/timeline';
import { WIZARD_STEPS, draftProblem, stepIndex, stepProblem, type WizardStepId } from './wizard-state';
import { CARD_ON_WHITE, ModelsStep, AgentStep, useDraftCommit } from './wizard-steps';

interface OnboardWizardProps {
  draft: WayangConfig;
  onChange: (next: WayangConfig) => void;
  /** 进入向导时停在的步骤（从确认页「返回修改」时定位到第一个没填好的步骤）。 */
  initialStep?: WizardStepId;
  onComplete: () => void;
  onCancel: () => void;
}

/**
 * 向导外壳：步骤条 + 当前步骤内容 + 上一步 / 下一步。两步就是设置页的「模型」
 * 「Agent」两个分组原样渲染（wizard-steps），这里只管推进与放行：本步校验不过
 * 时不能前进。步骤下面不写说明文字——界面自己说清楚这一步在做什么。
 *
 * 整页不套最外层的卡片：步骤条（timeline）、步骤自己的卡片和按钮直接摆在
 * 页面上。
 */
export function OnboardWizard({ draft, onChange, initialStep = 'models', onComplete, onCancel }: OnboardWizardProps) {
  const [step, setStep] = useState<WizardStepId>(initialStep);
  const index = stepIndex(step);
  const isLast = index === WIZARD_STEPS.length - 1;
  const problem = stepProblem(draft, step);

  return (
    // 步骤条和下面的表单之间留出一截，别贴在一起。
    <div className="flex flex-col gap-8 pb-12">
      <Timeline current={index} items={WIZARD_STEPS.map((s) => ({ key: s.id, label: s.title }))} />
      <div className="flex flex-col gap-4">
        {step === 'models' && <ModelsStep draft={draft} onChange={onChange} />}
        {step === 'agent' && <AgentStep draft={draft} onChange={onChange} />}
        {/* 「还差什么」是引导不是报错：灰色说明。 */}
        {problem && <p data-testid="step-problem" className="text-sm text-muted-foreground">{problem}</p>}
        {/* 底栏右对齐：返回在主按钮的左边。 */}
        <div className="flex items-center justify-end gap-2">
          {/* 文案随步骤变（回到初始页 / 上一步、下一步 / 完成），锚点不变。 */}
          <Button variant="ghost" data-testid="wizard-back" onClick={() => (index > 0 ? setStep(WIZARD_STEPS[index - 1].id) : onCancel())}>
            {index > 0 ? '上一步' : '回到初始页'}
          </Button>
          <Button data-testid="wizard-next" onClick={() => (isLast ? onComplete() : setStep(WIZARD_STEPS[index + 1].id))} disabled={problem !== null}>
            {isLast ? '完成，去确认' : '下一步'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * 确认页（最后一步）：两步的卡片一起摆出来，和向导里一样可以原地改，不再是
 * 一张只读清单。「应用」要整份配置合法才可点——口径和保存一样（结构合法 +
 * 必要核心齐备，见 draftProblem）。从 CLI 导入的配置也直接落在这一页。
 */
export function FinalConfirm({
  draft,
  onChange,
  saving,
  error,
  onCancel,
  onConfirm,
}: {
  draft: WayangConfig;
  onChange: (next: WayangConfig) => void;
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const commit = useDraftCommit(onChange);
  const problem = draftProblem(draft);
  return (
    <div className="flex flex-col gap-8 pb-12">
      {/* 大标题与初始页的主标题同一档；这一页没有步骤条，靠它说明走到了哪。 */}
      <h1 data-testid="confirm-title" className="text-2xl font-semibold tracking-tight">配置确认</h1>
      {/* 两个分组之间的间距与设置页里分组的间距一致。第三方 worker 不在 onboard 里添加。 */}
      <div className="flex flex-col gap-8">
        <ModelsGroup config={draft} commit={commit} title="模型" cardClassName={CARD_ON_WHITE} />
        <AgentGroup config={draft} commit={commit} thirdPartyWorkers={false} cardClassName={CARD_ON_WHITE} />
      </div>
      {/* 「还差什么」是引导不是报错：灰色说明。 */}
      {problem && <p data-testid="confirm-problem" className="text-sm text-muted-foreground">{problem}</p>}
      {error && <p data-testid="confirm-error" className="rounded-md border border-destructive/30 bg-destructive-soft px-3 py-2 text-sm text-destructive">{error}</p>}
      {/* 底栏右对齐：返回在主按钮的左边（与向导页一致）。 */}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" data-testid="confirm-back" onClick={onCancel}>
          返回初始页
        </Button>
        <Button data-testid="confirm-apply" onClick={onConfirm} disabled={problem !== null || saving}>
          {saving ? '写入并启动中…' : '进入应用'}
        </Button>
      </div>
    </div>
  );
}
