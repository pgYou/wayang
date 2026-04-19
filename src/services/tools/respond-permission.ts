import { z } from 'zod';
import { defineTool, safeExecute } from './common';

export interface RespondPermissionToolDeps {
  respondPermission: (requestId: string, approved: boolean, reason?: string) => boolean;
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
      const handled = deps.respondPermission(requestId, approved, reason);
      if (!handled) return `[ERROR] Permission request ${requestId} not found or already resolved.`;
      return approved
        ? `Permission granted for request ${requestId}.`
        : `Permission denied for request ${requestId}: ${reason ?? 'No reason provided'}.`;
    }),
  });
}
