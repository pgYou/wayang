import { Box, Text } from 'ink';
import type { DisplayItem, DisplaySection } from '@/tui/types/display-item';
import { theme } from '@/tui/theme';
import { summarizePermissionResolution } from '@/tui/utils/permission-summary';
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

  // Pair tool results by toolCallId — permission resolution rows use the
  // paired result to detect calls that did not take effect.
  const resultSections = new Map<string, DisplaySection>();
  for (const sec of sections) {
    if (sec.kind === 'tool_result') resultSections.set(sec.id, sec);
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
            return sec.toolName === 'respond_permission'
              ? <PermissionResolutionRow key={key} section={sec} result={resultSections.get(sec.id)} />
              : <ToolCallRow key={key} section={sec} />;
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

/** respond_permission tool call — approved/denied state instead of raw JSON. */
function PermissionResolutionRow({ section, result }: { section: DisplaySection; result?: DisplaySection }) {
  const summary = summarizePermissionResolution(
    {
      toolCallId: section.id,
      toolName: section.toolName ?? 'respond_permission',
      arguments: section.text,
    },
    TOOL_DETAIL_MAX_LENGTH,
    result ? { text: result.text, isError: result.isError } : undefined,
  );
  const color = summary.state === 'approved'
    ? theme.permission.approvedColor
    : theme.permission.deniedColor;
  const prefix = summary.state === 'approved'
    ? theme.permission.approvedPrefix
    : theme.permission.deniedPrefix;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.meta.color}>{theme.meta.prefix} </Text>
        <Text color={color}>{prefix} {summary.label}</Text>
      </Box>
      {summary.detail && (
        <Box marginLeft={3}>
          <Text dimColor color={color}>{summary.detail}</Text>
        </Box>
      )}
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
