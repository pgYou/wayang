import type { TaskDetail, ControllerSignal } from '@/types/index';
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
import { doneTool } from './done';
import { failTool } from './fail';
import { updateProgressTool } from './update-progress';

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
}

export interface WorkerToolDeps {
  listTasks: (status?: TaskDetail['status']) => TaskDetail[];
  reportProgress: (message: string, percent?: number) => void;
  cwd?: string;
  /** Called when worker calls the done tool. */
  onComplete: (summary: string) => void;
  /** Called when worker calls the fail tool. */
  onFail: (error: string) => void;
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
    }),
    update_task: updateTaskTool({ updateTask: deps.updateTask }),
    query_signals: querySignalsTool({ querySignals: deps.queryMessages }),
    skip_reply: skipReplyTool(),
  };
}

export function createWorkerTools(deps: WorkerToolDeps) {
  return {
    bash: bashTool({ cwd: deps.cwd }),
    read_file: readFileTool({ cwd: deps.cwd }),
    write_file: writeFileTool({ cwd: deps.cwd }),
    list_tasks: listTasksTool({ listTasks: deps.listTasks }),
    update_progress: updateProgressTool({ reportProgress: deps.reportProgress }),
    done: doneTool({ onComplete: deps.onComplete }),
    fail: failTool({ onFail: deps.onFail }),
  };
}
