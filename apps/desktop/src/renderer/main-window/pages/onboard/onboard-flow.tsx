import { useState } from 'react';
import { UploadIcon } from 'lucide-react';
import type { WayangConfig } from '@wayang-ai/protocol';
import { wayang } from '@/renderer/shared/lib/wayang-api';
import { emptyDraft } from '@/renderer/shared/lib/config-draft';
import { cn } from '@/renderer/shared/lib/cn';
import { NOT_CONFIGURED_PROBLEM } from '@/shared/onboard';
import { Button } from '@/renderer/shared/components/ui/button';
import { AppHeader } from '@/renderer/shared/components/shared/app-header';
import { WayangMark } from '@/renderer/shared/components/shared/wayang-mark';
import { FinalConfirm, OnboardWizard } from './onboard-wizard';
import { notifyImportedWorkersDisabled } from './import-notice';
import { firstProblemStep, type WizardStepId } from './wizard-state';

/**
 * 首启配置流：初始页 → 向导（两步）→ 确认页 →「应用」写入 userData 信封并启动
 * → 主界面。确认页把两步的卡片一起摆出来、可原地修改，整份配置合法才能「应用」。
 *
 * 向导既是「从零填写」也是「修改」：磁盘上已有但不完整的配置以草稿的形式走
 * 同一条两步流程，停在第一个没填好的步骤。
 *
 * 「导入 CLI 配置」不走向导，直接落到确认页。导入里不合法的第三方 worker 已被
 * 置为停用（main 的 disableInvalidWorkers），不合法的行不会让导入失败；有被停用
 * 的行时用 toast 说明。
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
  /** 磁盘上有可导入的 CLI 配置（main 检测）。false / 缺省时欢迎页不摆「导入 CLI 配置」入口。 */
  hasCliConfig?: boolean;
  /** Called after the envelope is saved and the server boot has started. */
  onFinished: () => void;
}

export function OnboardFlow({ problem, existingConfig, hasCliConfig, onFinished }: OnboardFlowProps) {
  const [phase, setPhase] = useState<FlowPhase>('welcome');
  const [draft, setDraft] = useState<WayangConfig>(() => existingConfig ?? emptyDraft());
  /** 进向导时停在的步骤（「修改现有配置」落在第一个没填好的步骤）。 */
  const [entryStep, setEntryStep] = useState<WizardStepId>('models');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** 正在读取 CLI 配置（初始页的导入按钮此时不可点）。 */
  const [importing, setImporting] = useState(false);

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
      {/* 初始页整组垂直居中（放不下时靠顶，免得上半截滚不回来）；向导和确认页是
          表单，从顶部排起。 */}
      <div className={cn('flex flex-1 justify-center overflow-y-auto p-8 pt-12', phase === 'welcome' && 'items-center-safe')}>
        <div className="flex w-full max-w-2xl flex-col gap-4">
          {phase === 'welcome' && (
            <WelcomePage
              problem={problem}
              hasExistingConfig={existingConfig !== undefined}
              hasCliConfig={hasCliConfig === true}
              error={error}
              onStart={() => enterWizard(emptyDraft(), 'models')}
              onEditExisting={() => existingConfig && enterWizard(existingConfig, firstProblemStep(existingConfig))}
              importing={importing}
              onImport={async () => {
                setError(null);
                setImporting(true);
                try {
                  // 不走向导：导入的配置直接落到确认页（此时还没写入任何东西），
                  // 改不改都由人在那一页决定，点「应用」才写入。
                  const { config, disabledWorkers } = await wayang.importCliConfig();
                  setError(null);
                  setDraft(config);
                  setPhase('confirm');
                  notifyImportedWorkersDisabled(disabledWorkers);
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                } finally {
                  setImporting(false);
                }
              }}
            />
          )}
          {phase === 'wizard' && (
            <OnboardWizard
              draft={draft}
              onChange={setDraft}
              initialStep={entryStep}
              onComplete={() => {
                setError(null);
                setPhase('confirm');
              }}
              onCancel={() => setPhase('welcome')}
            />
          )}
          {phase === 'confirm' && (
            <FinalConfirm
              draft={draft}
              onChange={setDraft}
              saving={saving}
              error={error}
              onCancel={() => setPhase('welcome')}
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
  hasCliConfig,
  importing,
  error,
  onStart,
  onEditExisting,
  onImport,
}: {
  problem?: string;
  hasExistingConfig: boolean;
  hasCliConfig: boolean;
  /** 正在导入并写入：入口按钮此时不可点。 */
  importing: boolean;
  error: string | null;
  onStart: () => void;
  onEditExisting: () => void;
  onImport: () => void;
}) {
  // 真正的首次启动不带原因（见 NOT_CONFIGURED_PROBLEM）；文件坏了、现有配置
  // 缺东西，原因要让人看见。
  const note = problem !== undefined && problem !== NOT_CONFIGURED_PROBLEM ? problem : undefined;
  return (
    // 不套卡片：图标、标题、副标题、入口直接摆在页面上，整组居中。
    <div data-testid="onboard-welcome" className="flex flex-col items-center text-center">
      {/* W 形标四周自带留白（墨迹约占盒子的 54%），所以标题不再另加大的上边距。 */}
      <WayangMark size={144} animated />
      <h1 data-testid="onboard-title" className="mt-1 text-3xl font-semibold tracking-tight">Welcome to play with Wayang</h1>
      <p className="mt-2 text-lg text-muted-foreground">完成基础配置，然后开始尽情使用~</p>
      {/* 原因这一行 576px 封顶：必要核心缺失的整句（最长的一条常见提示）正好一行，更长的报错在此折行。 */}
      {note && <p data-testid="onboard-note" className="mt-2 max-w-xl text-sm text-muted-foreground">{note}</p>}
      {/* 按钮列的宽度跟着最长的那个入口走（按钮文案不换行），再让每个按钮撑满这一列；
          只剩一个短入口时也不让它缩成一小条。 */}
      <div className="mt-8 flex min-w-64 flex-col gap-2">
        {hasExistingConfig ? (
          <Button size="lg" className="w-full" data-testid="onboard-edit-existing" onClick={onEditExisting}>
            修改现有配置
          </Button>
        ) : (
          <Button size="lg" className="w-full" data-testid="onboard-start" onClick={onStart}>
            开始配置
          </Button>
        )}
        {/* 磁盘上没有 CLI 配置就没有可导入的东西，入口不摆。导入不走向导：
            读进来直接落到确认页。 */}
        {hasCliConfig && (
          <Button size="lg" variant="outline" className="w-full" data-testid="onboard-import" disabled={importing} onClick={() => void onImport()}>
            <UploadIcon />
            {importing ? '正在导入…' : '导入 CLI 配置（~/.wayang.config.json）'}
          </Button>
        )}
        {hasExistingConfig && (
          <Button size="lg" variant="ghost" className="w-full" data-testid="onboard-restart" onClick={onStart}>
            重新配置（确认后覆盖现有配置）
          </Button>
        )}
      </div>
      {error && <p data-testid="onboard-error" className="mt-4 max-w-xl rounded-md border border-destructive/30 bg-destructive-soft px-3 py-2 text-sm text-destructive">{error}</p>}
    </div>
  );
}
