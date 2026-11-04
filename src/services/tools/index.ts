import type { TaskDetail, ControllerSignal, InquireQuestion, ActiveWorkerInfo, WorkerLiveStatus } from '@/types/index';
import type { PermissionConfig } from '@/types/config';
import type { ConversationEntry } from '@/types/conversation';
import { addTaskTool } from './add-task';
import { listTasksTool } from './list-tasks';
import { cancelTaskTool } from './cancel-task';
import { disposeWorkerTool } from './dispose-worker';
import { getTaskDetailTool } from './get-task-detail';
import { readWorkerConversationTool } from './read-worker-conversation';
import { getWorkerStatusTool } from './get-worker-status';
import { updateTaskTool } from './update-task';
import { querySignalsTool } from './query-signals';
import { skipReplyTool } from './skip-reply';
import { bashTool } from './bash';
import { readFileTool } from './read-file';
import { writeFileTool } from './write-file';
import { editFileTool } from './edit-file';
import { searchFilesTool } from './search-files';
import { searchContentTool } from './search-content';
import { webSearchTool } from './web-search';
import { readNotebookTool, updateNotebookTool } from './notebook';
import { inquireTool } from './inquire';
import { doneTool } from './done';
import { failTool } from './fail';
import { updateProgressTool } from './update-progress';
import { chatWorkerTool } from './chat-worker';
import { respondPermissionTool } from './respond-permission';
import { respondInquiryTool } from './respond-inquiry';
import { useSkillTool } from './use-skill';
import type { SkillRegistry } from '@/services/skills/registry';

export interface ControllerToolDeps {
  /**
   * Add a task and attempt to schedule it. Returns the engine worker id when
   * scheduled immediately, or undefined when the task is queued (all
   * concurrency slots busy). See AddTaskToolDeps.addTask.
   */
  addTask: (task: TaskDetail) => string | undefined;
  /** Validate workerType. Returns null if valid, error message if invalid. */
  validateWorkerType?: (workerType: string) => string | null;
  /** Assign a task to an existing idle worker. Returns true if assigned. */
  assignToWorker?: (workerId: string, task: TaskDetail) => boolean;
  /** Validate that a worker exists and is idle. Returns error message or null. */
  validateIdleWorker?: (workerId: string) => string | null;
  /**
   * Validate that an idle worker was created in the workspace the task targets.
   * Returns error message or null (see AddTaskToolDeps.validateWorkerWorkspace).
   */
  validateWorkerWorkspace?: (workerId: string, workspacePath: string) => string | null;
  listTasks: (status?: TaskDetail['status']) => TaskDetail[];
  getTask: (taskId: string) => TaskDetail | undefined;
  cancelTask: (taskId: string) => boolean;
  abortWorker: (taskId: string) => void;
  updateTask: (taskId: string, updates: Partial<Pick<TaskDetail, 'description' | 'priority'>>) => boolean;
  queryMessages: (filter: {
    status?: ControllerSignal['status'];
    source?: ControllerSignal['source'];
    type?: ControllerSignal['type'];
  }) => ControllerSignal[];
  /** Workspace directory for file search. */
  cwd?: string;
  /**
   * The user's home directory — the read scope for search_files, and the
   * boundary add_task's `allowedDirs` must stay inside. Sensitive subpaths
   * (credentials, tool config, ~/.wayang) stay unreadable. This is NOT
   * ~/.wayang; it is the home that contains it.
   */
  homeDir?: string;
  /**
   * User-config permission section, injected into add_task so its
   * `sensitiveDirs` (and the deprecated `deniedDirs` alias) extend the built-in
   * sensitive list when validating `allowedDirs`.
   */
  permissionConfig?: PermissionConfig;
  /** Get worker conversation entries for a task. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors TaskExecuteEngine.getWorkerConversation's defensive any[]
  getWorkerConversation?: (taskId: string) => any[];
  /** Read a worker's on-disk transcript (works after the worker is gone). */
  readTranscript: (workerId: string) => ConversationEntry[] | null;
  /** Live in-memory conversation of an engine-tracked worker, by worker id. */
  getWorkerConversationByWorkerId?: (workerId: string) => ConversationEntry[] | undefined;
  /** The worker instance's own id (on-disk transcript dir name), while tracked. */
  getWorkerTranscriptId?: (workerId: string) => string | undefined;
  /** Windowed (tail-bounded) read of an on-disk transcript. */
  readTranscriptWindow?: (workerId: string, opts: import('@/services/worker-transcript').TranscriptReadOptions) => import('@/services/worker-transcript').WorkerTranscriptWindow | null;
  /** Session directory holding `workers/<workerId>/conversation.jsonl`. */
  sessionDir: string;
  /** Currently tracked workers (for status listings / loud not-found messages). */
  getActiveWorkers?: () => ActiveWorkerInfo[];
  /** Live run flags of an in-memory worker instance, when the type reports them. */
  getWorkerLiveStatus?: (workerId: string) => WorkerLiveStatus | undefined;
  /** Read the controller's private notebook. */
  getNotebook: () => string;
  /** Write to the controller's private notebook. */
  setNotebook: (content: string, mode: 'replace' | 'append') => void;
  /** Ask the user a structured question and wait for the answer. */
  inquire: (question: InquireQuestion) => Promise<string>;
  /** Send a message to a running worker's inbox. */
  sendMessageToWorker: (workerId: string, message: string) => import('@/services/task-execute-engine').WorkerMessageDelivery;
  /** Respond to a worker's permission request. */
  resolvePermission: (requestId: string, approved: boolean, reason?: string) => boolean;
  /** Answer a worker's pending ask_controller question. */
  resolveInquiry: (inquiryId: string, answer: string) => import('./respond-inquiry').RespondInquiryStatus;
  /** Shared skill registry backing the use_skill tool. */
  registry: SkillRegistry;
  /** Dispose a worker by id (running or idle). Returns true if found. */
  disposeWorker: (workerId: string) => boolean;
  /** Current controller turn lineage — stamped onto tasks created by add_task. */
  getTurnContext?: () => { turnId?: string; rootTurnId?: string; causationId?: string } | undefined;
  /** Notify the agent that an add_task call dispatched a task (toolCall→task link). */
  onTaskDispatched?: (info: { toolCallId?: string; taskId: string }) => void;
  /**
   * Workspace this process runs in (ctx.workspaceDir). add_task uses it as the
   * default target; a declared workspace may point elsewhere and the engine
   * executes the task there.
   */
  workspaceDir?: string;
  /** Wayang home dir for workspace-registry lookups (path + stable slug). */
  wayangDir?: string | null;
}

