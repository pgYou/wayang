import { z } from 'zod';
import { defineTool, safeExecute } from './common';

export type RespondInquiryStatus = 'answered' | 'not_found' | 'worker_gone';

export interface RespondInquiryToolDeps {
  respondInquiry: (inquiryId: string, answer: string) => RespondInquiryStatus;
}

export function respondInquiryTool(deps: RespondInquiryToolDeps) {
  return defineTool({
    description:
      'Answer a worker\'s question (from a worker_inquiry signal). The blocked worker resumes ' +
      'with your answer as the tool result. If the decision belongs to the user, ask them first ' +
      'via inquire, then answer here.',
    parameters: z.object({
      inquiryId: z.string().describe('The inquiryId from the worker_inquiry signal'),
      answer: z.string().max(4000).describe('The answer/instruction for the worker. Self-contained — the worker sees only this text.'),
    }),
    execute: safeExecute('respond_inquiry', async ({ inquiryId, answer }) => {
      const status = deps.respondInquiry(inquiryId, answer);
      if (status === 'not_found') {
        return `[ERROR] Inquiry ${inquiryId} not found or already resolved (it may have timed out — the worker continued on its own).`;
      }
      if (status === 'worker_gone') {
        return `[ERROR] Inquiry ${inquiryId} belongs to a worker that is no longer running. The answer could not be delivered.`;
      }
      return `Answer delivered to the asking worker (inquiry ${inquiryId}).`;
    }),
  });
}
