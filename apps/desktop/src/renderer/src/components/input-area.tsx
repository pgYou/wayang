import { useRef, useState, type KeyboardEvent } from 'react';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';

interface InputAreaProps {
  busy: boolean;
  onSubmit: (text: string) => void;
  onAbort: () => void;
}

/** 输入区：Enter 发送、Shift+Enter 换行；忙时可中止（对应 TUI 的 ESC）。 */
export function InputArea({ busy, onSubmit, onAbort }: InputAreaProps) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  const send = (): void => {
    const text = value.trim();
    if (!text) return;
    onSubmit(text);
    setValue('');
    ref.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
    if (e.key === 'Escape' && busy) {
      onAbort();
    }
  };

  return (
    <div className="border-t border-border bg-surface/60 px-4 py-3">
      <div className="flex items-end gap-2">
        <Textarea
          ref={ref}
          rows={2}
          value={value}
          placeholder="给 Wayang 说点什么…（Enter 发送，Shift+Enter 换行）"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="flex shrink-0 flex-col gap-1.5">
          <Button size="sm" onClick={send} disabled={!value.trim()}>
            发送
          </Button>
          {busy && (
            <Button size="sm" variant="danger" onClick={onAbort}>
              中止
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
