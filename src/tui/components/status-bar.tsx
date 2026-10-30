import React, { useMemo, useState, useEffect } from 'react';
import { Box, Text, useStdout } from 'ink';
import type { TaskDetail, ActiveWorkerInfo, ContextUsage } from '@/types/index';
import type { Subscribable } from '@/infra/state/subscribable';
import { useWayangState } from '@/tui/hooks/use-wayang-state';
import { CONTEXT_USAGE_STATE_PATH } from '@/client/remote-supervisor';
import { theme } from '@/tui/theme';

/** Hard cap for the context segment — the rest of the line yields to it. */
export const CONTEXT_SEGMENT_MAX_WIDTH = 22;

/** Compact a token count: raw below 1k, "12.3k" below 1M, "1.2M" above. */
function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) {
    return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/**
 * Format the persistent context segment, e.g. "ctx 12.3k/100k (12%)".
 * Percent is rounded to integer and not clamped to 100. Output is capped
 * at CONTEXT_SEGMENT_MAX_WIDTH.
 */
export function formatContextUsage(usedTokens: number, contextWindowTokens: number): string {
  const percent = contextWindowTokens > 0 ? Math.round((usedTokens / contextWindowTokens) * 100) : 0;
  let text = `ctx ${formatTokenCount(usedTokens)}/${formatTokenCount(contextWindowTokens)} (${percent}%)`;
  if (text.length > CONTEXT_SEGMENT_MAX_WIDTH) {
    text = text.slice(0, CONTEXT_SEGMENT_MAX_WIDTH);
  }
  return text;
}

/**
 * Color for the context segment: error near-full (>= 0.9), warning from 70%,
 * default subtle color otherwise.
 */
export function contextUsageColor(ratio: number): string | undefined {
  if (!Number.isFinite(ratio)) return undefined;
  if (ratio >= 0.9) return theme.baseToken.color.error;
  if (ratio >= 0.7) return theme.baseToken.color.warning;
  return undefined;
}

export interface StatusSegmentsInput {
  pendingCount: number;
  activeCount: number;
  workerLabels: Array<{ label: string; elapsed: number }>;
  contextUsage?: ContextUsage | null;
  /** Terminal width in columns. */
  terminalCols?: number;
}

export interface StatusSegments {
  /** Task counters, or "idle" when nothing is queued or running. */
  countsText: string;
  /** Worker rows truncated to whatever width remains after counts + context. */
  workerTexts: string[];
  /** Context segment — always complete, capped at CONTEXT_SEGMENT_MAX_WIDTH. */
  contextText: string;
  /** Color for the context segment (undefined = default subtle). */
  contextColor: string | undefined;
}

/**
 * Fit worker rows into `budget` chars: keep whole rows while they fit,
 * hard-truncate only the row that overflows, drop the rest.
 */
function fitWorkerRows(
  rows: Array<{ label: string; elapsed: number }>,
  budget: number,
): string[] {
  if (budget <= 0) return [];
  const fitted: string[] = [];
  let used = 0;
  for (const row of rows) {
    const text = `${row.label} (${row.elapsed}s)`;
    const sep = fitted.length > 0 ? 3 : 0; // ' · '
    if (used + sep + text.length <= budget) {
      fitted.push(text);
      used += sep + text.length;
      continue;
    }
    const remaining = budget - used - sep;
    if (remaining > 0) fitted.push(text.slice(0, remaining));
    break;
  }
  return fitted;
}

/**
 * Lay out the status line. The context segment is laid out first and never
 * truncated for workers — when the line is too long the worker rows absorb
 * the overflow.
 */
export function buildStatusSegments(input: StatusSegmentsInput): StatusSegments {
  const { pendingCount, activeCount, workerLabels, contextUsage, terminalCols = 80 } = input;

  const parts: string[] = [];
  if (pendingCount > 0) parts.push(`pending tasks:${pendingCount}`);
  if (activeCount > 0) parts.push(`active workers:${activeCount}`);
  // Always non-empty — the status bar never disappears when idle.
  const countsText = parts.length > 0 ? parts.join(' │ ') : 'idle';

  const contextText = contextUsage
    ? formatContextUsage(contextUsage.usedTokens, contextUsage.contextWindowTokens)
    : '';

  // Width accounting: padding(2) + ' counts '(counts + 2) + context segment
  // with its ' │ ' separator(3). Whatever remains is the worker budget.
  const contextWidth = contextText ? contextText.length + 3 : 0;
  const workerBudget = Math.max(0, terminalCols - 4 - countsText.length - contextWidth);

  return {
    countsText,
    workerTexts: fitWorkerRows(workerLabels, workerBudget),
    contextText,
    contextColor: contextUsage ? contextUsageColor(contextUsage.ratio) : undefined,
  };
}

export function StatusBar({
  activeWorkers,
  pendingTasks,
  runningTasks,
  controllerAgent,
}: {
  activeWorkers: ActiveWorkerInfo[];
  pendingTasks: TaskDetail[];
  runningTasks: TaskDetail[];
  /** State source for the controller's context usage snapshot. */
  controllerAgent: Subscribable;
}) {
  const [now, setNow] = useState(() => Date.now());

  // Context usage written by ControllerAgent.updateContextUsage (not persisted).
  // The path comes from the shared constant so the literal is not duplicated.
  const contextUsage = useWayangState<ContextUsage | null>(
    controllerAgent, CONTEXT_USAGE_STATE_PATH,
  );

  // Refresh every 5s to update elapsed time
  useEffect(() => {
    if (activeWorkers.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activeWorkers.length]);

  const { stdout } = useStdout();

  const workerRows = useMemo(() => {

    return activeWorkers.map(w => {
      const task = runningTasks.find(t => t.id === w.taskId);
      const elapsed = Math.round((now - w.startedAt) / 1000);
      const label = task ? ((task.title || task.description).slice(0, 20)) : w.taskId.slice(0, 8);
      return { workerId: w.workerId, label, elapsed };
    })
  },
    [activeWorkers, runningTasks, now],
  );

  const segments = useMemo(() => buildStatusSegments({
    pendingCount: pendingTasks.length,
    activeCount: activeWorkers.length,
    workerLabels: workerRows,
    contextUsage,
    terminalCols: stdout?.columns ?? 80,
  }), [pendingTasks.length, activeWorkers.length, workerRows, contextUsage, stdout?.columns]);

  // The row is always rendered — even with no tasks it shows "idle" plus the
  // persistent context segment, so the layout never collapses.
  return (
    <Box paddingX={1} marginTop={0}>
      <Text dimColor> {segments.countsText} </Text>
      {segments.workerTexts.map((text, i) => (
        <React.Fragment key={workerRows[i].workerId}>
          {i > 0 && <Text dimColor> · </Text>}
          <Text dimColor color="blue">{text}</Text>
        </React.Fragment>
      ))}
      {segments.contextText ? (
        <Text dimColor color={segments.contextColor}> │ {segments.contextText}</Text>
      ) : null}
    </Box>
  );
}
