import { memo, useMemo, useState } from 'react';
import { XMarkdown, type ComponentProps } from '@ant-design/x-markdown';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { Button } from '@/renderer/shared/components/ui/button';
import { cn } from '@/renderer/shared/lib/cn';
// 第三方基础样式与主题随模块引入，不再堆进 globals.css。
import '@ant-design/x-markdown/dist/x-markdown.css';
import '@ant-design/x-markdown/themes/light.css';
import './x-markdown-tiny.scss';

interface MarkdownContentProps {
  content: string;
  /** 流式输出中：x-markdown 会按未闭合 token 做缓存，避免半截语法闪烁。 */
  streaming?: boolean;
  className?: string;
}

/** 围栏代码块：语言头 + 一键复制。注入 x-markdown 的 `code` 组件槽。 */
function CodeBlock({ block, lang, children, className }: ComponentProps) {
  const [copied, setCopied] = useState(false);

  // 行内代码（非 block）沿用 x-markdown 默认渲染，样式由 x-markdown-tiny 控制。
  if (!block) return <code className={className}>{children}</code>;

  const text = typeof children === 'string' ? children : String(children ?? '');
  const onCopy = (): void => {
    void navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border bg-grey-2">
      <div className="flex items-center justify-between border-b border-border px-3 py-1 text-xs text-muted-foreground">
        <span className="font-mono">{lang || 'text'}</span>
        <Button
          variant="ghost"
          size="xs"
          onClick={onCopy}
          title="复制代码"
          className="gap-1 py-1"
        >
          {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
          <span>{copied ? '已复制' : '复制'}</span>
        </Button>
      </div>
      <pre className="m-0 overflow-x-auto p-3 font-mono text-xs leading-relaxed text-foreground">
        <code>{text}</code>
      </pre>
    </div>
  );
}

/**
 * AI 输出文本渲染：x-markdown + x-markdown-tiny 主题，紧凑易读。
 */
export const MarkdownContent = memo(function MarkdownContent({
  content,
  streaming = false,
  className,
}: MarkdownContentProps) {
  const components = useMemo(() => ({ code: CodeBlock }), []);

  return (
    <XMarkdown
      openLinksInNewTab
      streaming={streaming ? { hasNextChunk: true } : undefined}
      components={components}
      className={cn('x-markdown-light x-markdown-tiny', className)}
    >
      {content}
    </XMarkdown>
  );
});
