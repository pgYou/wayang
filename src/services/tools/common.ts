import { tool } from 'ai';
import { resolve, relative } from 'node:path';

const MAX_RESULT_CHARS = 8000;

/** Validate that resolved path stays within workspace. */
export function validatePath(resolved: string, workspace: string): string | null {
  const rel = relative(workspace, resolved);
  if (rel.startsWith('..') || resolve(workspace, rel) !== resolved) {
    return `Path escapes workspace: ${resolved} (workspace: ${workspace})`;
  }
  return null;
}

export function truncate(result: string): string {
  if (result.length <= MAX_RESULT_CHARS) return result;
  return result.slice(0, MAX_RESULT_CHARS) + '\n...(truncated)';
}

/**
 * Unified tool execute wrapper:
 * 1. try-catch → error returns [ERROR] msg (no throw to avoid breaking agentLoop)
 * 2. Result truncation → prevent context overflow
 */
export function safeExecute(
  name: string,
  fn: (args: any) => Promise<string>,
): (args: any, _options?: any) => Promise<string> {
  return async (args: any, _options?: any): Promise<string> => {
    try {
      const result = await fn(args);
      return truncate(typeof result === 'string' ? result : JSON.stringify(result));
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
