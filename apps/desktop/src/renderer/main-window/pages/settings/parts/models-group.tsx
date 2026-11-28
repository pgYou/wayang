import { useState } from 'react';
import { PlusIcon } from 'lucide-react';
import type { WayangConfig } from '@wayang-ai/protocol';
import { upsertProvider } from '@/renderer/shared/lib/config-draft';
import { Button } from '@/renderer/shared/components/ui/button';
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
import type { ConfigCommitState } from '../use-config-commit';

type CommitFn = ConfigCommitState['commit'];

const EMPTY_PROVIDER: ProviderFormValues = { key: '', baseURL: '', apiKey: '' };

/**
 * 模型分组：Provider → Model 两层树。每个 provider 一张可折叠卡片，其下
 * 的模型直接在该卡片内增删。（模型绑定不在这里——它属于 Agent 分组。）
 * 新增 / 编辑都在弹窗里做（FormDialog），表单是原子设置组件
 * （components/settings），这里只负责接到 commit。
 */
export function ModelsGroup({ config, commit }: { config: WayangConfig; commit: CommitFn }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [creating, setCreating] = useState<ProviderFormValues | null>(null);
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
      <section className="flex flex-col gap-2">
        {/* 「新增」放在分区标题行的最右边：入口固定在这一区的顶部，不随卡片数量上下跑。 */}
        <div className="flex items-center">
          <SectionTitle className="flex-1">Providers</SectionTitle>
          {/* 标题自带左右留白、按钮比标题行矮不了多少：按钮右缘即卡片右缘。 */}
          <Button size="sm" variant="ghost" className="-my-1 text-muted-foreground hover:text-foreground" onClick={() => setCreating(EMPTY_PROVIDER)}>
            <PlusIcon />
            新增 provider
          </Button>
        </div>
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
      </section>

      <FormDialog
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
