import { useCallback } from 'react';
import type { WayangConfig } from '@wayang-ai/protocol';
import { AgentGroup } from '@/renderer/main-window/components/settings/agent-group';
import { ModelsGroup } from '@/renderer/main-window/components/settings/models-group';
import type { ConfigCommit } from '@/renderer/main-window/components/settings/commit';

/** 每个向导步骤拿到的外部接口。 */
export interface StepProps {
  draft: WayangConfig;
  onChange: (next: WayangConfig) => void;
}

/**
 * onboard 里的提交口（向导各步和确认页共用）：卡片组件以为自己在「保存」，
 * 其实是把整份新配置写回本地草稿——和设置页共用同一套分组组件，只是接的
 * commit 不一样。
 */
export function useDraftCommit(onChange: (next: WayangConfig) => void): ConfigCommit {
  return useCallback(async (next) => onChange(next), [onChange]);
}

/*
 * 两步就是设置页的两个分组原样渲染：模型（provider + 模型）、Agent（模型绑定
 * + puppet 默认参数）。这里不画任何卡片，只把提交口接到草稿上。
 */

/**
 * onboard 页面上卡片的外观。卡片的边框 / 投影是按设置页的灰底调的，这里是
 * 白底：换成细边框、不带投影。向导各步和确认页共用。
 */
export const CARD_ON_WHITE = 'border-border shadow-none';

export function ModelsStep({ draft, onChange }: StepProps) {
  const commit = useDraftCommit(onChange);
  // 分区标题不显示：步骤名已经在步骤条上。一个 provider 都没有时直接弹出新增弹窗。
  return <ModelsGroup config={draft} commit={commit} title={null} autoCreate cardClassName={CARD_ON_WHITE} />;
}

export function AgentStep({ draft, onChange }: StepProps) {
  const commit = useDraftCommit(onChange);
  return (
    // 第三方 worker 不在 onboard 里添加（之后在设置页加）；两块之间的间距与
    // 设置页里分组的间距一致。
    <div className="flex flex-col gap-8">
      <AgentGroup config={draft} commit={commit} thirdPartyWorkers={false} cardClassName={CARD_ON_WHITE} />
    </div>
  );
}
