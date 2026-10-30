import { describe, it, expect } from 'vitest';
import {
  summarizePermissionRequest,
  summarizePermissionResolution,
} from '@/tui/utils/permission-summary';
import type { PermissionRequestMeta } from '@/types/conversation';
import type { ToolCallRecord } from '@/types/conversation';

/** Independent display-width check (CJK/fullwidth = 2 columns). */
function width(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide = (cp >= 0x2e80 && cp <= 0xa4cf)
      || (cp >= 0xff00 && cp <= 0xff60)
      || (cp >= 0x1f300 && cp <= 0x1faff)
      || (cp >= 0x20000 && cp <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}

const W = 120;

function meta(toolName: string, toolArgs: Record<string, unknown>, description?: string): PermissionRequestMeta {
  return { requestId: 'perm-1-abcd', toolName, toolArgs, description };
}

function tc(args: unknown): ToolCallRecord {
  return {
    toolCallId: 'tc-1',
    toolName: 'respond_permission',
    arguments: JSON.stringify(args),
  };
}

// --- summarizePermissionRequest: per-tool templates ---

describe('summarizePermissionRequest', () => {
  it('shows the first line of a single-line bash command', () => {
    const s = summarizePermissionRequest(meta('bash', { command: 'rm -rf /tmp/cache' }), W);
    expect(s.state).toBe('pending');
    expect(s.label).toBe('权限申请 bash rm -rf /tmp/cache');
  });

  it('shows only the first line of a multi-line bash command with a line count', () => {
    const s = summarizePermissionRequest(meta('bash', { command: 'cd /tmp\nrm -rf cache\nls -la' }), W);
    expect(s.label).toBe('权限申请 bash cd /tmp (3 行)');
    expect(s.label).not.toContain('rm -rf');
  });

  it('truncates a long bash command but keeps the line-count note', () => {
    const s = summarizePermissionRequest(meta('bash', { command: 'y'.repeat(200) + '\nsecond' }), 40);
    expect(s.label.endsWith('… (2 行)')).toBe(true);
    expect(width(s.label)).toBeLessThanOrEqual(40);
  });

  it('shows path and added line count for write_file', () => {
    const s = summarizePermissionRequest(meta('write_file', { path: 'src/new-module.ts', content: 'a\nb\nc' }), W);
    expect(s.label).toBe('权限申请 write_file src/new-module.ts (+3)');
  });

  it('shortens a long write_file path to its last 3 segments', () => {
    const s = summarizePermissionRequest(
      meta('write_file', { path: '/home/luke/code/wayang/src/tui/theme.ts', content: 'x' }),
      W,
    );
    expect(s.label).toContain('…/src/tui/theme.ts (+1)');
    expect(s.label).not.toContain('/home/luke');
  });

  it('shows path and old→new line counts for edit_file', () => {
    const s = summarizePermissionRequest(
      meta('edit_file', { path: 'src/a.ts', old_string: 'l1\nl2', new_string: 'l1\nl2\nl3\nl4' }),
      W,
    );
    expect(s.label).toBe('权限申请 edit_file src/a.ts (2→4 行)');
  });

  it('shows read_file path with optional offset+limit', () => {
    const withRange = summarizePermissionRequest(meta('read_file', { path: 'src/foo.ts', offset: 10, limit: 50 }), W);
    expect(withRange.label).toBe('权限申请 read_file src/foo.ts:10+50');

    const plain = summarizePermissionRequest(meta('read_file', { path: 'src/foo.ts' }), W);
    expect(plain.label).toBe('权限申请 read_file src/foo.ts');
  });

  it('shows the pattern for search_files and the query for search_content', () => {
    expect(summarizePermissionRequest(meta('search_files', { pattern: '**/*.ts' }), W).label)
      .toBe('权限申请 search_files **/*.ts');
    expect(summarizePermissionRequest(meta('search_content', { query: 'permissionMeta' }), W).label)
      .toBe('权限申请 search_content permissionMeta');
  });

  it('shows title and workerType for add_task', () => {
    const s = summarizePermissionRequest(meta('add_task', { title: 'Fix login bug', workerType: 'claude-code' }), W);
    expect(s.label).toBe('权限申请 add_task Fix login bug (claude-code)');

    const noType = summarizePermissionRequest(meta('add_task', { title: 'Fix login bug' }), W);
    expect(noType.label).toBe('权限申请 add_task Fix login bug');
  });

  it('shows workerId and first message line for chat_worker', () => {
    const s = summarizePermissionRequest(meta('chat_worker', { workerId: 'w-123', message: 'line1\nline2' }), W);
    expect(s.label).toBe('权限申请 chat_worker w-123: line1');
  });

  it('uses short labels for read-only tools', () => {
    expect(summarizePermissionRequest(meta('query_signals', { status: 'unread' }), W).label)
      .toBe('权限申请 query_signals 查询信号历史');
    expect(summarizePermissionRequest(meta('list_tasks', {}), W).label)
      .toBe('权限申请 list_tasks 查看任务列表');
  });

  it('falls back to a raw JSON prefix for unknown tools', () => {
    const s = summarizePermissionRequest(meta('deploy_service', { target: 'prod', force: true }), W);
    expect(s.label).toContain('deploy_service');
    expect(s.label).toContain('"target":"prod"');
  });

  it('caps the raw JSON prefix for unknown tools at 60 characters', () => {
    const s = summarizePermissionRequest(meta('mystery', { blob: 'x'.repeat(100) }), W);
    const raw = s.label.slice(s.label.indexOf('{'));
    expect(width(raw)).toBeLessThanOrEqual(60);
    expect(raw.endsWith('…')).toBe(true);
  });

  it('matches tool templates case-insensitively (Claude Code "Bash")', () => {
    const s = summarizePermissionRequest(meta('Bash', { command: 'rm -rf /tmp/x' }), W);
    expect(s.label).toBe('权限申请 Bash rm -rf /tmp/x');
  });

  it('omits the fragment when key args are missing', () => {
    expect(summarizePermissionRequest(meta('bash', {}), W).label).toBe('权限申请 bash');
  });

  it('drops a description that only restates the bash command', () => {
    const s = summarizePermissionRequest(
      meta('bash', { command: 'cat /etc/hosts' }, 'Execute shell command: cat /etc/hosts'),
      W,
    );
    expect(s.detail).toBe('');
  });

  it('keeps only the resolved path of a file-tool description, when it differs', () => {
    const outside = summarizePermissionRequest(
      meta('write_file', { path: '../x.ts' }, 'write_file: ../x.ts (resolved: /data/other/x.ts)'),
      W,
    );
    expect(outside.detail).toBe('解析为 /data/other/x.ts');

    const same = summarizePermissionRequest(
      meta('read_file', { path: '/etc/hosts' }, 'read_file: /etc/hosts (resolved: /etc/hosts)'),
      W,
    );
    expect(same.detail).toBe('');
  });

  it('exposes structured parts: tool name, target and request short id', () => {
    const s = summarizePermissionRequest(meta('bash', { command: 'git status' }), W);
    expect(s.toolName).toBe('bash');
    expect(s.target).toBe('git status');
    expect(s.requestShortId).toBe('abcd');
  });

  it('collapses multi-line descriptions into a single detail line', () => {
    const s = summarizePermissionRequest(meta('bash', { command: 'x' }, 'first\nsecond\n\nthird'), W);
    expect(s.detail).toBe('first second third');
    expect(s.detail).not.toContain('\n');
  });

  it('leaves detail empty when there is no description', () => {
    const s = summarizePermissionRequest(meta('bash', { command: 'ls' }), W);
    expect(s.detail).toBe('');
  });

  // --- width handling ---

  it('counts CJK characters as 2 columns when truncating', () => {
    // "权限申请 bash 你好" = 8 + 1 + 4 + 1 + 4 = 18 columns.
    const fits = summarizePermissionRequest(meta('bash', { command: '你好' }), 18);
    expect(fits.label).toBe('权限申请 bash 你好');

    const cut = summarizePermissionRequest(meta('bash', { command: '你好' }), 17);
    expect(cut.label.endsWith('…')).toBe(true);
    expect(cut.label).not.toContain('好');
    expect(width(cut.label)).toBeLessThanOrEqual(17);
  });

  it('hard-truncates the label to maxWidth', () => {
    const s = summarizePermissionRequest(meta('read_file', { path: 'x'.repeat(40) }), 30);
    expect(width(s.label)).toBeLessThanOrEqual(30);
    expect(s.label.endsWith('…')).toBe(true);
    expect(s.label).not.toContain('x'.repeat(12)); // the tail was cut, not kept whole
  });
});

// --- summarizePermissionResolution ---

describe('summarizePermissionResolution', () => {
  it('parses an approved resolution from arguments', () => {
    const s = summarizePermissionResolution(
      tc({ requestId: 'perm-1712-abcd1234', approved: true }),
      80,
    );
    expect(s.state).toBe('approved');
    expect(s.label).toBe('已批准 #1234');
    expect(s.detail).toBe('');
  });

  it('parses a denied resolution with reason', () => {
    const s = summarizePermissionResolution(
      tc({ requestId: 'perm-99-xyz9', approved: false, reason: 'too dangerous' }),
      80,
    );
    expect(s.state).toBe('denied');
    expect(s.label).toBe('已拒绝 #xyz9 原因: too dangerous');
  });

  it('parses a denied resolution without reason', () => {
    const s = summarizePermissionResolution(tc({ requestId: 'perm-1', approved: false }), 80);
    expect(s.state).toBe('denied');
    expect(s.label).toBe('已拒绝 #rm-1');
  });

  it('infers approval from the tool result when arguments are unparseable', () => {
    const bad: ToolCallRecord = { toolCallId: 'tc-2', toolName: 'respond_permission', arguments: 'not json' };
    const granted = summarizePermissionResolution(bad, 80, { text: 'Permission granted for request perm-1.' });
    expect(granted.state).toBe('approved');

    const denied = summarizePermissionResolution(bad, 80, { text: 'Permission denied for request perm-2: nope.' });
    expect(denied.state).toBe('denied');
  });

  it('keeps raw arguments visible when nothing can be parsed', () => {
    const bad: ToolCallRecord = { toolCallId: 'tc-3', toolName: 'respond_permission', arguments: '{bad json' };
    const s = summarizePermissionResolution(bad, 80);
    expect(s.state).toBe('denied');
    expect(s.detail).toContain('原始参数');
    expect(s.detail).toContain('{bad json');
  });

  it('surfaces resolutions that did not take effect (error result)', () => {
    const s = summarizePermissionResolution(
      tc({ requestId: 'perm-3-end42', approved: true }),
      80,
      { text: '[ERROR] Permission request perm-3-end42 not found or already resolved.', isError: true },
    );
    expect(s.state).toBe('approved');
    expect(s.label).toBe('已批准 #nd42');
    expect(s.detail).toContain('not found');
  });

  it('carries the original request tool and target when the request is known', () => {
    const s = summarizePermissionResolution(
      tc({ requestId: 'perm-5-7xvt', approved: true }),
      80,
      undefined,
      { requestId: 'perm-5-7xvt', toolName: 'bash', toolArgs: { command: 'git commit -m x' } },
    );
    expect(s.state).toBe('approved');
    expect(s.toolName).toBe('bash');
    expect(s.target).toBe('git commit -m x');
    expect(s.requestShortId).toBe('7xvt');
    expect(s.label).toBe('已批准 bash git commit -m x #7xvt');
  });

  it('exposes the denial reason as a structured field', () => {
    const s = summarizePermissionResolution(
      tc({ requestId: 'perm-6', approved: false, reason: 'too\ndangerous' }),
      80,
    );
    expect(s.reason).toBe('too dangerous');
  });

  it('truncates a long denial reason to maxWidth', () => {
    const s = summarizePermissionResolution(
      tc({ requestId: 'perm-4', approved: false, reason: 'r'.repeat(100) }),
      30,
    );
    expect(s.state).toBe('denied');
    expect(width(s.label)).toBeLessThanOrEqual(30);
    expect(s.label.endsWith('…')).toBe(true);
  });
});
