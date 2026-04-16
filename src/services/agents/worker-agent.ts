import { BaseAgent } from './base-agent';
import { ContextManager } from './context-manager';
import { WorkerState } from '@/services/agents/worker-state';
import { buildAssistantEntry } from './utils/build-assistant-entry';
import { generateId } from '@/utils/id';
import { nowISO } from '@/utils/time';
import type { WorkerResult, TaskDetail, ProviderConfig, IWorkerInstance } from '@/types/index';
import { EEntryType } from '@/types/index';
import type { Logger } from '@/infra/logger';
import { WORKER_AGENT_MAX_STEP } from './constants';

import { buildWorkerSystemPrompt } from './prompts/index';
import { SystemContext } from '@/infra/system-context';

export class WorkerAgent extends BaseAgent implements IWorkerInstance {
  readonly state: WorkerState;
  private readonly logger: Logger;
  private _terminalResult: WorkerResult | null = null;
  private readonly workspaceDir: string;
  private contextManager: ContextManager;
  private readonly ctx: SystemContext;

  constructor(provider: ProviderConfig, ctx: SystemContext) {
    super(provider);
    this.ctx = ctx;
    this.logger = ctx.logger;
    this.workspaceDir = ctx.workspaceDir;
    this.state = new WorkerState(ctx.sessionDir, this.id, ctx.logger);
    this.contextManager = new ContextManager(
      this.state,
      buildWorkerSystemPrompt(this.ctx),
    );
  }

  async run(
    task: TaskDetail & { workerId: string },
    tools: Record<string, any>,
    onProgress?: (msg: string) => void,
  ): Promise<WorkerResult> {
    this.logger.debug({ task }, 'WorkerAgent run called');
    // Set task info in state
    this.state.set('runtimeState.task', { id: task.id, description: task.description });

    // Reset terminal result for this run
    this._terminalResult = null;

    // Add task description as initial user message
    this.state.append('conversation', {
      type: EEntryType.User,
      uuid: generateId('u'),
      parentUuid: null,
      sessionId: this.id,
      timestamp: nowISO(),
      message: { role: 'user', content: task.description },
    });

    // streamLoop handles abort internally — collectLoop returns cleanly
    const result = await this.collectLoop({
      system: this.contextManager.getSystemPrompt(),
      messages: this.contextManager.getMessages(),
      tools,
      toolChoice: 'required',
      maxSteps: WORKER_AGENT_MAX_STEP,
      stopTools: ['done', 'fail'],
      onStep: (event) => {
        const entry = buildAssistantEntry(event, this.id);
        this.state.append('conversation', entry);
        if (event.text && onProgress) {
          onProgress(event.text.slice(0, 200));
        }
      },
    });

    // done/fail callback already set the result
    if (this._terminalResult) {
      return this._terminalResult;
    }

    // External abort (Ctrl+C / supervisor shutdown)
    if (this.abortController.signal.aborted) {
      return { status: 'failed', error: 'Aborted' };
    }

    // Max steps reached without explicit done/fail
    return { status: 'completed', summary: result.text || '(max steps reached)' };
  }

  /** Called by done tool callback — saves result. Loop stops via stopWhen. */
  complete(summary: string): void {
    this.logger.debug({ summary }, 'WorkerAgent complete called');
    this._terminalResult = { status: 'completed', summary };
  }

  /** Called by fail tool callback — saves result. Loop stops via stopWhen. */
  fail(error: string): void {
    this.logger.debug({ error }, 'WorkerAgent fail called');
    this._terminalResult = { status: 'failed', error };
  }

  /** Get state for UI rendering. */
  getState() {
    return this.state;
  }
}
