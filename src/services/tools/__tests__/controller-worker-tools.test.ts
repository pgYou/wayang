import { describe, it, expect, vi } from 'vitest';
import { checkControllerMessagesTool } from '@/services/tools/check-messages';
import { chatWorkerTool } from '@/services/tools/chat-worker';
import { respondPermissionTool } from '@/services/tools/respond-permission';
import { respondInquiryTool } from '@/services/tools/respond-inquiry';

async function exec(toolObj: any, args: any): Promise<string> {
  return toolObj.execute(args);
}

// --- check_controller_messages (deprecated stub) ---

describe('checkControllerMessagesTool', () => {
  it('always returns the deprecation notice', async () => {
    const tool = checkControllerMessagesTool();
    const result = await exec(tool, {});
    expect(result).toContain('[DEPRECATED]');
    expect(result).toContain('injected automatically');
  });
});

// --- chat_worker ---

describe('chatWorkerTool', () => {
  it('reports delivery to a running puppet worker', async () => {
    const tool = chatWorkerTool({
      sendMessageToWorker: vi.fn(() => 'delivered' as const),
    });
    const result = await exec(tool, { workerId: 'w1', message: 'Hello' });
    expect(result).toContain('delivered');
    expect(result).toContain('w1');
  });

  it('reports queued delivery for third-party / idle workers', async () => {
    const tool = chatWorkerTool({
      sendMessageToWorker: vi.fn(() => 'queued' as const),
    });
    const result = await exec(tool, { workerId: 'cw1', message: 'Hello' });
    expect(result).toContain('queued');
    expect(result).toContain('cw1');
  });

  it('returns an error when the worker is not running', async () => {
    const tool = chatWorkerTool({
      sendMessageToWorker: vi.fn(() => 'not_running' as const),
    });
    const result = await exec(tool, { workerId: 'w-missing', message: 'Hello' });
    expect(result).toContain('[ERROR]');
    expect(result).toContain('not running');
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

// --- respond_inquiry ---

describe('respondInquiryTool', () => {
  it('confirms delivery when answered', async () => {
    const tool = respondInquiryTool({
      respondInquiry: vi.fn(() => 'answered' as const),
    });
    const result = await exec(tool, { inquiryId: 'inq-1', answer: 'Use approach B' });
    expect(result).toContain('delivered');
    expect(result).toContain('inq-1');
  });

  it('reports not_found for a settled (timed-out) inquiry', async () => {
    const tool = respondInquiryTool({
      respondInquiry: vi.fn(() => 'not_found' as const),
    });
    const result = await exec(tool, { inquiryId: 'inq-late', answer: 'x' });
    expect(result).toContain('[ERROR]');
    expect(result).toContain('timed out');
  });

  it('reports worker_gone for a vanished worker', async () => {
    const tool = respondInquiryTool({
      respondInquiry: vi.fn(() => 'worker_gone' as const),
    });
    const result = await exec(tool, { inquiryId: 'inq-gone', answer: 'x' });
    expect(result).toContain('[ERROR]');
    expect(result).toContain('no longer running');
  });
});
