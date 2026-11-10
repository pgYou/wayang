import { z } from 'zod';
import { defineTool, safeExecute } from './common';
import type { PermissionResolutionStatus } from './permission-middleware';

export interface RespondPermissionToolDeps {
  respondPermission: (
    requestId: string,
    approved: boolean,
    reason?: string,
  ) => PermissionResolutionStatus;
}

export function respondPermissionTool(deps: RespondPermissionToolDeps) {
  return defineTool({
    description:
      'Respond to a worker\'s permission request. Approve to allow the operation, deny to reject it.',
    parameters: z.object({
      requestId: z.string().describe('The request ID from the permission_request signal'),
      approved: z.boolean().describe('true to approve, false to deny'),
      reason: z.string().optional().describe('Reason for denial (shown to worker)'),
    }),
    execute: safeExecute('respond_permission', async ({ requestId, approved, reason }) => {
      // Every status is terminal (issue #69): the worker-side wait is either
      // settled by this call or was already released. The error branches tell
      // the controller WHICH terminal state the request reached so it stops
      // instead of retrying a response that can no longer be delivered.
      const status = deps.respondPermission(requestId, approved, reason);
      if (status === 'not-found') {
        return `[ERROR] Permission request ${requestId} not found: no live worker is waiting on it (the id may be stale or belong to a finished worker). Do not retry.`;
      }
      if (status === 'already-resolved') {
        return `[ERROR] Permission request ${requestId} was already responded to earlier. The duplicate response was ignored — the worker already continued with the first answer.`;
      }
      if (status === 'expired') {
        return `[ERROR] Permission request ${requestId} expired (timed out waiting for a response). The worker already received a timeout error and moved on — no response is needed.`;
      }
      if (status === 'worker-closed') {
        return `[ERROR] Permission request ${requestId} belongs to a worker that was aborted or shut down. Its wait was already cancelled — no response is needed.`;
      }
      return approved
        ? `Permission granted for request ${requestId}.`
        : `Permission denied for request ${requestId}: ${reason ?? 'No reason provided'}.`;
    }),
  });
}
