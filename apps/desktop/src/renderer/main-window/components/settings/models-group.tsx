import { useState, type ReactNode } from 'react';
import { PlusIcon } from 'lucide-react';
import type { WayangConfig } from '@wayang-ai/protocol';
import { upsertProvider } from '@/renderer/shared/lib/config-draft';
import { Button } from '@/renderer/shared/components/ui/button';
import { cn } from '@/renderer/shared/lib/cn';
import {
  ProviderForm,
  providerFormProblem,
  providerFromForm,
  type ProviderFormValues,
} from '@/renderer/main-window/components/settings';
import { useAutoSaveAction } from './draft-section';
import { FormDialog } from './form-dialog';
import { ProviderCard } from './provider-card';
import { SectionTitle } from './settings-section';
import type { ConfigCommit } from './commit';

const EMPTY_PROVIDER: ProviderFormValues = { key: '', baseURL: '', apiKey: '' };

/**
 * 模型分组：Provider → Model 两层树。每个 provider 一张可折叠卡片，其下
 * 的模型直接在该卡片内增删。（模型绑定不在这里——它属于 Agent 分组。）
 * 新增 / 编辑都在弹窗里做（FormDialog），表单是原子设置组件
 * （components/settings），这里只负责接到 commit。
 *
 * 设置页和 onboard 向导共用：向导的「模型」一步就是这一组原样渲染。
 */
export interface ModelsGroupProps {
  config: WayangConfig;
  commit: ConfigCommit;
  /**
   * 分区标题（默认「Providers」）。null = 标题行不放标题——步骤名已经在别处
   * （如向导的步骤条上），这一行只留右侧的「新增 provider」入口。
   */
  title?: ReactNode;
  /**
   * 一个 provider 都没有时，一进来就把「新增 provider」弹窗打开（onboard 的
   * 「模型」一步用：从零填写的人不用先找入口）。设置页不传。
   */
  autoCreate?: boolean;
  /**
   * 追加到每张 provider 卡片上的类。卡片的边框 / 投影默认按灰底的设置页调，
   * 放在白底页面上（onboard 向导）时传 `border-border` 补一个边框。
   */
  cardClassName?: string;
}

export function ModelsGroup({ config, commit, title = 'Providers', autoCreate = false, cardClassName }: ModelsGroupProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [creating, setCreating] = useState<ProviderFormValues | null>(() =>
    autoCreate && Object.keys(config.providers ?? {}).length === 0 ? EMPTY_PROVIDER : null,
  );
  const providers = Object.entries(config.providers ?? {});
  const action = useAutoSaveAction();
  // 按钮不合法不点亮；动过之后才把原因显示出来（空表单一上来不该报错）。
  const touched = creating !== null && JSON.stringify(creating) !== JSON.stringify(EMPTY_PROVIDER);
  const problem = creating !== null ? providerFormProblem(creating, { requireKey: true, takenKeys: Object.keys(config.providers ?? {}) }) : null;

  const addProvider = (): void => {
    if (!creating || !touched || problem) return;
    action.run(async () => {
      await commit(upsertProvider(config, creating.key.trim(), providerFromForm(creating)));
      setCreating(null);
    });
  };

  return (
    <>
      <section data-testid="models-group" className="flex flex-col gap-2">
        {providers.length === 0 ? (
          // 一个 provider 都没有（onboard 刚进来）：入口摆成一张虚线卡，不用去角落里
          // 找那个小按钮。
          <Button variant="dashed" className="h-16 w-full" data-testid="provider-add" onClick={() => setCreating(EMPTY_PROVIDER)}>
            <PlusIcon />
            新增 provider
          </Button>
        ) : (
          // 「新增」放在分区标题行的最右边：入口固定在这一区的顶部，不随卡片数量上下跑。
          <div className="flex items-center">
            {title !== null && <SectionTitle className="flex-1">{title}</SectionTitle>}
            {/* 标题自带左右留白、按钮比标题行矮不了多少：按钮右缘即卡片右缘。 */}
            <Button
              size="sm"
              variant="ghost"
              data-testid="provider-add"
              className={cn('-my-1 text-muted-foreground hover:text-foreground', title === null && 'ml-auto')}
              onClick={() => setCreating(EMPTY_PROVIDER)}
            >
              <PlusIcon />
              新增 provider
            </Button>
          </div>
        )}
        {providers.map(([key, provider]) => (
          <ProviderCard
            key={key}
            config={config}
            commit={commit}
            providerKey={key}
            provider={provider}
            open={!collapsed[key]}
            onToggle={() => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))}
            cardClassName={cardClassName}
          />
        ))}
      </section>

      <FormDialog
        testId="provider-add-dialog"
        open={creating !== null}
        onClose={() => {
          setCreating(null);
          action.clearError();
        }}
        title="新增 provider"
        description="填 OpenAI 兼容服务的连接信息。"
        submitLabel="添加"
        onSubmit={addProvider}
        submitDisabled={!touched || problem !== null}
        problem={action.error ?? (touched ? problem : null)}
        saving={action.pending}
      >
        {creating && <ProviderForm keyEditable value={creating} onChange={setCreating} />}
      </FormDialog>
    </>
  );
}
