import { useEffect, useRef, useState } from 'react';

/**
 * 「输入类」字段的缓冲 + 显式保存（设置页保存策略 §「输入类」）：本地维护
 * 一份草稿，草稿与最近提交值序列化后不同即为 dirty——dirty 时保存/取消
 * 按钮才点亮（可点击）。
 *
 * committed 一律按「序列化内容」比较，不看引用：调用方经常直接传对象字面量
 * （如 logging 的 { maxFileSizeBytes, maxFiles }），引用每轮 render 都变；
 * 若 effect 依赖引用并在里面 setValue，就会自激成无限更新
 * （Maximum update depth exceeded）。内容变化且本节此前干净（草稿仍等于旧
 * committed）时才跟随刷新；有未提交编辑时保留用户输入。
 */
export interface DraftSection<T> {
  value: T;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  setValue: (next: T) => void;
  save: () => void;
  cancel: () => void;
}

const keyOf = (value: unknown): string => JSON.stringify(value) ?? '';

export function useDraftSection<T>(committed: T, onSave: (value: T) => Promise<void>): DraftSection<T> {
  const [value, setValue] = useState<T>(committed);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const committedKey = keyOf(committed);
  const dirty = keyOf(value) !== committedKey;
  const followedKey = useRef(committedKey);

  useEffect(() => {
    if (followedKey.current === committedKey) return;
    const previousKey = followedKey.current;
    followedKey.current = committedKey;
    setValue((prev) => (keyOf(prev) === previousKey ? committed : prev));
  }, [committed, committedKey]);

  const save = (): void => {
    setSaving(true);
    setError(null);
    onSave(value)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSaving(false));
  };

  const cancel = (): void => {
    setValue(committed);
    setError(null);
  };

  return { value, dirty, saving, error, setValue, save, cancel };
}

/**
 * 「选项/开关类」字段的即时生效（设置页保存策略）：onChange 直接触发
 * 保存，无本地草稿；失败时上层 prop 未变，控件自然回落旧值，只需在此
 * 记录一次性错误供就近展示。
 */
export interface AutoSaveAction {
  pending: boolean;
  error: string | null;
  run: (action: () => Promise<void>) => void;
}

export function useAutoSaveAction(): AutoSaveAction {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (action: () => Promise<void>): void => {
    setPending(true);
    setError(null);
    action()
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setPending(false));
  };
  return { pending, error, run };
}
