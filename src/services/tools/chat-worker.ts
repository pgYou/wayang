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
      'idle multi-stage workers read it when their next stage starts. ' +
      'A third-party worker NEVER acts on the message mid-tool-call: it finishes the ' +
      'current turn first, so "queued" can mean a delay of minutes. If the worker has ' +
      'already finished, this tool fails explicitly — inspect its output instead.',
    parameters: z.object({
      workerId: z.string().describe('ID of the target worker'),
      message: z.string().describe('Message to send to the worker'),
    }),
    execute: safeExecute('chat_worker', async ({ workerId, message }) => {
      const status = deps.sendMessageToWorker(workerId, message);
      if (status === 'not_running') {
        return `[ERROR] Worker ${workerId} is not running (it may have just finished).`;
      }
      if (status === 'finished') {
        return `[ERROR] Worker ${workerId} has already finished; message not delivered. ` +
          `Use get_task_detail to inspect its output.`;
      }
      if (status === 'queued') {
        return `Message queued for worker ${workerId} — QUEUED only, not delivered yet: the worker reads it at its ` +
          `next step (puppet), turn boundary (third-party — the current turn, including any running tool call, ` +
          `finishes first) or next stage start (idle). A stuck worker will never reach that point. ` +
          `Verify with get_task_detail before relying on it; ` +
          `if it looks stuck, use cancel_task instead of waiting for this message.`;
      }
      return `Message delivered to worker ${workerId} — it will be read at the worker's next step.`;
    }),
  });
}
