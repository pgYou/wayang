/**
 * 表单控件（Input / SelectTrigger）的三档宽度规范——按内容长度选档，不要
 * 默认一律拉满整行：
 * - sm（w-24）：数字、短码（并发数、轮次、token 数）；
 * - md（w-56）：短文本、枚举下拉（模型选择、策略、类型）；
 * - lg（整行，默认）：长文本（URL、路径、描述、密钥）。
 */
export type FieldSize = 'sm' | 'md' | 'lg';

export const fieldSizeClass: Record<FieldSize, string> = {
  sm: 'w-24',
  md: 'w-56',
  lg: 'w-full',
};
