import type { Supervisor } from '@/services/supervisor';
import { EEntryType, ESystemSubtype } from '@/types/index';
import { generateId } from '@/utils/id';
import { nowISO } from '@/utils/time';
import { formatLlmError } from '@/utils/llm-error';

/**
 * Main Controller Loop
 *
 * Continuously consumes unread signals from the queue, passes them to ControllerAgent.
 * Immediately starts next round after processing; waits when no signals are available.
 */
export async function mainControllerLoop(supervisor: Supervisor): Promise<void> {
  const { signalQueue, controllerAgent, ctx } = supervisor;

  ctx.logger.info('Main controller loop started');

  while (!ctx.abortController.signal.aborted) {
    try {

      // Check if context needs compaction
      if (controllerAgent.needsCompaction()) {
        ctx.logger.info('Context full, triggering compaction');
        await controllerAgent.performCompaction();
      }

      const signals = signalQueue.dequeueUnread();
      ctx.logger.debug('loop start with signals:' + JSON.stringify(signals));

      if (signals.length > 0) {
        ctx.logger.info({ count: signals.length, sigIds: signals.map(s => s.id), sigTypes: signals.map(s => `${s.source}/${s.type}`) }, 'Processing signals');

        // Streaming entries and conversation persistence are managed inside run()
        await controllerAgent.run(signals);
        ctx.logger.debug('loop end');
      }

      await signalQueue.waitForSignal();
    } catch (err: any) {
      if (ctx.abortController.signal.aborted) break;
      const friendly = formatLlmError(err);
      ctx.logger.error({ error: friendly, statusCode: err.statusCode ?? err.lastError?.statusCode }, 'Controller loop error');

      // Surface the error in the UI as a system entry in conversation
      controllerAgent.state.set('dynamicState.streamingEntries', []);
      controllerAgent.state.append('conversation', {
        type: EEntryType.System,
        uuid: generateId('err'),
        parentUuid: null,
        sessionId: 'controller',
        timestamp: nowISO(),
        subtype: ESystemSubtype.Error,
        content: friendly,
      });

      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  ctx.logger.info('Main controller loop stopped');
}
