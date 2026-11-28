/**
 * 测试里找元素的锚点。一律用 `data-testid`，按「在哪、做什么」命名，不带文案：
 * 可见文案是给用户看的，改一次文案测试就得跟着改；aria-label 同理。
 * 同一种动作出现在多行上（provider / 模型 / worker 的编辑、删除）时，再配一个
 * `data-id` 标明是哪一行，用 rowAction 找。
 *
 * 标签 → 控件的关联（`label[for]` → `id`）不属于「文案锚点」：那是无障碍契约，
 * 测试可以继续靠它找输入框。
 */

export function byTestId(id: string, root: ParentNode = document.body): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`找不到 data-testid="${id}"`);
  return el;
}

/** 同 byTestId，找不到时返回 null（用来断言「页面上没有这个东西」）。 */
export function queryByTestId(id: string, root: ParentNode = document.body): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

export function allByTestId(id: string, root: ParentNode = document.body): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`));
}

/** 某一行上的动作：`data-testid` 说明是什么动作，`data-id` 说明是哪一行。 */
export function rowAction(id: string, rowId: string, root: ParentNode = document.body): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-testid="${id}"][data-id="${rowId}"]`);
  if (!el) throw new Error(`找不到 data-testid="${id}" data-id="${rowId}"`);
  return el;
}
