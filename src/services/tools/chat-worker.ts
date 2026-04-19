import { z } from 'zod';
import { defineTool, safeExecute } from './common';

export interface ChatWorkerToolDeps {
  sendMessageToWorker: (workerId: string, message: string) => boolean;
}

export function chatWorkerTool(deps: ChatWorkerToolDeps) {
  return defineTool({
    description:
      'Send a message to a running worker. Use this to provide additional guidance, ' +
      'correct the worker\'s approach, or ask the worker to check something. ' +
      'The worker will receive the message next time it calls check_controller_messages.',
    parameters: z.object({
      workerId: z.string().describe('ID of the target worker'),
      message: z.string().describe('Message to send to the worker'),
    }),
    execute: safeExecute('chat_worker', async ({ workerId, message }) => {
      const sent = deps.sendMessageToWorker(workerId, message);
      if (!sent) return `[ERROR] Worker ${workerId} not found or not running.`;
      return `Message delivered to worker ${workerId}.`;
    }),
  });
}
