import { describe, expect, it } from 'vitest';
import { AcpError, acpUserMessage } from '@/services/acp/errors';
import type { AcpExitInfo } from '@/services/acp/types';

const exitInfo = (overrides: Partial<AcpExitInfo> = {}): AcpExitInfo => ({
  code: 1,
  signal: null,
  reason: 'crash',
  cancelled: false,
  ...overrides,
});

describe('acpUserMessage', () => {
  it('renders the frozen cli-missing template with command and errno summary', () => {
    expect(acpUserMessage('cli-missing', { command: 'codebuddy', reason: 'ENOENT: spawn codebuddy ENOENT' })).toBe(
      'ACP agent "codebuddy" 无法启动：ENOENT: spawn codebuddy ENOENT。codebuddy：npm i -g @tencent-ai/codebuddy-code；opencode：见 https://opencode.ai/docs/acp/',
    );
  });

  it('degrades gracefully when the command is unknown', () => {
    expect(acpUserMessage('cli-missing', {})).toContain('ACP agent 无法启动');
  });

  it('renders handshake-timeout with the wait in seconds', () => {
    expect(acpUserMessage('handshake-timeout', { command: 'codebuddy', seconds: 15 })).toBe(
      '与 "codebuddy" 握手超时（15s 无 initialize 响应），进程已终止。请重试；持续失败请检查 CLI 是否需要登录',
    );
  });

  it('renders auth-required with the auth method list', () => {
    expect(acpUserMessage('auth-required', { provider: 'codebuddy', command: 'codebuddy', authMethods: ['Login with iOA', 'Login with Google/Github'] })).toBe(
      '"codebuddy" 未登录：先在终端运行一次 "codebuddy" 完成登录（Login with iOA、Login with Google/Github）再重试',
    );
  });

  it('drops the auth method parenthetical when the list is empty', () => {
    expect(acpUserMessage('auth-required', { provider: 'x', command: 'x', authMethods: [] })).toBe(
      '"x" 未登录：先在终端运行一次 "x" 完成登录再重试',
    );
  });

  it('renders protocol-mismatch with the mismatch reason', () => {
    expect(acpUserMessage('protocol-mismatch', { command: 'opencode', reason: '版本 2' })).toBe(
      '与 "opencode" 的 ACP 协议不匹配（版本 2）。请升级该 CLI 或提交 issue',
    );
  });

  it('renders agent-error from an rpc message, falling back to stopReason then reason', () => {
    expect(acpUserMessage('agent-error', { provider: 'codebuddy', rpc: { code: -32603, message: 'boom' } })).toBe(
      '"codebuddy" 回合失败（boom）',
    );
    expect(acpUserMessage('agent-error', { provider: 'codebuddy', stopReason: 'refusal' })).toBe(
      '"codebuddy" 回合失败（refusal）',
    );
    // #62: a worker-built failure (e.g. the opencode gate injection) carries
    // its cause in `reason` — it must reach the task result, not "未知错误".
    expect(acpUserMessage('agent-error', { provider: 'opencode', reason: 'permission gate injection failed: EISDIR' })).toBe(
      '"opencode" 回合失败（permission gate injection failed: EISDIR）',
    );
    expect(acpUserMessage('agent-error', {})).toBe('agent 回合失败（未知错误）');
  });

  it('renders cancelled verbatim', () => {
    expect(acpUserMessage('cancelled', {})).toBe('任务已取消');
  });

  it('renders transport-closed with exit info and the last 20 stderr lines', () => {
    const lines = Array.from({ length: 25 }, (_, i) => `line-${i + 1}`);
    const message = acpUserMessage('transport-closed', { command: 'codebuddy', exit: exitInfo({ code: 3, signal: 'SIGKILL' }), stderrTail: lines });
    expect(message).toBe('"codebuddy" 进程提前退出（code=3 signal=SIGKILL）。stderr 尾部：' + Array.from({ length: 20 }, (_, i) => `line-${i + 6}`).join('\n'));
  });

  it('truncates the stderr tail at 2000 characters', () => {
    const lines = Array.from({ length: 20 }, () => 'x'.repeat(200));
    const message = acpUserMessage('transport-closed', { command: 'a', exit: exitInfo(), stderrTail: lines });
    expect(message.length).toBeLessThanOrEqual(2000 + '"a" 进程提前退出（code=1 signal=null）。stderr 尾部：'.length + 1);
    expect(message.endsWith('…')).toBe(true);
  });

  it('notes the absence of stderr output', () => {
    expect(acpUserMessage('transport-closed', { command: 'a', exit: exitInfo() })).toContain('（无 stderr 输出）');
  });
});

describe('AcpError', () => {
  it('carries code, message, detail and a ready-to-display userMessage', () => {
    const err = new AcpError('agent-error', 'session/prompt failed: boom', {
      rpc: { code: -32603, message: 'boom' },
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AcpError');
    expect(err.code).toBe('agent-error');
    expect(err.message).toBe('session/prompt failed: boom');
    expect(err.detail?.rpc).toEqual({ code: -32603, message: 'boom' });
    expect(err.userMessage).toBe('agent 回合失败（boom）');
  });

  it('threads the message into the userMessage when no detail reason exists (#62)', () => {
    expect(new AcpError('agent-error', 'workers.x.command is required').userMessage).toBe(
      'agent 回合失败（workers.x.command is required）',
    );
  });

  it('builds the userMessage from exit/stderrTail details when present', () => {
    const err = new AcpError('transport-closed', 'agent exited', {
      exit: exitInfo({ code: 2 }),
      stderrTail: ['oops'],
    });
    expect(err.userMessage).toContain('code=2');
    expect(err.userMessage).toContain('oops');
  });

  it('omits detail when not provided', () => {
    const err = new AcpError('cancelled', 'grace elapsed');
    expect(err.detail).toBeUndefined();
    expect(err.userMessage).toBe('任务已取消');
  });

  it('propagates detail.reason into the cli-missing userMessage', () => {
    const err = new AcpError('cli-missing', 'spawn "codebuddy" failed: ENOENT: spawn codebuddy ENOENT', {
      reason: 'ENOENT: spawn codebuddy ENOENT',
    });
    expect(err.userMessage).toContain('无法启动：ENOENT: spawn codebuddy ENOENT');
    expect(err.userMessage).toContain('npm i -g @tencent-ai/codebuddy-code');
  });

  it('propagates detail.seconds into the handshake-timeout userMessage', () => {
    const err = new AcpError('handshake-timeout', 'initialize: no response within 15000ms', { seconds: 15 });
    expect(err.userMessage).toContain('握手超时（15s 无 initialize 响应）');
  });

  it('propagates detail.reason into the protocol-mismatch userMessage', () => {
    const err = new AcpError('protocol-mismatch', 'agent protocolVersion 2 !== 1', { reason: '版本 2' });
    expect(err.userMessage).toBe('与 agent 的 ACP 协议不匹配（版本 2）。请升级该 CLI 或提交 issue');
  });
});
