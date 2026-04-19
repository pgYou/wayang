import { describe, it, expect, vi } from 'vitest';
import { checkControllerMessagesTool } from '@/services/tools/check-messages';
import { chatWorkerTool } from '@/services/tools/chat-worker';
import { respondPermissionTool } from '@/services/tools/respond-permission';
import type { InboxMessage } from '@/services/agents/worker-state';

async function exec(toolObj: any, args: any): Promise<string> {
  return toolObj.execute(args);
}

// --- check_controller_messages ---

describe('checkControllerMessagesTool', () => {
  it('should return messages when inbox has items', async () => {
    const messages: InboxMessage[] = [
      { id: 'msg-1', content: 'Hello worker', timestamp: Date.now() },
      { id: 'msg-2', content: 'Check the tests', timestamp: Date.now() },
    ];
    let drained = false;
    const tool = checkControllerMessagesTool({
      drainInbox: () => {
        if (drained) return [];
        drained = true;
        return messages;
      },
    });
    const result = await exec(tool, {});
    expect(result).toContain('Hello worker');
    expect(result).toContain('Check the tests');
    expect(drained).toBe(true);
  });

  it('should return no messages when inbox is empty', async () => {
    const tool = checkControllerMessagesTool({
      drainInbox: () => [],
    });
    const result = await exec(tool, {});
    expect(result).toBe('No messages.');
  });

  it('should atomically drain inbox', async () => {
    const inbox: InboxMessage[] = [
      { id: 'msg-1', content: 'msg1', timestamp: Date.now() },
    ];
    const tool = checkControllerMessagesTool({
      drainInbox: () => {
        const msgs = [...inbox];
        inbox.length = 0;
        return msgs;
      },
    });
    await exec(tool, {});
    expect(inbox).toHaveLength(0);
  });
});

// --- chat_worker ---

describe('chatWorkerTool', () => {
  it('should return success when worker found', async () => {
    const tool = chatWorkerTool({
      sendMessageToWorker: vi.fn(() => true),
    });
    const result = await exec(tool, { workerId: 'w1', message: 'Hello' });
    expect(result).toContain('delivered');
    expect(result).toContain('w1');
  });

  it('should return error when worker not found', async () => {
    const tool = chatWorkerTool({
      sendMessageToWorker: vi.fn(() => false),
    });
    const result = await exec(tool, { workerId: 'w-missing', message: 'Hello' });
    expect(result).toContain('[ERROR]');
    expect(result).toContain('not found');
  });
});

// --- respond_permission ---

describe('respondPermissionTool', () => {
  it('should return granted when approved', async () => {
    const tool = respondPermissionTool({
      respondPermission: vi.fn(() => true),
    });
    const result = await exec(tool, { requestId: 'perm-1', approved: true });
    expect(result).toContain('granted');
    expect(result).toContain('perm-1');
  });

  it('should return denied with reason', async () => {
    const tool = respondPermissionTool({
      respondPermission: vi.fn(() => true),
    });
    const result = await exec(tool, { requestId: 'perm-1', approved: false, reason: 'dangerous' });
    expect(result).toContain('denied');
    expect(result).toContain('dangerous');
  });

  it('should return error when requestId not found', async () => {
    const tool = respondPermissionTool({
      respondPermission: vi.fn(() => false),
    });
    const result = await exec(tool, { requestId: 'nonexistent', approved: true });
    expect(result).toContain('[ERROR]');
    expect(result).toContain('not found');
  });
});
