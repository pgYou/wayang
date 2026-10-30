import { z } from 'zod';
import { defineTool, safeExecute } from './common';
import type { WorkerMessageDelivery } from '@/services/task-execute-engine';

export interface ChatWorkerToolDeps {
  sendMessageToWorker: (workerId: string, message: string) => WorkerMessageDelivery;
}

export function chatWorkerTool(deps: ChatWorkerToolDeps) {
  return defineTool({
    description:
      'Send a message to a running worker. Use this to provide additional guidance, ' +
      'correct the worker\'s approach, or ask the worker to check something. ' +
      'The worker reads it at its next step (puppet) or turn boundary (third-party); ' +
      'idle multi-stage workers read it when their next stage starts.',
    parameters: z.object({
      workerId: z.string().describe('ID of the target worker'),
      message: z.string().describe('Message to send to the worker'),
    }),
    execute: safeExecute('chat_worker', async ({ workerId, message }) => {
      const status = deps.sendMessageToWorker(workerId, message);
      if (status === 'not_running') {
        return `[ERROR] Worker ${workerId} is not running (it may have just finished).`;
      }
      if (status === 'queued') {
        return `Message queued for worker ${workerId} — it will be read when the current turn ends or the next stage starts.`;
      }
      return `Message delivered to worker ${workerId} — it will be read at the worker's next step.`;
    }),
  });
}
