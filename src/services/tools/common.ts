import { tool } from 'ai';
import { resolve, relative } from 'node:path';

const MAX_RESULT_CHARS = 8000;

/** Check whether a resolved path is inside the workspace directory. */
export function isInsideWorkspace(resolved: string, workspace: string): boolean {
  const rel = relative(workspace, resolved);
  return !rel.startsWith('..') && resolve(workspace, rel) === resolved;
}

export function truncate(result: string, maxChars: number = MAX_RESULT_CHARS): string {
  if (result.length <= maxChars) return result;
  return result.slice(0, maxChars) + '\n...(truncated)';
}

/**
 * Unified tool execute wrapper:
 * 1. try-catch → error returns [ERROR] msg (no throw to avoid breaking agentLoop)
 * 2. Result truncation → prevent context overflow
 *
 * The SDK's second execute argument (options, incl. toolCallId) is passed
 * through to `fn` — tools that need their own toolCallId can read it.
 *
 * `maxResultChars` raises the cap for tools the caller explicitly asked to
 * return in full (worker transcripts). Defaults preserve the 8000-char guard.
 */
export function safeExecute(
  name: string,
  fn: (args: any, options?: any) => Promise<string>,
  options?: { maxResultChars?: number },
): (args: any, options?: any) => Promise<string> {
  const maxChars = options?.maxResultChars ?? MAX_RESULT_CHARS;
  return async (args: any, callOptions?: any): Promise<string> => {
    try {
      const result = await fn(args, callOptions);
      return truncate(typeof result === 'string' ? result : JSON.stringify(result), maxChars);
    } catch (err: any) {
      return `[ERROR] ${name}: ${err.message ?? String(err)}`;
    }
  };
}

/**
 * Wrapper for ai.tool() to bypass SDK v6 type inference issues.
 * Runtime behavior is identical; only TS types are relaxed.
 */
export function defineTool(def: {
  description: string;
  parameters: any;
  execute: (args: any, options?: any) => Promise<string>;
}): any {
  const { parameters, ...rest } = def;
  return tool({ ...rest, inputSchema: parameters } as any); // Vercel AI SDK inputSchema type mismatch
}
