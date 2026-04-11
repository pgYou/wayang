import type { Logger } from '@/infra/logger';

/**
 * Extract a concise, human-readable error message from Vercel AI SDK errors.
 *
 * AI SDK wraps provider errors in `AI_RetryError` → `AI_APICallError`.
 * This function drills into these wrappers to surface the useful bits:
 * status code, provider message, and retry context.
 */
export function formatLlmError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);

  const name = err.name ?? err.constructor?.name ?? 'Error';

  // AI_RetryError wraps multiple API call attempts
  if (name === 'AI_RetryError' || name === 'RetryError') {
    const retryErr = err as any;
    const lastError = retryErr.lastError;
    if (lastError) {
      const inner = formatApiCallError(lastError);
      const attempts = retryErr.errors?.length ?? '?';
      return `LLM request failed after ${attempts} attempts: ${inner}`;
    }
    return `LLM request failed: ${err.message}`;
  }

  // Direct AI_APICallError
  if (name === 'AI_APICallError' || name === 'APICallError') {
    return `LLM API error: ${formatApiCallError(err)}`;
  }

  // Generic fallback
  return err.message || String(err);
}

/** Format a single API call error (typically AI_APICallError). */
function formatApiCallError(err: any): string {
  const status = err.statusCode;
  const body = err.responseBody;

  // Try to parse JSON response body for provider message
  let providerMsg = '';
  if (typeof body === 'string' && body) {
    try {
      const parsed = JSON.parse(body);
      providerMsg = parsed?.error?.message ?? parsed?.message ?? '';
    } catch {
      providerMsg = body.slice(0, 200);
    }
  }

  if (status && providerMsg) {
    return `[${status}] ${providerMsg}`;
  }
  if (status) {
    return `[${status}] ${err.message ?? 'Unknown error'}`;
  }
  return providerMsg || err.message || String(err);
}

/** Log an LLM error with structured fields + concise message. */
export function logLlmError(logger: Logger, err: unknown, context?: string): string {
  const friendly = formatLlmError(err);
  const logFields: Record<string, unknown> = { error: friendly };

  if (err instanceof Error) {
    const e = err as any;
    if (e.statusCode) logFields.statusCode = e.statusCode;
    if (e.lastError?.statusCode) logFields.statusCode = e.lastError.statusCode;
    if (e.errors?.length) logFields.attempts = e.errors.length;
  }

  if (context) logFields.context = context;
  logger.error(logFields, friendly);
  return friendly;
}
