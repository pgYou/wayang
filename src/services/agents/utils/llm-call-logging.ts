/**
 * Payload builder for the controller's `LLM call start` debug line (issue #52).
 *
 * History: this line dumped the full `messages` array at DEBUG level — the
 * entire prompt history once per LLM call — so a long session's `wayang.log`
 * grew with «call count × context length» (32MB across 112 calls in one 15h
 * session, single lines up to 507KB). The default payload is now metadata
 * only; the full (sanitized) messages are gated behind `WAYANG_LOG_PROMPTS=1`
 * for prompt debugging. The gate alone is not enough for a quiet default —
 * the caller must also check the level first so a disabled DEBUG never pays
 * for walking the messages at all.
 */

import type { ModelMessage } from 'ai';
import { homedir } from 'node:os';
import type { Logger } from '@/infra/logger';
import { estimateConversationTokens } from './estimate-tokens';

/** Env switch (WAYANG_LOG_PROMPTS=1|true) that re-enables the full prompt dump. */
export function promptsLoggingEnabled(): boolean {
  const raw = process.env.WAYANG_LOG_PROMPTS;
  return raw === '1' || raw?.toLowerCase() === 'true';
}

/**
 * Level check that tolerates loggers without pino's helper (test doubles):
 * unknown implementations count as enabled so no debug line is silently lost.
 */
export function debugLoggingEnabled(logger: Logger): boolean {
  return typeof logger.isLevelEnabled === 'function' ? logger.isLevelEnabled('debug') : true;
}

/**
 * Build the `LLM call start` payload.
 *
 * Default: metadata only — model, message count, a character-based token
 * estimate. No message content, ever. With `WAYANG_LOG_PROMPTS=1` the full
 * messages are added, sanitized (`sanitizeMessagesForLog`).
 */
export function buildLlmCallStartPayload(
  messages: ModelMessage[],
  messageCount: number,
  model: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    agent: 'controller',
    model,
    messageCount,
    estimatedTokens: estimateConversationTokens(messages),
  };
  if (promptsLoggingEnabled()) {
    payload.messages = sanitizeMessagesForLog(messages);
  }
  return payload;
}

/** Sanitize every message of an LLM call for logging (secrets, home path). */
export function sanitizeMessagesForLog(messages: ModelMessage[]): unknown[] {
  const home = homedir();
  return messages.map((m) => sanitizeForLog(m, home, new Set()) as unknown);
}

/**
 * Redacted value for `Authorization`-style headers — keeps an optional scheme
 * word (`Bearer ` / `Basic ` / `Token `), replaces the credential itself.
 */
const AUTH_ASSIGNMENT =
  /((?:authorization)\s*["']?\s*[:=]\s*["']?)((?:bearer|basic|token)\s+)?([^\s"',;]+)/gi;

/** Redacted value for `apiKey: …` / `token=…` / `password: …` assignments. */
const SECRET_ASSIGNMENT =
  /((?:api[-_]?key|apikey|token|secret|password|passwd)\s*["']?\s*[:=]\s*["']?)([^\s"',;]+)/gi;

/** Bare key material with no label around it (provider key formats). */
const BARE_KEY =
  /\b(?:sk|rk)-[A-Za-z0-9_-]{8,}\b|\btvly-[A-Za-z0-9_-]{10,}\b|\bghp_[A-Za-z0-9]{16,}\b|\bAKIA[0-9A-Z]{16}\b/g;

/** Object keys whose VALUE is a credential, whatever it looks like. */
const SECRET_KEY = /^(?:api[-_]?key|apikey|token|secret|password|passwd|authorization)$/i;

/**
 * Sanitize one string for the log: the user's absolute home path collapses to
 * `~`, labeled credentials (Authorization/apiKey/token/secret/password) and
 * bare provider key material are replaced with `[REDACTED]`. Key names and
 * structure survive — only the secret value goes.
 */
export function sanitizeTextForLog(text: string, homeDir: string): string {
  let out = text;
  if (homeDir.length > 1) {
    out = out.split(homeDir).join('~');
  }
  out = out.replace(AUTH_ASSIGNMENT, '$1$2[REDACTED]');
  out = out.replace(SECRET_ASSIGNMENT, '$1[REDACTED]');
  out = out.replace(BARE_KEY, '[REDACTED]');
  return out;
}

/**
 * Deep-sanitize any log value: strings are redacted in place, arrays/objects
 * are walked (cycle-safe), everything else passes through untouched. Prompt
 * payloads reach here as SDK message objects, so tool-call inputs and
 * tool-result values nested inside get the same treatment.
 */
export function sanitizeForLog(value: unknown, homeDir: string, seen: Set<unknown>): unknown {
  if (typeof value === 'string') return sanitizeTextForLog(value, homeDir);
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return value.map((v) => sanitizeForLog(v, homeDir, seen));
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Key-level check first: a `token:`-shaped KEY marks its value as a
      // credential even when the value itself looks like nothing.
      out[k] = SECRET_KEY.test(k) ? '[REDACTED]' : sanitizeForLog(v, homeDir, seen);
    }
    return out;
  }
  return value;
}
