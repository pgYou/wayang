import { useState } from 'react';
import type { InquireQuestion } from '@wayang-ai/protocol';
import { Card, CardHeader, CardContent } from './ui/card';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { Badge } from './ui/badge';

interface InquiryCardProps {
  inquiry: InquireQuestion;
  onAnswer: (answer: string) => void;
}

/** Controller 发起的提问（TUI InquiryPrompt 的桌面版）。 */
export function InquiryCard({ inquiry, onAnswer }: InquiryCardProps) {
  const [text, setText] = useState(inquiry.default ?? '');

  return (
    <div className="border-t border-primary-border bg-primary-soft/40 px-4 py-3">
      <Card className="gap-3 border-primary-border">
        <CardHeader>
          <Badge>Controller 提问</Badge>
          {inquiry.type !== 'text' && (
            <span className="text-xs text-muted-foreground">{inquiry.type}</span>
          )}
        </CardHeader>
        <CardContent className="grid gap-2">
          <p className="whitespace-pre-wrap text-sm">{inquiry.message}</p>

          {inquiry.type === 'confirm' && (
            <div className="flex gap-2">
              <Button size="sm" onClick={() => onAnswer('yes')}>是</Button>
              <Button size="sm" variant="outline" onClick={() => onAnswer('no')}>否</Button>
            </div>
          )}

          {inquiry.type === 'select' && (
            <div className="flex flex-wrap gap-2">
              {(inquiry.options ?? []).map((option) => (
                <Button key={option} size="sm" variant="outline" onClick={() => onAnswer(option)}>
                  {option}
                </Button>
              ))}
            </div>
          )}

          {inquiry.type === 'text' && (
            <div className="flex items-end gap-2">
              <Textarea
                rows={2}
                value={text}
                placeholder="输入你的回答…"
                onChange={(e) => setText(e.target.value)}
              />
              <Button size="sm" onClick={() => text.trim() && onAnswer(text.trim())} disabled={!text.trim()}>
                回答
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
