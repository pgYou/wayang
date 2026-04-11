import { Box, Text } from 'ink';
import type { DisplayItem, DisplaySection } from '@/tui/types/display-item';
import { theme } from '@/tui/theme';
import { TOOL_DETAIL_MAX_LENGTH, LONG_MSG_MAX_LENGTH } from './constants';

/** Render an assistant step with all its sections (content, reasoning, tool calls/results). */
export function AssistantStepRow({ item }: { item: DisplayItem }) {
  const sections = item.sections ?? [];

  // No sections — fallback to simple text row
  if (sections.length === 0) {
    return (
      <Box>
        <Text color={theme.assistant.prefixColor} bold>
          {theme.assistant.prefix}{' '}
        </Text>
        <Text>{item.content}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {sections.map((sec) => {
        const key = `${sec.kind}-${sec.id}`;
        switch (sec.kind) {
          case 'reasoning':
            return <ReasoningRow key={key} section={sec} />;
          case 'content':
            return <ContentRow key={key} section={sec} />;
          case 'tool_call':
            return <ToolCallRow key={key} section={sec} />;
          case 'tool_result':
            return <ToolResultRow key={key} section={sec} />;
        }
      })}
    </Box>
  );
}

/** Reasoning / extended thinking section. */
function ReasoningRow({ section }: { section: DisplaySection }) {
  return (
    <Box>
      <Text color={theme.meta.color}>{theme.meta.prefix} </Text>
      <Text dimColor>thinking: {section.text.slice(0, LONG_MSG_MAX_LENGTH)}</Text>
    </Box>
  );
}

/** Main text content section. */
function ContentRow({ section }: { section: DisplaySection }) {
  return (
    <Box>
      <Text color={theme.assistant.prefixColor} bold>
        {theme.assistant.prefix}{' '}
      </Text>
      <Text>{section.text}</Text>
    </Box>
  );
}

/** Tool call section. */
function ToolCallRow({ section }: { section: DisplaySection }) {
  return (
    <Box>
      <Text color={theme.meta.color}>{theme.meta.prefix} </Text>
      <Text color={theme.toolUse.color}>
        {theme.toolUse.callIcon} {section.toolName}: {section.text.slice(0, TOOL_DETAIL_MAX_LENGTH)}
      </Text>
    </Box>
  );
}

/** Tool result section. */
function ToolResultRow({ section }: { section: DisplaySection }) {
  const color = section.isError ? theme.baseToken.color.error : theme.toolUse.color;

  return (
    <Box>
      <Text color={theme.meta.color}>{theme.meta.prefix} </Text>
      <Text color={color}>
        {theme.toolUse.resultIcon} {section.toolName}: {section.text.slice(0, TOOL_DETAIL_MAX_LENGTH)}
      </Text>
    </Box>
  );
}
