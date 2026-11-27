import { useEffect, useState, type ReactNode } from 'react';
import logoUrl from '@assets/logo/wayang-logo-light.svg';
import { wayang } from '@/renderer/shared/lib/wayang-api';
import { cn } from '@/renderer/shared/lib/cn';
import { WindowControls } from './window-controls';
import './app-header.scss';

/**
 * darwin 判定：`titleBarStyle: 'hidden'` 只在 macOS 保留系统红绿灯（系统
 * 绘制、叠加在窗口左上角），其余平台没有原生叠层——渲染自绘回退。
 * 惰性求值（组件内调用）：模块顶层求值会把测试环境的 UA 定死。
 */
function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent);
}

export interface AppHeaderProps {
  /** logo 之后的页面私有内容（标题、说明文字等）。 */
  left?: ReactNode;
  /** 右侧动作区（设置入口、会话切换、关闭按钮等）。 */
  right?: ReactNode;
  /** 覆盖 header 外观（如设置页灰底）。 */
  className?: string;
}

/**
 * 应用级 header——多页面复用的基础组件（chat / settings / onboard）：
 * - 48px 高、整条可拖拽（自定义标题栏下拖动窗口唯一来源就是 CSS drag
 *   region，见 app-header.scss），按钮类交互件逐个 no-drag；
 * - 左侧窗口控制区：macOS 系统红绿灯原生自带全部交互（渐变、整组 hover
 *   显形、失焦变灰、无障碍），此处只留等宽占位避免内容垫在按钮下；其余
 *   平台渲染自绘回退（WindowControls）；
 * - wayang logo（assets/logo 单一来源，@assets 别名；light 变体为浅色底
 *   设计）；页面私有内容经 left/right 插槽注入。
 */
export function AppHeader({ left, right, className }: AppHeaderProps) {
  // macOS 原生全屏隐藏红绿灯（wayang:window 推送）——占位随之收拢，
  // logo 直接从 header 左缘排起。非 darwin 无占位，状态不参与渲染。
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => wayang.onWindowState((state) => setFullscreen(state.fullscreen)), []);
  const isMac = isMacPlatform();

  return (
    <header className={cn('wayang-app-header flex h-12 shrink-0 items-center gap-3 border-b border-border bg-background px-4', className)}>
      {isMac ? (
        // 系统红绿灯占位：按钮组 trafficLightPosition(16,18) 起宽 52px，
        // 占位 64px 后 logo 落在 80px 起（px-4 16 + 64）；fullscreen 下隐藏。
        fullscreen ? null : <span aria-hidden className="w-16 shrink-0" />
      ) : (
        <WindowControls />
      )}
      {/* SVG 四周有 ~27% 内边距（墨迹占盒 ~54%），32px 渲染下可见字形
          ~17px——与 12px 红绿灯形成正常主次；墨迹在图片内精确居中，
          与红绿灯的垂直对齐由 flex items-center + trafficLightPosition 保证
          （dots 上调 2px 补偿 W 字形上宽下窄的视觉重心偏移）。 */}
      <img src={logoUrl} alt="Wayang" draggable={false} className="size-8 shrink-0 select-none" />
      {left}
      {right !== undefined && <span className="ml-auto flex shrink-0 items-center gap-1">{right}</span>}
    </header>
  );
}
