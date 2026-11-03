import { Box, Text, useStdout } from 'ink';
import { theme } from '@/tui/theme';
import { renderShortcutSpans } from '@/tui/utils/shortcut-catalog';
import type { ShortcutSpan, ShortcutSpanRole } from '@/tui/utils/shortcut-catalog';
import { stringWidth, truncateToWidth } from '@/tui/utils/text-width';

/** Ink Text props for one span role — the cheat sheet's style sheet. */
export interface ShortcutSpanStyle {
  color?: string;
  bold?: boolean;
  dimColor?: boolean;
}

/**
 * Role → style. Keys are the anchor of each line — accent + bold, the same
 * treatment the welcome banner and the assistant prefix give their anchors.
 * Actions (with the `when` parenthetical) stay dim; group headings take the
 * plain bold used for lead-ins elsewhere (inquiry prompts, permission rows).
 * No background fills — they smear in a terminal.
 */
export const SHORTCUT_SPAN_STYLES: Record<ShortcutSpanRole, ShortcutSpanStyle> = {
  heading: { bold: true },
  key: { color: theme.baseToken.color.accent, bold: true },
  action: { dimColor: true },
};

/**
 * Cut one span line to `maxWidth` display columns, marking the cut with an
 * ellipsis whether it falls inside a span or between spans. The budget is
 * computed on the plain text — styling carries no columns, so adding styles
 * never changes the truncation.
 */
export function truncateSpanLine(spans: ShortcutSpan[], maxWidth: number): ShortcutSpan[] {
  if (maxWidth <= 0) return [];
  if (stringWidth(spans.map(span => span.text).join('')) <= maxWidth) return spans;

  const out: ShortcutSpan[] = [];
  let used = 0;
  for (const span of spans) {
    const remaining = maxWidth - used;
    const width = stringWidth(span.text);
    // Keep a span only when a column would survive after it — a span that
    // fills the line exactly must give up its last column to the ellipsis.
    if (width < remaining) {
      out.push(span);
      used += width;
      continue;
    }
    if (remaining <= 1) {
      // One column left: the ellipsis alone says there was more.
      out.push({ ...span, text: '…' });
    } else {
      // The span straddles the cut; the reserved column becomes the ellipsis.
      out.push({ ...span, text: truncateToWidth(span.text, remaining - 1) });
    }
    return out;
  }
  return out;
}

/**
 * The /shortcut overlay: the catalog with a key/action hierarchy — keys
 * emphasized, actions dimmed. Mirrors the bordered box OverlayPanel draws
 * for plain text overlays, and hard-truncates every line to the box's
 * content width so a line never wraps on narrow terms.
 */
export function ShortcutOverlay() {
  const { stdout } = useStdout();
  const terminalCols = stdout?.columns ?? 80;
  // Content columns inside the bordered box: terminal − 2 border − 2 padding.
  const contentWidth = Math.max(terminalCols - 4, 1);

  return (
    <Box paddingX={1} borderStyle="single" borderColor={theme.baseToken.color.border} flexDirection="column">
      {renderShortcutSpans().map((line, i) => (
        <Box key={i}>
          {truncateSpanLine(line, contentWidth).map((span, j) => (
            <Text key={j} {...SHORTCUT_SPAN_STYLES[span.role]}>{span.text}</Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}
