import markLightSvg from '@assets/logo/wayang-logo-light.svg?raw';
import markDarkSvg from '@assets/logo/wayang-logo-dark.svg?raw';
import { cn } from '@/renderer/shared/lib/cn';
import './wayang-mark.scss';

/**
 * Wayang 的 W 形标（assets/logo 的两版无边框 SVG，与顶栏 logo 同一个来源）。
 * - variant：标放在浅色底上用 light（墨迹偏深），深色底上用 dark（墨迹偏亮）；
 * - background：带一块渐变曲率圆角的底色方块，浅色版配方块是浅色的、深色版
 *   是深色的（深色版带方块就是应用图标的样子），默认不带；
 * - size：边长档位；
 * - animated：三道折线位置不动、从底部依次亮起的律动（动画在
 *   wayang-mark.scss），默认不播。
 *
 * 律动要动到图形内部的每一条折线，`<img>` 引 SVG 做不到，所以把 SVG 源码
 * 直接内联进来（`?raw`），按文件里折线的先后顺序（自上而下）逐条对应到
 * 上 / 中 / 下三道。图形本身仍然只有 assets/logo 这一份，这里不抄坐标和颜色。
 */

/**
 * 边长档位（px）。Tailwind 的类名要完整出现在源码里才会生成，所以是有限
 * 档位而不是任意数字；要别的尺寸用 className 传 `size-*`。
 */
const SIZE_CLASS = {
  16: 'size-4',
  20: 'size-5',
  24: 'size-6',
  28: 'size-7',
  32: 'size-8',
  36: 'size-9',
  40: 'size-10',
  48: 'size-12',
  56: 'size-14',
  64: 'size-16',
  72: 'size-18',
  80: 'size-20',
  96: 'size-24',
  112: 'size-28',
  128: 'size-32',
  144: 'size-36',
  160: 'size-40',
} as const;

export type WayangMarkSize = keyof typeof SIZE_CLASS;

export interface WayangMarkProps {
  /**
   * 标放在什么底色上（同 assets/logo 的命名）：浅色底用 light（墨迹偏深），
   * 深色底用 dark（墨迹偏亮）。默认 light，和顶栏一致。
   */
  variant?: 'light' | 'dark';
  /**
   * 带底色方块（渐变曲率圆角），底色跟着 variant 走：light 配浅色方块，
   * dark 配深色方块（即应用图标）。默认不带。
   */
  background?: boolean;
  /** 边长档位。默认 32，和顶栏 logo 一样大。 */
  size?: WayangMarkSize;
  /** 播放「三道折线从底部依次亮起」的律动。默认不播。 */
  animated?: boolean;
  /** 追加的类（对齐、外边距，或档位以外的 `size-*`）。 */
  className?: string;
}

export function WayangMark({ variant = 'light', background = false, size = 32, animated = false, className }: WayangMarkProps) {
  return (
    <div
      data-slot="wayang-mark"
      data-variant={variant}
      className={cn(
        'wayang-mark select-none',
        SIZE_CLASS[size],
        background && 'wayang-mark-tile',
        animated && 'wayang-mark-animated',
        className,
      )}
      dangerouslySetInnerHTML={{ __html: variant === 'dark' ? markDarkSvg : markLightSvg }}
    />
  );
}
