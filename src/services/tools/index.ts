import type { TaskDetail, ControllerSignal, InquireQuestion } from '@/types/index';
import { addTaskTool } from './add-task';
import { listTasksTool } from './list-tasks';
import { cancelTaskTool } from './cancel-task';
import { getTaskDetailTool } from './get-task-detail';
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

export interface ControllerToolDeps {
  addTask: (task: TaskDetail) => void;
  /** Validate workerType. Returns null if valid, error message if invalid. */
  validateWorkerType?: (workerType: string) => string | null;
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
  /** Get worker conversation entries for a task. */
  getWorkerConversation?: (taskId: string) => any[];
  /** Read the controller's private notebook. */
  getNotebook: () => string;
  /** Write to the controller's private notebook. */
  setNotebook: (content: string, mode: 'replace' | 'append') => void;
  /** Ask the user a structured question and wait for the answer. */
  inquire: (question: InquireQuestion) => Promise<string>;
  /** Send a message to a running worker's inbox. */
  sendMessageToWorker: (workerId: string, message: string) => boolean;
  /** Respond to a worker's permission request. */
  resolvePermission: (requestId: string, approved: boolean, reason?: string) => boolean;
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
}

export function createControllerTools(deps: ControllerToolDeps) {
  return {
    add_task: addTaskTool({ addTask: deps.addTask, validateWorkerType: deps.validateWorkerType }),
    list_tasks: listTasksTool({ listTasks: deps.listTasks }),
    cancel_task: cancelTaskTool({
      cancelTask: deps.cancelTask,
      abortWorker: deps.abortWorker,
    }),
    get_task_detail: getTaskDetailTool({
      getTask: deps.getTask,
      getWorkerConversation: deps.getWorkerConversation,
    }),
    update_task: updateTaskTool({ updateTask: deps.updateTask }),
    query_signals: querySignalsTool({ querySignals: deps.queryMessages }),
    skip_reply: skipReplyTool(),
    read_notebook: readNotebookTool({ getNotebook: deps.getNotebook }),
    update_notebook: updateNotebookTool({ setNotebook: deps.setNotebook }),
    search_files: searchFilesTool({ cwd: deps.cwd }),
    inquire: inquireTool({ inquire: deps.inquire }),
    chat_worker: chatWorkerTool({
      sendMessageToWorker: deps.sendMessageToWorker,
    }),
    respond_permission: respondPermissionTool({
      respondPermission: deps.resolvePermission,
    }),
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
  };
}
