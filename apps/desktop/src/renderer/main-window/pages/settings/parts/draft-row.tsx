import type { ReactNode } from 'react';
import { useDraftSection } from './draft-section';
import { SaveCancelBar } from './field-controls';
import { FieldLabel, SettingsRow } from './settings-section';

/**
 * 「输入类」设置项的通用容器：标签 + 控件 + 草稿 + 保存 / 取消，一行写完一项。
 *
 * - 控件由 children 渲染（拿到草稿值和 setter）：一个输入框、一组输入框、一个
 *   文本域都行，共用同一份草稿。
 * - 草稿以 `committed` 为基线（见 useDraftSection）：外部提交了新值、且这一项
 *   没有未保存的改动时，草稿自动跟上。
 * - 保存 / 取消只在有改动时出现；给了 `problem` 时，改了但不合法就就近显示
 *   原因、保存不点亮。
 *
 * 分区（卡片 + 大标题）用 SettingsSection；这一项是分区里的一行。
 */
export interface DraftRowProps<T> {
  /** 行标签；省略时由 children 自己排带标签的字段（一行多个字段时用）。 */
  label?: ReactNode;
  /** 这一项要重启才生效：标签旁加重启徽标。 */
  restart?: boolean;
  /** 最近提交的值，也是草稿的基线。 */
  committed: T;
  onSave: (value: T) => Promise<void>;
  /** 草稿是否合法：返回给用户看的原因，null 表示合法。 */
  problem?: (draft: T) => string | null;
  children: (draft: T, set: (next: T) => void) => ReactNode;
}

export function DraftRow<T>({ label, restart = false, committed, onSave, problem, children }: DraftRowProps<T>) {
  const section = useDraftSection(committed, onSave);
  // 有改动但不合法时就近说明原因（保存按钮同时不出现为可点）。
  const liveProblem = section.dirty ? (problem?.(section.value) ?? null) : null;

  return (
    <SettingsRow>
      {label !== undefined && <FieldLabel restart={restart}>{label}</FieldLabel>}
      {children(section.value, section.setValue)}
      <SaveCancelBar
        dirty={section.dirty && liveProblem === null}
        saving={section.saving}
        error={section.error ?? liveProblem}
        onSave={section.save}
        onCancel={section.cancel}
      />
    </SettingsRow>
  );
}
