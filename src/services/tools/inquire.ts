import { z } from 'zod';
import type { InquireQuestion } from '@/types/index';
import { defineTool, safeExecute } from './common';

export function inquireTool(deps: { inquire: (q: InquireQuestion) => Promise<string> }) {
  return defineTool({
    description:
      'Ask the user a structured question and wait for their response. Use this to clarify ambiguous requests, confirm approach, or let the user choose between options. The tool blocks until the user answers.',
    parameters: z.object({
      message: z.string().describe('Question to ask the user'),
      type: z
        .enum(['confirm', 'select', 'text'])
        .describe('Question type: "confirm" for yes/no, "select" for choosing from options, "text" for free-form input'),
      options: z
        .array(z.string())
        .optional()
        .describe('Available choices (required for "select" type)'),
      default: z
        .string()
        .optional()
        .describe('Default value or pre-selected option'),
    }),
    execute: safeExecute('inquire', async (args) => {
      return deps.inquire(args);
    }),
  });
}
