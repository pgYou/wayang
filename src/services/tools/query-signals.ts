import { z } from 'zod';
import type { ControllerSignal } from '@/types/index';
import { defineTool, safeExecute } from './common';

export interface QuerySignalsDeps {
  /** Query signals with filter. */
  querySignals: (filter: {
    status?: ControllerSignal['status'];
    source?: ControllerSignal['source'];
    type?: ControllerSignal['type'];
  }) => ControllerSignal[];
}

export function querySignalsTool(deps: QuerySignalsDeps) {
  return defineTool({
    description: 'Query signal history by status, source, or type',
    parameters: z.object({
      status: z.enum(['unread', 'read', 'discarded']).optional().describe('Filter by status'),
      source: z.enum(['user', 'worker', 'system']).optional().describe('Filter by source'),
      type: z.enum(['input', 'completed', 'failed', 'progress', 'cancelled']).optional().describe('Filter by type'),
    }),
    execute: safeExecute('query_signals', async (filter) => {
      const signals = deps.querySignals(filter);
      if (signals.length === 0) return 'No matching signals';
      return signals.map(s =>
        `[${s.status}] ${s.source}/${s.type} ${s.id}: ${JSON.stringify(s.payload).slice(0, 150)}`,
      ).join('\n');
    }),
  });
}
