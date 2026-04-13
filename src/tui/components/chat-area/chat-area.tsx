import React, { useMemo } from 'react';
import { Box, Static, Text } from 'ink';
import type { DisplayItem } from '@/tui/types/display-item';
import { theme } from '@/tui/theme';
import { ItemRow } from './item-row';
import { StreamingSpinner } from './streaming-spinner';

interface ChatAreaProps {
  items: DisplayItem[];
  /** Whether the assistant is currently streaming a response. */
  busy?: boolean;
  /** Streaming entries rendered with spinner prefix. */
  streamingItems?: DisplayItem[];
  /** Usable content width (accounts for padding). */
  contentWidth?: number;
}

/** Whether to show a gap before this item (block boundary). */
function shouldShowGap(prev: DisplayItem | null, _current: DisplayItem): boolean {
  if (!prev) return false;
  return true;
}

const ChatArea = React.memo(function ChatArea({ items, busy, streamingItems, contentWidth }: ChatAreaProps) {
  const width = contentWidth ?? 78;

  // Read items → Static (render once, terminal scrollback).
  // Unread items → dynamic (may change or be consumed).
  const { staticItems, dynamicItems } = useMemo(() => {
    const read = items.filter(i => i.read);
    const unread = items.filter(i => !i.read);
    return { staticItems: read, dynamicItems: unread };
  }, [items]);

  return (
    <>
      <Static key="chat" items={staticItems}>
        {(item, idx) => (
          <Box
            key={item.id}
            flexDirection="column"
            paddingX={1}
            marginTop={shouldShowGap(idx > 0 ? staticItems[idx - 1] : null, item) ? theme.spacing.blockGap : 0}
          >
            <ItemRow item={item} contentWidth={width} />
          </Box>
        )}
      </Static>

      {(streamingItems?.length || busy) && (
        <Box paddingX={1} marginTop={items.length > 0 ? theme.spacing.blockGap : 0}>
          <StreamingSpinner />
          {streamingItems?.[0].content && <Text>{streamingItems[0].content}</Text>}
        </Box>
      )}

      {dynamicItems.length > 0 && (
        <Box flexDirection="column" paddingX={3} marginTop={1} marginBottom={1}>
          <Box justifyContent="flex-start">
            <Text color={theme.baseToken.color.textSubtle} dimColor>··· waiting for process ···</Text>
          </Box>
          {dynamicItems.map((item) => (
            <Box key={item.id} flexDirection="column" marginTop={shouldShowGap(null, item) ? theme.spacing.blockGap : 0}>
              <ItemRow item={item} contentWidth={width} />
            </Box>
          ))}
        </Box>
      )}
    </>
  );
});

export { ChatArea };
