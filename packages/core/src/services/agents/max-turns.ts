/**
 * Single resolution point for every maxTurns-style turn/step cap (v0.9.7):
 * puppet workers and claude-code both resolve their configured cap here, so
 * the semantics cannot drift between worker types.
 *
 * Semantics (maintainer decision, 0.9.7):
 * - unset (undefined / null) → Infinity — no limit;
 * - invalid (<=0, non-integer, NaN, or beyond the safe bound) → Infinity too,
 *   but with ONE warn — never an error, never a blocker;
 * - a positive integer within the bound → the value itself.
 */

import type { Logger } from '@/infra/logger';

/**
 * Safe upper bound for a configured cap. A value beyond it is treated as a
 * typo (or a deliberately absurd config), not a real limit.
 */
export const MAX_SAFE_TURNS = 1_000_000;

/** Which configured value a caller is resolving — used in the warn text. */
export type MaxTurnsSource = 'worker.maxTurns' | 'maxTurns';

/**
 * Resolve a configured turn cap into an effective limit.
 * Returns Infinity (= unlimited) for unset and for invalid values; invalid
 * values additionally produce one warn when a logger is given.
 */
export function resolveMaxTurns(
  configValue: unknown,
  logger?: Logger,
  source: MaxTurnsSource = 'maxTurns',
): number {
  if (configValue === undefined || configValue === null) return Infinity;
  if (
    typeof configValue === 'number'
    && Number.isInteger(configValue)
    && configValue > 0
    && configValue <= MAX_SAFE_TURNS
  ) {
    return configValue;
  }
  logger?.warn(
    { source, value: configValue },
    `Invalid ${source} — treating the worker as unlimited (no turn limit)`,
  );
  return Infinity;
}
