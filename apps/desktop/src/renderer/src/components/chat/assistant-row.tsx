import { useState } from 'react';
import type { DisplayItem, DisplaySection } from '../../lib/display';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/cn';

function ToolSection({ section }: { section: DisplaySection }) {
  const [open, setOpen] = useState(false);
  const isError = section.kind === 'tool_result' && section.isError;
  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex max-w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-left text-xs transition-colors',
          isError
            ? 'border-danger/40 bg-danger-soft text-danger'
            : 'border-primary-border bg-primary-soft/60 text-primary-strong hover:bg-primary-soft',
        )}
      >
        <span className="font-medium">
          {section.kind === 'tool_call' ? '调用' : '结果'} · {section.toolName ?? 'tool'}
        </span>
        <span className="text-muted-foreground">{open ? '收起' : '展开'}</span>
      </button>
      {open && (
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
          {section.text}
        </pre>
      )}
    </div>
  );
}

/** Controller 的回复：正文 + 可展开的 reasoning / 工具调用区块。 */
export function AssistantRow({ item }: { item: DisplayItem }) {
  const sections = item.sections ?? [];
  const content = sections.find((s) => s.kind === 'content');
  const reasoning = sections.find((s) => s.kind === 'reasoning');
  const tools = sections.filter((s) => s.kind === 'tool_call' || s.kind === 'tool_result');

  return (
    <div className="px-4">
      <div className="max-w-[92%] rounded-2xl rounded-tl-md border border-border bg-surface px-3.5 py-2.5 shadow-[0_1px_2px_rgba(30,60,120,0.06)]">
        {reasoning && (
          <details className="group mb-2">
            <summary className="cursor-pointer select-none text-xs text-muted-foreground group-open:text-primary-strong">
              思考过程
            </summary>
            <p className="mt-1 whitespace-pre-wrap border-l-2 border-primary-border pl-2 text-xs italic text-muted-foreground">
              {reasoning.text}
            </p>
          </details>
        )}
        {content && <p className="whitespace-pre-wrap text-sm leading-relaxed">{content.text}</p>}
        {tools.map((section) => (
          <ToolSection key={`${section.kind}-${section.id}`} section={section} />
        ))}
        {item.interrupted && (
          <Badge tone="danger" className="mt-2">
            已被中断
          </Badge>
        )}
      </div>
    </div>
  );
}