export interface WorkerToolDeps {
  listTasks: (status?: TaskDetail['status']) => TaskDetail[];
  reportProgress: (message: string, percent?: number) => void;
  cwd?: string;
  /** Called when worker calls the done tool. */
  onComplete: (summary: string) => void;
  /** Called when worker calls the fail tool. */
  onFail: (error: string) => void;
  /** Tavily API key for web_search. Optional — tool returns error if unset. */
  tavilyApiKey?: string;
  /** Shared skill registry backing the use_skill tool. */
  registry: SkillRegistry;
}

export function createControllerTools(deps: ControllerToolDeps) {
  return {
    add_task: addTaskTool({
      addTask: deps.addTask,
      validateWorkerType: deps.validateWorkerType,
      assignToWorker: deps.assignToWorker,
      validateIdleWorker: deps.validateIdleWorker,
      validateWorkerWorkspace: deps.validateWorkerWorkspace,
      getTurnContext: deps.getTurnContext,
      onTaskDispatched: deps.onTaskDispatched,
      workspaceDir: deps.workspaceDir,
      wayangDir: deps.wayangDir,
      homeDir: deps.homeDir,
      permissionConfig: deps.permissionConfig,
    }),
    list_tasks: listTasksTool({ listTasks: deps.listTasks }),
    cancel_task: cancelTaskTool({
      cancelTask: deps.cancelTask,
      abortWorker: deps.abortWorker,
    }),
    get_task_detail: getTaskDetailTool({
      getTask: deps.getTask,
      getWorkerConversation: deps.getWorkerConversation,
      readTranscriptWindow: deps.readTranscriptWindow,
    }),
    read_worker_conversation: readWorkerConversationTool({
      sessionDir: deps.sessionDir,
      getWorkerConversationByWorkerId: deps.getWorkerConversationByWorkerId,
      getWorkerTranscriptId: deps.getWorkerTranscriptId,
      readTranscriptWindow: (workerId, opts) => {
        const reader = deps.readTranscriptWindow;
        if (!reader) throw new Error('readTranscriptWindow dep not wired');
        return reader(workerId, opts);
      },
      listWorkers: () => deps.getActiveWorkers?.() ?? [],
      listTasks: () => deps.listTasks(),
    }),
    get_worker_status: getWorkerStatusTool({
      listWorkers: () => deps.getActiveWorkers?.() ?? [],
      listTasks: () => deps.listTasks(),
      readTranscript: deps.readTranscript,
      // Same layered activity source read_worker_conversation uses: live
      // memory while tracked, on-disk jsonl (under the instance's OWN id)
      // otherwise. Without these the tool reads workers/<engine-id>/ which
      // never exists and reports null activity for busy workers.
      getWorkerConversationByWorkerId: deps.getWorkerConversationByWorkerId,
      getWorkerTranscriptId: deps.getWorkerTranscriptId,
      getLiveStatus: deps.getWorkerLiveStatus,
    }),
    update_task: updateTaskTool({ updateTask: deps.updateTask }),
    query_signals: querySignalsTool({ querySignals: deps.queryMessages }),
    skip_reply: skipReplyTool(),
    read_notebook: readNotebookTool({ getNotebook: deps.getNotebook }),
    update_notebook: updateNotebookTool({ setNotebook: deps.setNotebook }),
    search_files: searchFilesTool({ cwd: deps.cwd, homeDir: deps.homeDir }),
    inquire: inquireTool({ inquire: deps.inquire }),
    chat_worker: chatWorkerTool({
      sendMessageToWorker: deps.sendMessageToWorker,
    }),
    respond_permission: respondPermissionTool({
      respondPermission: deps.resolvePermission,
    }),
    respond_inquiry: respondInquiryTool({
      respondInquiry: deps.resolveInquiry,
    }),
    use_skill: useSkillTool({ registry: deps.registry }),
    dispose_worker: disposeWorkerTool({ disposeWorker: deps.disposeWorker }),
  };
}

export function createWorkerTools(deps: WorkerToolDeps) {
  return {
    bash: bashTool({ cwd: deps.cwd }),
    read_file: readFileTool({ cwd: deps.cwd }),
    write_file: writeFileTool({ cwd: deps.cwd }),
    edit_file: editFileTool({ cwd: deps.cwd }),
    search_files: searchFilesTool({ cwd: deps.cwd }),
    search_content: searchContentTool({ cwd: deps.cwd }),
    web_search: webSearchTool({ tavilyApiKey: deps.tavilyApiKey }),
    list_tasks: listTasksTool({ listTasks: deps.listTasks }),
    update_progress: updateProgressTool({ reportProgress: deps.reportProgress }),
    done: doneTool({ onComplete: deps.onComplete }),
    fail: failTool({ onFail: deps.onFail }),
    use_skill: useSkillTool({ registry: deps.registry }),
  };
}
