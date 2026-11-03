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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberate relaxation boundary: each tool's zod-parsed arg shape is only known at its own definition site (see file comment)
  fn: (args: any, options?: any) => Promise<string>,
  options?: { maxResultChars?: number },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors fn's relaxation boundary so the wrapper stays assignable to defineTool's execute
): (args: any, options?: any) => Promise<string> {
  const maxChars = options?.maxResultChars ?? MAX_RESULT_CHARS;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pass-through of fn's relaxed signature
  return async (args: any, callOptions?: any): Promise<string> => {
    try {
      const result = await fn(args, callOptions);
      return truncate(typeof result === 'string' ? result : JSON.stringify(result), maxChars);
    } catch (err) {
      return `[ERROR] ${name}: ${(err as { message?: string }).message ?? String(err)}`;
    }
  };
}

/**
 * Wrapper for ai.tool() to bypass SDK v6 type inference issues.
 * Runtime behavior is identical; only TS types are relaxed.
 */
export function defineTool(def: {
  description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- zod schema object passed through to the SDK's inputSchema
  parameters: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- per-tool zod arg shape, mirrors safeExecute's relaxation boundary
  execute: (args: any, options?: any) => Promise<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- returned tool feeds SDK call sites that expect Tool<any, any>
}): any {
  const { parameters, ...rest } = def;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Vercel AI SDK inputSchema type mismatch (documented above)
  return tool({ ...rest, inputSchema: parameters } as any);
}
