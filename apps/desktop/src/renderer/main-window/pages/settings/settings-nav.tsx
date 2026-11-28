import { ArrowLeftIcon, BotIcon, CpuIcon, FolderIcon, ShieldIcon, SlidersHorizontalIcon } from 'lucide-react';
import { Button } from '@/renderer/shared/components/ui/button';
import { Menu, type MenuItem } from '@/renderer/shared/components/ui/menu';

export type SettingsGroup = 'models' | 'agent' | 'permission' | 'workspace' | 'advanced';

const GROUP_ITEMS: ReadonlyArray<MenuItem<SettingsGroup>> = [
  { value: 'models', label: '模型', icon: <CpuIcon />, testId: 'nav-models' },
  { value: 'agent', label: 'Agent', icon: <BotIcon />, testId: 'nav-agent' },
  { value: 'permission', label: '权限', icon: <ShieldIcon />, testId: 'nav-permission' },
  { value: 'workspace', label: '工作区', icon: <FolderIcon />, testId: 'nav-workspace' },
  { value: 'advanced', label: '高级', icon: <SlidersHorizontalIcon />, testId: 'nav-advanced' },
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
    // top 与页面容器的 pt-8（settings-page.tsx）一致：导航一开始就停在粘性位置上，
    // 滚动时纹丝不动。top 比这段留白小的话，它会先跟着内容滚一段再停住。
    <div className="sticky top-8 flex w-40 shrink-0 flex-col gap-2 self-start">
      <Button variant="ghost" size="sm" data-testid="nav-back" onClick={onBack} className="self-start text-muted-foreground">
        <ArrowLeftIcon />
        返回 agent
      </Button>
      <Menu items={GROUP_ITEMS} value={active} onValueChange={onSelect} aria-label="设置分组" />
    </div>
  );
}
