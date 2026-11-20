import { z } from 'zod';
import { defineTool, safeExecute } from './common';

export interface DisposeWorkerToolDeps {
  /** Dispose a worker by id (handles both running and idle). Returns true if found. */
  disposeWorker: (workerId: string) => boolean;
}

/**
 * Tool for manually disposing an idle multi-stage worker. Idle workers are
 * normally reaped after a timeout, but the controller may decide earlier that
 * a worker's context is no longer needed.
 */
export function disposeWorkerTool(deps: DisposeWorkerToolDeps) {
  return defineTool({
    description:
      'Dispose an idle (parked) multi-stage worker that you no longer need. ' +
      'Frees its concurrency slot immediately. Only relevant for workers you ' +
      'previously created with multiStage=true and did not assign a follow-up task to.',
    parameters: z.object({
      workerId: z.string().describe('ID of the idle worker to dispose'),
    }),
    execute: safeExecute('dispose_worker', async ({ workerId }: { workerId: string }) => {
      const ok = deps.disposeWorker(workerId);
      if (!ok) return `Worker ${workerId} not found.`;
      return `Worker ${workerId} disposed.`;
    }),
  });
}
