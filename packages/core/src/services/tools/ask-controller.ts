import { z } from 'zod';
import { defineTool, safeExecute } from './common';

/**
 * Deps are injected by the engine per worker run: `ask` enqueues the
 * worker_inquiry signal, blocks on the blocking-request registry and returns
 * the tool-result text (the controller's answer, or a timeout/abort notice).
 */
export interface AskControllerToolDeps {
  ask: (question: string, context?: string) => Promise<string>;
}

export function askControllerTool(deps: AskControllerToolDeps) {
  return defineTool({
    description:
      'Ask the controller a question and WAIT for the answer. Use ONLY when you are blocked: ' +
      'execution cannot continue as instructed (contradiction, missing resource, unexpected state), ' +
      'or continuing would risk significant wasted work. Do NOT use it for decisions you can make ' +
      'yourself — decide those autonomously and report via update_progress / done.',
    parameters: z.object({
      question: z.string().max(500).describe('The specific question you need answered to proceed. Be concise and self-contained.'),
      context: z.string().max(1000).optional().describe('What you have tried and where you are stuck, so the controller can answer precisely.'),
    }),
    execute: safeExecute('ask_controller', async ({ question, context }) => {
      return deps.ask(question, context);
    }),
  });
}
