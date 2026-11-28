/**
 * Pure UI metrics for the chat surface — unit-testable without
 * a DOM: context-ring percentage, the user-message fold decision, and the
 * TurnDotsNav sliding window.
 */

import type { ContextUsage } from '@wayang-ai/protocol';

/** Context ring percentage (0–100, clamped); null when no usage is known. */
export function contextPercent(usage: ContextUsage | null): number | null {
  if (!usage || usage.contextWindowTokens <= 0) return null;
  return Math.min(100, Math.round((usage.usedTokens / usage.contextWindowTokens) * 100));
}

/** Compact token label for the ring's title (12.3k style). K is binary (1024), same as the CLI status bar. */
export function formatTokens(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)}k` : String(n);
}

/**
 * 消息时间戳格式化：当天显示 `HH:mm:ss`，非当天显示
 * `YYYY-MM-DD HH:mm:ss`——user 与 assistant 行共用同一格式。
 */
export function formatMessageTime(ts: number): string {
  if (!ts || Number.isNaN(ts)) return '';
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay ? hms : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hms}`;
}

/**
 * 思考耗时格式化：不足 1 分钟只显示秒（`45s`），满 1 分钟显示分秒
 * （`1m 5s`）。负值/NaN 按 0 处理（防御历史数据）。
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

/** Fold a message whose rendered height exceeds the threshold. */
export const FOLD_THRESHOLD_PX = 300;

export function shouldFold(contentHeight: number | null, expanded: boolean, threshold: number = FOLD_THRESHOLD_PX): boolean {
  if (contentHeight === null || expanded) return false;
  return contentHeight > threshold;
}

/** One navigator bar's model (one user query = one bar). */
export interface TurnDot {
  /** The user message's conversation uuid (scroll anchor). */
  id: string;
  /** Hover card, first paragraph: the user query text. */
  preview: string;
  /**
   * Hover card, second paragraph: the owning turn's assistant body excerpt.
   * Absent when the turn has no terminal body yet (running / tool-only).
   */
  assistantPreview?: string;
  /** The turn is still streaming — the bar keeps a raised floor opacity. */
  running?: boolean;
}

/**
 * 轮次目录派生（ZCode ConversationTurnNavigator 同款语义）：每条 user
 * 消息一个导航项；assistant 摘要取该 user 之后、下一条 user 之前的首条
 * 带正文的 assistant 步骤（纯工具步骤跳过）；最后一条 user 且会话仍在
 * 流式输出时标 running。tool/reasoning/signal 正文不进入摘要。
 */
export function buildTurnDirectory(
  conversation: ReadonlyArray<{ role: string; id: string; content: string }>,
  busy: boolean,
): TurnDot[] {
  const items: TurnDot[] = [];
  for (let i = 0; i < conversation.length; i += 1) {
    const entry = conversation[i];
    if (entry.role !== 'user') continue;
    let assistantPreview: string | undefined;
    let isLastUser = true;
    for (let j = i + 1; j < conversation.length; j += 1) {
      const next = conversation[j];
      if (next.role === 'user') {
        isLastUser = false;
        break;
      }
      // 只取 assistant 正文；signal/system/tool 行不进摘要。
      if (next.role === 'assistant' && !assistantPreview && next.content.trim()) {
        assistantPreview = next.content.trim();
      }
    }
    items.push({ id: entry.id, preview: entry.content, assistantPreview, running: busy && isLastUser });
  }
  return items;
}

/** Bar visual state (ZCode resolveConversationTurnNavigatorBarVisualState 1:1). */
export interface TurnBarVisualState {
  /** `focus` = peak bar takes the foreground color; `muted` = subtle grays. */
  colorTone: 'focus' | 'muted';
  opacity: number;
  /** Bar length factor; the bar grows from its left end (origin-left). */
  scaleX: number;
  tone: 'idle' | 'mid' | 'near' | 'peak';
}

/**
 * 横条「山峰」状态机：hover/focus 的那根为峰（最长最亮），邻近 1–2 根
 * 按距离递减变长——不做阶梯式颜色渐变；无交互焦点时回落 idle。
 */
export function turnBarVisualState(itemIndex: number, focusIndex: number | null): TurnBarVisualState {
  if (focusIndex === null) return { colorTone: 'muted', opacity: 0.58, scaleX: 1, tone: 'idle' };
  const distance = Math.abs(itemIndex - focusIndex);
  if (distance === 0) return { colorTone: 'focus', opacity: 1, scaleX: 2.6, tone: 'peak' };
  if (distance === 1) return { colorTone: 'muted', opacity: 0.86, scaleX: 1.7, tone: 'near' };
  if (distance === 2) return { colorTone: 'muted', opacity: 0.72, scaleX: 1.25, tone: 'mid' };
  return { colorTone: 'muted', opacity: 0.58, scaleX: 1, tone: 'idle' };
}

/**
 * 横条 scale 封顶（ZCode：Math.min(scaleX, 2)）。横条基础 12px、按钮宽
 * 24px——封顶后 peak 恰好填满命中区，不越出 rail。
 */
export const TURN_BAR_MAX_SCALE = 2;
