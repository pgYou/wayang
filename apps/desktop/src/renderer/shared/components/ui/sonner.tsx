import { Toaster as Sonner, type ToasterProps } from 'sonner';
import './sonner.scss';

/**
 * 顶部要让开窗口的拖拽区：应用顶栏高 48px，是 `-webkit-app-region: drag`，
 * 落在里面的点击会被当成拖动窗口、不交给页面——toast 的关闭按钮比 toast
 * 顶边还高 6px，所以上边距取 56px，让整个 toast（含关闭按钮）都在顶栏下方。
 */
const TOAST_OFFSET = { top: 56, bottom: 24, left: 24, right: 24 } as const;

/**
 * 全应用的 toast 宿主：挂在 App 根上一次，任何地方调 sonner 的 `toast()` 即可。
 * 颜色 / 圆角 / 字体接回 app 的 token——sonner 的默认配色是它运行时注入的
 * CSS 变量，覆盖方式见同名 scss。
 */
export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="light"
      position="top-center"
      closeButton
      offset={TOAST_OFFSET}
      className="wayang-toaster"
      toastOptions={{ closeButtonAriaLabel: '关闭' }}
      {...props}
    />
  );
}
