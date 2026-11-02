import { z } from 'zod';
import type { InquireQuestion } from '@/types/index';
import { defineTool, safeExecute } from './common';

export function inquireTool(deps: { inquire: (q: InquireQuestion) => Promise<string> }) {
  return defineTool({
    description:
      'Ask the user a structured question and wait for their response. Use this to clarify ambiguous requests, confirm approach, or let the user choose between options. The tool blocks until the user answers. ' +
      'For "select" questions an "Other" choice is appended automatically so the user can always answer outside the preset options — do not add your own catch-all option. ' +
      'Answers typed via "Other" come back prefixed with "[Other] ".',
    parameters: z.object({
      message: z.string().describe('Question to ask the user'),
      type: z
        .enum(['confirm', 'select', 'text'])
        .describe('Question type: "confirm" for yes/no, "select" for choosing from options, "text" for free-form input'),
      options: z
        .array(z.string())
        .optional()
        .describe('Available choices (required for "select" type). Provide 2-5 clear preset options — an "Other" choice for free-form input is appended automatically'),
      default: z
        .string()
        .optional()
        .describe('Default value or pre-selected option'),
      allowOther: z
        .boolean()
        .optional()
        .describe('"select" only: append an "Other" choice letting the user type a custom answer (default true). Set false to restrict answers to the preset options'),
    }),
    execute: safeExecute('inquire', async (args) => {
      return deps.inquire(args);
    }),
  });
}
