/**
 * 表单里的数字输入解析：输入框里是原始文本，「留空」与「填了但不合法」要
 * 分开报——留空算不算缺由调用方决定（必填字段留空即缺，可选字段留空即
 * 不写）。
 */
export interface ParsedNumber {
  /** 留空（未填）。 */
  empty: boolean;
  /** 非空但不合法。 */
  invalid: boolean;
  /** 合法时的数值。 */
  value?: number;
}

const EMPTY: ParsedNumber = { empty: true, invalid: false };

function finish(text: string, ok: (n: number) => boolean): ParsedNumber {
  const value = Number(text);
  return Number.isFinite(value) && ok(value) ? { empty: false, invalid: false, value } : { empty: false, invalid: true };
}

/** 正整数：并发数、轮次、token 数。 */
export function parsePositiveInt(text: string): ParsedNumber {
  const trimmed = text.trim();
  return trimmed.length === 0 ? EMPTY : finish(trimmed, (n) => Number.isInteger(n) && n > 0);
}

/** 有限小数：温度等。 */
export function parseDecimal(text: string): ParsedNumber {
  const trimmed = text.trim();
  return trimmed.length === 0 ? EMPTY : finish(trimmed, () => true);
}
