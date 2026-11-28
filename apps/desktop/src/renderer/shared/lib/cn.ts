import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge 只认识它自带主题里的圆角档位。本项目自己加的渐变曲率圆角
 * （`rounded-squircle` / `rounded-squircle-lg`，见 globals.css）要在这里登记，
 * 否则它不会把这两类当成圆角：和别的 `rounded-*` 同时出现时两个都留下，而
 * Tailwind 按类名字母序排样式，后写的 squircle 反而会被 `rounded-xl` 盖掉。
 */
const twMerge = extendTailwindMerge({
  extend: { theme: { radius: [(value: string) => value === 'squircle' || value === 'squircle-lg'] } },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
