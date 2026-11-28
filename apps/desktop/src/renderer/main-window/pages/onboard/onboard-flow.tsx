import { useState } from 'react';
import { UploadIcon } from 'lucide-react';
import type { WayangConfig } from '@wayang-ai/protocol';
import { wayang } from '@/renderer/shared/lib/wayang-api';
import { emptyDraft } from '@/renderer/shared/lib/config-draft';
import { Button } from '@/renderer/shared/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/renderer/shared/components/ui/card';
import { AppHeader } from '@/renderer/shared/components/shared/app-header';
import { FinalConfirm, OnboardWizard } from './onboard-wizard';
import { firstProblemStep, type WizardStepId } from './wizard-state';

/**
 * 首启配置流：欢迎页（三个入口）→ 向导 / CLI 导入 → 最终确认页（全量展示
 * + 核心完整性校验）→ 确认写入 userData 信封 → 主界面。
 *
 * 向导既是「从零填写」也是「修改」：导入的配置、磁盘上已有但不完整的配置
 * 都以草稿的形式进同一条分步流程（每一步列出已有条目，可编辑 / 删除）。
 */

type FlowPhase = 'welcome' | 'wizard' | 'confirm';

interface OnboardFlowProps {
  /** The cold-start problem text (why the welcome page is showing). */
  problem?: string;
  /**
   * 磁盘上已有、结构合法但必要核心不完整的配置。给出时欢迎页多一个
   * 「修改现有配置」入口——以它为草稿进向导，而不是让人从零重填。
   */
  existingConfig?: WayangConfig;
  /** Called after the envelope is saved and the server boot has started. */
  onFinished: () => void;
}

export function OnboardFlow({ problem, existingConfig, onFinished }: OnboardFlowProps) {
  const [phase, setPhase] = useState<FlowPhase>('welcome');
  const [draft, setDraft] = useState<WayangConfig>(() => existingConfig ?? emptyDraft());
  /** 进向导时停在的步骤（返回修改时定位到第一个没填好的步骤）。 */
  const [entryStep, setEntryStep] = useState<WizardStepId>('provider');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const enterWizard = (config: WayangConfig, step: WizardStepId): void => {
    setError(null);
    setDraft(config);
    setEntryStep(step);
    setPhase('wizard');
  };

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
    <div className="flex h-full flex-col bg-background">
      {/* 首启也保持窗口可拖、logo 与红绿灯区一致（AppHeader 复用，无动作区）。 */}
      <AppHeader />
      <div className="flex flex-1 items-center justify-center overflow-y-auto p-8">
        <div className="flex w-full max-w-2xl flex-col gap-4">
          {phase === 'welcome' && (
            <WelcomePage
              problem={problem}
              hasExistingConfig={existingConfig !== undefined}
              error={error}
              onStart={() => enterWizard(emptyDraft(), 'provider')}
              onEditExisting={() => existingConfig && enterWizard(existingConfig, firstProblemStep(existingConfig))}
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
              initialStep={entryStep}
              onComplete={() => setPhase('confirm')}
              onCancel={() => setPhase('welcome')}
            />
          )}
          {phase === 'confirm' && (
            <FinalConfirm
              draft={draft}
              saving={saving}
              error={error}
              onBack={() => {
                setEntryStep(firstProblemStep(draft));
                setPhase('wizard');
              }}
              onConfirm={() => void saveAndEnter()}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ welcome ------------------------------ */

function WelcomePage({
  problem,
  hasExistingConfig,
  error,
  onStart,
  onEditExisting,
  onImport,
}: {
  problem?: string;
  hasExistingConfig: boolean;
  error: string | null;
  onStart: () => void;
  onEditExisting: () => void;
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
            {hasExistingConfig
              ? `${problem ?? '现有配置不完整'}——可以接着改现有的，也可以重新配置或导入 CLI 配置。`
              : `${problem ?? '尚未配置'}——按步骤填好 provider、模型与绑定即可开始。`}
          </CardDescription>
        </div>
        <div className="flex flex-col gap-2">
          {hasExistingConfig ? (
            <>
              <Button size="lg" onClick={onEditExisting}>
                修改现有配置
              </Button>
              <Button size="lg" variant="outline" onClick={() => void onImport()}>
                <UploadIcon />
                导入 CLI 配置（~/.wayang.config.json，只读）
              </Button>
              <Button size="lg" variant="ghost" onClick={onStart}>
                重新配置（确认后覆盖现有配置）
              </Button>
            </>
          ) : (
            <>
              <Button size="lg" onClick={onStart}>
                开始配置
              </Button>
              <Button size="lg" variant="outline" onClick={() => void onImport()}>
                <UploadIcon />
                导入 CLI 配置（~/.wayang.config.json，只读）
              </Button>
            </>
          )}
        </div>
        {error && <p className="rounded-md border border-destructive/30 bg-destructive-soft px-3 py-2 text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
