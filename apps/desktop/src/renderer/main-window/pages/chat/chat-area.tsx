import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SparklesIcon, TerminalIcon, GitBranchIcon, LayersIcon } from 'lucide-react';
import type { ConversationEntry, ControllerSignal } from '@wayang-ai/protocol';
import {
  SLICE,
  buildConversationItems,
  buildStreamingItems,
  buildUnreadSignalItems,
  useSliceValue,
} from '@/renderer/shared/lib/store';
import { buildTurnDirectory, type TurnDot } from '@/renderer/shared/lib/chat-metrics';
import { UserRow } from './rows/user-row';
import { SystemRow } from './rows/system-row';
import { AssistantRow } from './rows/assistant-row';
import { SignalRow } from './rows/signal-row';
import { TurnNav } from './parts/turn-nav';

interface ChatAreaProps {
  busy: boolean;
  onQuickPrompt?: (prompt: string) => void;
}

/**
 * 滚动位置状态（页面级共享）：atBottom（距底 <64px）与 scrollToBottom。
 * ChatArea 消费内部滚动容器；chat-page 把「非底部时回底」接线给
 * Composer 悬浮卡内锚定的回底按钮。
 */
const atBottomListeners = new Set<(atBottom: boolean) => void>();
let atBottomState = true;
let scrollBottomAction: (() => void) | null = null;

function setAtBottomState(next: boolean): void {
  if (atBottomState === next) return;
  atBottomState = next;
  for (const listener of atBottomListeners) listener(next);
}

/** 订阅 atBottom 状态并取得 scrollToBottom（未挂载 ChatArea 前为 no-op）。 */
export function useAtBottom(): { atBottom: boolean; scrollToBottom: () => void } {
  const [atBottom, setAtBottom] = useState(atBottomState);
  useEffect(() => {
    atBottomListeners.add(setAtBottom);
    return () => {
      atBottomListeners.delete(setAtBottom);
    };
  }, []);
  const scrollToBottom = useCallback((): void => {
    scrollBottomAction?.();
  }, []);
  return { atBottom, scrollToBottom };
}

const WELCOME_SUGGESTIONS = [
  {
    icon: TerminalIcon,
    title: '代码库探索与诊断',
    prompt: '请帮我梳理当前工作区的核心目录结构与模块职责',
  },
  {
    icon: LayersIcon,
    title: '多 Worker 并行拆解任务',
    prompt: '评估当前未完成的任务，拆解为并行子任务派发给 Worker 执行',
  },
  {
    icon: GitBranchIcon,
    title: '构建与测试门禁自检',
    prompt: '在当前工作区执行 typecheck 与单元测试，汇总失败项与修复建议',
  },
  {
    icon: SparklesIcon,
    title: '架构与方案评审',
    prompt: '帮我分析最近的改动，检查是否符合项目边界与代码规范',
  },
];

/** Row renderer shared by the conversation and unread-signal sections. */
function renderRow(
  item: ReturnType<typeof buildConversationItems>[number],
  /** 连续 assistant 块的最后一条（操作栏只在这里渲染）。 */
  isAssistantBlockLast = false,
  /** 拼接序列的最后一条 assistant（操作栏常驻展示，不需 hover）。 */
  isLatestAssistant = false,
) {
  switch (item.role) {
    case 'user':
      return (
        <div key={item.id} data-turn-uuid={item.id}>
          <UserRow item={item} />
        </div>
      );
    case 'assistant':
      return (
        <AssistantRow
          key={item.id}
          item={item}
          showActions={isAssistantBlockLast}
          pinnedActions={isLatestAssistant}
        />
      );
    case 'signal':
      return <SignalRow key={item.id} item={item} />;
    case 'system':
      return <SystemRow key={item.id} item={item} />;
  }
}

/**
 * 连续 assistant 块尾判定：该行是 assistant，且下一行（conversation → streaming →
 * unread 的拼接顺序）不是 assistant。conversation 的末尾要看后面是否还跟着
 * streaming / 未读信号里的 assistant 行。
 */
function isAssistantBlockLast(
  conversationItems: ReturnType<typeof buildConversationItems>,
  streamingItems: ReturnType<typeof buildStreamingItems>,
  unreadSignalItems: ReturnType<typeof buildUnreadSignalItems>,
  index: number,
): boolean {
  const item = conversationItems[index];
  if (item.role !== 'assistant') return false;
  const next = conversationItems[index + 1] ?? streamingItems[0] ?? unreadSignalItems[0];
  return next?.role !== 'assistant';
}

/**
 * 会话流：居中阅读栏（max-w-5xl）+ 空状态欢迎建议 +
 * 自动滚底与浮动回底按钮 + 侧边轮次圆点导航。
 * 空态建议卡片是「可点击交互容器」（非标准按钮样式），保留原生 button 承载无障碍。
 */
