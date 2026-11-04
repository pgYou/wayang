import React, { useMemo } from 'react';
import { Box, Static, Text } from 'ink';
import type { DisplayItem } from '@/tui/types/display-item';
import { theme } from '@/tui/theme';
import { buildChatLookups } from '@/tui/utils/chat-lookups';
import { EMPTY_WORKSPACE_CONTEXT, type WorkspaceDisplayContext } from '@/tui/utils/workspace-display';
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
  /**
   * Session workspace context, used to label the workspace an `add_task` row
   * dispatched into. Omitted means "unknown", i.e. only declarations are shown.
   */
  workspace?: WorkspaceDisplayContext;
}

/**
 * Extra left indent (columns) for the pending/unread block inside its
 * paddingX={1} container. The block therefore gets 2 columns less than the
 * other regions, and its rows are measured against that reduced width so they
 * never exceed the terminal and wrap onto a stray extra line.
 */
const PENDING_INDENT = theme.secondary.indent;

/** Whether to show a gap before this item (block boundary). */
function shouldShowGap(prev: DisplayItem | null, _current: DisplayItem): boolean {
  if (!prev) return false;
  return true;
}

const ChatArea = React.memo(function ChatArea({
  items,
  busy,
  streamingItems,
  contentWidth,
  workspace = EMPTY_WORKSPACE_CONTEXT,
}: ChatAreaProps) {
  const width = contentWidth ?? 78;

  // Read items → Static (render once, terminal scrollback).
  // Unread items → dynamic (may change or be consumed).
  const { staticItems, dynamicItems } = useMemo(() => {
    const read = items.filter(i => i.read);
    const unread = items.filter(i => !i.read);
    return { staticItems: read, dynamicItems: unread };
  }, [items]);

  // Cross-row context (permission request by id, worker by id). Static rows
  // render once with the lookups as of that moment — the rows they refer to
  // always come earlier in the conversation, so they are already present.
  const lookups = useMemo(() => buildChatLookups(items, workspace), [items, workspace]);

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
            <ItemRow item={item} contentWidth={width} lookups={lookups} />
          </Box>
        )}
      </Static>

      {/*
        The live region (streaming row + pending block) is one column container:
        Ink's <Box> defaults to flexDirection="row", so without this the two
        blocks become horizontal siblings and the pending hint is laid out to
        the right of the streaming text / spinner instead of on its own line.
      */}
      <Box flexDirection="column">
        <Box paddingX={1} marginTop={items.length > 0 ? theme.spacing.blockGap : 0}>
          <StreamingSpinner spinning={busy} />
          {/* Own column so wrapped / multi-line streaming text keeps a stable
              left edge (right of the spinner) instead of sharing its row. */}
          <Box flexDirection="column" flexGrow={1}>
            {streamingItems?.[0]?.content && <Text>{streamingItems[0].content}</Text>}
          </Box>
        </Box>

        {dynamicItems.length > 0 && (
          <Box flexDirection="column" paddingX={1} marginTop={theme.spacing.blockGap} marginBottom={1}>
            <Box marginLeft={PENDING_INDENT} justifyContent="flex-start">
              <Text color={theme.baseToken.color.textSubtle} dimColor>··· waiting for process ···</Text>
            </Box>
            {dynamicItems.map((item, idx) => (
              <Box
                key={item.id}
                flexDirection="column"
                marginLeft={PENDING_INDENT}
                marginTop={shouldShowGap(idx > 0 ? dynamicItems[idx - 1] : null, item) ? theme.spacing.blockGap : 0}
              >
                <ItemRow item={item} contentWidth={width - PENDING_INDENT} lookups={lookups} />
              </Box>
            ))}
          </Box>
        )}
      </Box>
    </>
  );
});

export { ChatArea };
