import { ArrowLeftIcon, BotIcon, CpuIcon, FolderIcon, ShieldIcon, SlidersHorizontalIcon } from 'lucide-react';
import { Button } from '@/renderer/shared/components/ui/button';
import { Menu, type MenuItem } from '@/renderer/shared/components/ui/menu';

export type SettingsGroup = 'models' | 'worker' | 'permission' | 'workspace' | 'advanced';

const GROUP_ITEMS: ReadonlyArray<MenuItem<SettingsGroup>> = [
  { value: 'models', label: '模型', icon: <CpuIcon /> },
  { value: 'worker', label: 'Worker', icon: <BotIcon /> },
  { value: 'permission', label: '权限', icon: <ShieldIcon /> },
  { value: 'workspace', label: '工作区', icon: <FolderIcon /> },
  { value: 'advanced', label: '高级', icon: <SlidersHorizontalIcon /> },
];

/**
 * 设置页分组导航：无背景、无分割线，紧靠表单区左侧并与表单区整体水平
 * 居中（居中由页面容器负责）。顶部「返回」文字按钮（回到 chat 页，取代
 * 原 header 关闭按钮），其下是 ui/Menu 分组菜单。
 */
export function SettingsNav({
  active,
  onSelect,
  onBack,
}: {
  active: SettingsGroup;
  onSelect: (group: SettingsGroup) => void;
  onBack: () => void;
}) {
  return (
    <div className="sticky top-0 flex w-40 shrink-0 flex-col gap-2 self-start">
      <Button variant="ghost" size="sm" onClick={onBack} className="self-start text-muted-foreground">
        <ArrowLeftIcon />
        返回 agent
      </Button>
      <Menu items={GROUP_ITEMS} value={active} onValueChange={onSelect} aria-label="设置分组" />
    </div>
  );
}