export function ChatArea({ busy, onQuickPrompt }: ChatAreaProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);

  const conversation = useSliceValue<ConversationEntry[]>(SLICE.conversation);
  const signals = useSliceValue<ControllerSignal[]>(SLICE.signals);
  const streaming = useSliceValue<ConversationEntry[]>(SLICE.streaming);

  const conversationItems = useMemo(
    () => buildConversationItems({ [SLICE.conversation]: conversation }),
    [conversation],
  );
  const streamingItems = useMemo(
    () => buildStreamingItems({ [SLICE.conversation]: conversation, [SLICE.streaming]: streaming }),
    [conversation, streaming],
  );
  const unreadSignalItems = useMemo(
    () => buildUnreadSignalItems({ [SLICE.signals]: signals }),
    [signals],
  );

  // 拼接序列（conversation → streaming → unread）里最后一条 assistant：其操作行常驻展示。
  const lastAssistantId = useMemo(() => {
    const seq = [...conversationItems, ...streamingItems, ...unreadSignalItems];
    for (let i = seq.length - 1; i >= 0; i -= 1) {
      if (seq[i].role === 'assistant') return seq[i].id;
    }
    return undefined;
  }, [conversationItems, streamingItems, unreadSignalItems]);

  // 轮次导航目录：每条 user 提问一项 + 所属轮次的 assistant 正文摘要
  // （buildTurnDirectory 派生；流式中的尾轮标 running）。
  const turnDots = useMemo<TurnDot[]>(
    () => buildTurnDirectory(conversationItems, busy),
    [conversationItems, busy],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setScrollEl(el);
    const onScroll = (): void => {
      const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
      pinnedRef.current = bottom;
      setAtBottomState(bottom);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // 吸底跟随（pinned 态）：新内容 commit 后把滚动容器直接压到底。
  // 不用 scrollIntoView——commit 时刻浏览器尚未完成新行布局（markdown/
  // 代码块高度延迟确定），读到的是旧 scrollHeight，滚完后内容继续长高
  // 就停在半途。requestAnimationFrame 再压一次兜住异步布局。
  useEffect(() => {
    if (!pinnedRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    const raf = requestAnimationFrame((): void => {
      if (pinnedRef.current && el.isConnected) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [conversationItems, streamingItems, unreadSignalItems, busy]);

  // 注册回底动作（useAtBottom 的 scrollToBottom 消费端）：直接把滚动
  // 容器压到底（scrollTop = scrollHeight），不依赖 bottomRef 锚点的
  // scrollIntoView——锚点对齐语义受并行追加动画（streaming effect 的
  // 非平滑滚动）干扰时会让 smooth 滚动半途失去目标，压底恒定到最底。
  useEffect(() => {
    scrollBottomAction = (): void => {
      pinnedRef.current = true;
      setAtBottomState(true);
      const el = scrollRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    };
    return () => {
      scrollBottomAction = null;
    };
  }, []);

  const isEmpty =
    conversationItems.length === 0 &&
    streamingItems.length === 0 &&
    unreadSignalItems.length === 0 &&
    !busy;

  return (
    <div className="relative min-h-0 flex-1 ">
      <div ref={scrollRef} className="h-full overflow-y-auto py-6">
        {isEmpty ? (
          <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center gap-6 px-6 py-8">
            <div className="flex flex-col items-center gap-2 text-center">
              <div className="flex size-12 items-center justify-center rounded-xl bg-primary text-lg font-bold text-primary-foreground">
                W
              </div>
              <h2 className="text-lg font-semibold text-foreground">有什么可以交给 Wayang 编排？</h2>
              <p className="max-w-md text-xs text-muted-foreground">
                Controller 将解析你的意图，自动拆解任务并调度多个 Worker 并行执行。
              </p>
            </div>
            {onQuickPrompt && (
              <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2">
                {WELCOME_SUGGESTIONS.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.title}
                      type="button"
                      onClick={() => onQuickPrompt(item.prompt)}
                      className="flex cursor-pointer flex-col items-start gap-1 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-grey-5 hover:bg-muted/60"
                    >
                      <span className="inline-flex items-center gap-2 text-xs font-medium text-foreground">
                        <Icon className="size-3 text-muted-foreground" />
                        {item.title}
                      </span>
                      <span className="line-clamp-2 text-xs text-muted-foreground">{item.prompt}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          // 底部留白（pb-36）：Composer 以悬浮卡片 fixed 在底部，滚动到底时最新内容不被遮挡。
          <div className="mx-auto flex w-full max-w-250 flex-col gap-3 px-12 pb-36">
            {conversationItems.map((item, i) =>
              renderRow(
                item,
                isAssistantBlockLast(conversationItems, streamingItems, unreadSignalItems, i),
                item.id === lastAssistantId,
              ),
            )}
            {streamingItems.map((item, i, arr) =>
              item.role === 'assistant' ? (
                <AssistantRow
                  key={`s-${item.id}`}
                  item={item}
                  streaming
                  showActions={i === arr.length - 1 && (unreadSignalItems[0]?.role !== 'assistant')}
                  pinnedActions={item.id === lastAssistantId}
                />
              ) : null,
            )}
            {unreadSignalItems.map((item) => renderRow(item))}
            {busy && streamingItems.length === 0 && (
              <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <span className="size-1.5 animate-pulse rounded-full bg-sky" />
                  <span className="size-1.5 animate-pulse rounded-full bg-sky/70" />
                  <span className="size-1.5 animate-pulse rounded-full bg-sky/40" />
                </span>
                <span>思考中…</span>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* 回底按钮已移入 Composer 悬浮卡（parts/composer.tsx）：CSS 相对
          锚定（absolute bottom-full），浮层伸缩自动跟随，无需测量。 */}

      <TurnNav items={turnDots} scrollContainer={scrollEl} />
    </div>
  );
}
