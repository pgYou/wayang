import { memo, useMemo, useState } from 'react';
import {
  CheckCircle2Icon,
  ChevronRightIcon,
  Loader2Icon,
  XCircleIcon,
} from 'lucide-react';
import type { DisplayItem, DisplaySection } from '@/renderer/shared/lib/display';
import { formatMessageTime } from '@/renderer/shared/lib/chat-metrics';
import { Badge } from '@/renderer/shared/components/ui/badge';
import { Collapse } from '@/renderer/shared/components/ui/collapse';
import { Thinking } from '@/renderer/shared/components/ui/thinking';
import { cn } from '@/renderer/shared/lib/cn';
import { MarkdownContent } from '../markdown/markdown-content';

interface PairedTool {
  id: string;
  toolName: string;
  callArgs?: string;
  resultText?: string;
  isError?: boolean;
  status: 'loading' | 'completed' | 'error';
}

function pairToolSections(sections: DisplaySection[]): PairedTool[] {
  const map = new Map<string, PairedTool>();
  for (const s of sections) {
    if (s.kind === 'tool_call') {
      map.set(s.id, {
        id: s.id,
        toolName: s.toolName ?? 'tool',
        callArgs: s.text,
        status: 'loading',
      });
    } else if (s.kind === 'tool_result') {
      const existing = map.get(s.id);
      const status = s.isError ? 'error' : 'completed';
      if (existing) {
        existing.resultText = s.text;
        existing.isError = s.isError;
        existing.status = status;
      } else {
        map.set(s.id, {
          id: s.id,
          toolName: s.toolName ?? 'tool',
          resultText: s.text,
          isError: s.isError,
          status,
        });
      }
    }
  }
  return [...map.values()];
}

function summarizeArgs(raw?: string): string {
  if (!raw) return '';
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > 72 ? `${oneLine.slice(0, 72)}…` : oneLine;
}

/**
 * 工具调用行：紧凑状态行，可展开参数与输出详情。
 * 整行是「可点击交互容器」（非标准按钮样式），保留原生 button 承载无障碍语义。
 */
function ToolCallItem({ tool }: { tool: PairedTool }) {
  const [open, setOpen] = useState(false);
  const argPreview = summarizeArgs(tool.callArgs);

  return (
    <div className="wayang-toolcall-item flex flex-col">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          // 负外边距抵消 hover 胶囊的 padding：静态时内容与行左缘对齐，
          // hover 时背景向左右各延伸 8px 而不移动内容位置。
          '-mx-2 inline-flex max-w-full h-6 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs transition-colors hover:bg-muted',
          tool.status === 'error' ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        {tool.status === 'loading' && <Loader2Icon className="size-3 shrink-0 animate-spin text-sky" />}
        {tool.status === 'completed' && <CheckCircle2Icon className="size-3 shrink-0 text-success" />}
        {tool.status === 'error' && <XCircleIcon className="size-3 shrink-0 text-destructive" />}
        <span className="shrink-0 font-mono font-medium text-foreground">{tool.toolName}</span>
        {argPreview && <span className="min-w-0 truncate font-mono text-muted-foreground">{argPreview}</span>}
        <ChevronRightIcon
          className={cn('size-3 shrink-0 text-muted-foreground transition-transform duration-200', open && 'rotate-90')}
        />
      </button>
      {/* 展开/折叠内容（Collapse 高度缓动）。 */}
      <Collapse open={open}>
        <div className="mt-1 mb-2 flex flex-col gap-2 rounded-md border border-border bg-muted/50 p-3 text-xs">
            {tool.callArgs && (
              <div>
                <div className="mb-1 font-medium text-muted-foreground">参数</div>
                <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-foreground">
                  {tool.callArgs}
                </pre>
              </div>
            )}
            {tool.resultText && (
              <div>
                <div className="mb-1 font-medium text-muted-foreground">{tool.isError ? '错误输出' : '执行结果'}</div>
                <pre
                  className={cn(
                    'm-0 max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-xs',
                    tool.isError ? 'text-destructive' : 'text-muted-foreground',
                  )}
                >
                  {tool.resultText}
                </pre>
              </div>
            )}
          </div>
      </Collapse>
    </div>
  );
}

/**
 * Controller 输出 Borderless 撑开：
 * - 思考过程：移植的 Thinking（loading 自动展开、结束自动收起）
 * - 工具调用：配对后的紧凑状态行
 * - 正文：x-markdown 排版（无外框卡片）
 * - 操作栏（复制、点赞/点踩、时间戳）只在「连续 assistant 块的最后一条」渲染（`showActions`，
 *   由 ChatArea 依据块尾判定传入），且 hover 时才显现。
 *
 * `streaming` 由调用方传入（流式行由 ChatArea 单独渲染），不在 DisplayItem 上造字段。
 */
export const AssistantRow = memo(function AssistantRow({
  item,
  streaming = false,
  showActions = false,
  pinnedActions = false,
}: {
  item: DisplayItem;
  streaming?: boolean;
  /** 连续 assistant 块的最后一条才展示操作栏。 */
  showActions?: boolean;
  /** 拼接序列的最后一条 assistant：操作栏常驻展示（不需 hover）。 */
  pinnedActions?: boolean;
}) {
  const sections = item.sections ?? [];
  const content = sections.find((s) => s.kind === 'content');
  const reasoning = sections.find((s) => s.kind === 'reasoning');
  const pairedTools = useMemo(() => pairToolSections(sections), [sections]);

  // 仍在推理：流式中、有 reasoning、尚无正文也没有工具回来。
  const reasoningActive = streaming && Boolean(reasoning) && !content && pairedTools.length === 0;

  return (
    <div className="wayang-assistant-row group flex flex-col">
      {/* 思考过程：可折叠（loading 自动展开、结束自动收起） */}
      {reasoning && (
        <Thinking loading={reasoningActive}>
          <span className="whitespace-pre-wrap">{reasoning.text}</span>
        </Thinking>
      )}

      {pairedTools.length > 0 && (
        <div className="mb-2 flex flex-col gap-1">
          {pairedTools.map((tool) => (
            <ToolCallItem key={tool.id} tool={tool} />
          ))}
        </div>
      )}

      {/* Borderless Markdown prose body */}
      {content && <MarkdownContent content={content.text} streaming={streaming} />}

      {item.interrupted && (
        <div className="mt-2">
          <Badge variant="destructive">已被中断</Badge>
        </div>
      )}

      {/* 时间戳（块尾才渲染；最后一条常驻展示，其余 hover 显现）。 */}
      {content && showActions && (
        <div
          className={cn(
            'mt-1 flex h-6 items-center gap-1 text-xs text-muted-foreground transition-opacity',
            pinnedActions ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          )}
        >
          {item.timestamp > 0 && (
            <span className="font-mono text-[11px] leading-none text-muted-foreground/70">
              {formatMessageTime(item.timestamp)}
            </span>
          )}
        </div>
      )}
    </div>
  );
});
