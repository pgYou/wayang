/**
 * ACP error taxonomy and user-facing message templates.
 *
 * Contract: docs/design/acp/00-interface-freeze.md §2.5 and §4. Neither the
 * protocol layer nor the worker layer auto-retries; the §4 "重派" column is
 * consumed by upper layers, not here.
 */

import type { AcpExitInfo } from './types';

export type AcpErrorCode =
  | 'cli-missing'
  | 'handshake-timeout'
  | 'auth-required'
  | 'protocol-mismatch'
  | 'agent-error'
  | 'cancelled'
  | 'transport-closed';

export interface AcpErrorDetail {
  exit?: AcpExitInfo;
  rpc?: { code: number; message: string };
  stderrTail?: string[];
  /**
   * errno summary / mismatch cause / timeout seconds — the fields the frozen
   * §4 templates interpolate. The protocol layer fills them at every
   * construction site so `userMessage` is complete without a worker re-render.
   */
  reason?: string;
  seconds?: number;
}

export interface AcpUserMessageContext {
  command?: string;
  provider?: string;
  authMethods?: string[];
  stopReason?: string;
  rpc?: { code: number; message: string };
  exit?: AcpExitInfo;
  /**
   * Beyond-freeze additions (see delivery report): the frozen §4 templates
   * reference an errno summary / mismatch cause / timeout seconds / stderr
   * tail that the frozen ctx shape had no field for.
   */
  reason?: string;
  seconds?: number;
  stderrTail?: string[];
}

const STDERR_TAIL_LINES_IN_MESSAGE = 20;
const STDERR_TAIL_MAX_CHARS = 2000;

function quote(value: string | undefined): string {
  return value ? `"${value}"` : '';
}

function subject(ctx: AcpUserMessageContext): string {
  return quote(ctx.provider ?? ctx.command) || 'agent';
}

function commandLabel(ctx: AcpUserMessageContext): string {
  return quote(ctx.command);
}

function exitLabel(exit: AcpExitInfo): string {
  return `code=${exit.code === null ? 'null' : exit.code} signal=${exit.signal ?? 'null'}`;
}

function stderrTailText(lines: string[] | undefined): string {
  if (!lines || lines.length === 0) return '（无 stderr 输出）';
  const tail = lines.slice(-STDERR_TAIL_LINES_IN_MESSAGE).join('\n');
  return tail.length > STDERR_TAIL_MAX_CHARS ? `${tail.slice(0, STDERR_TAIL_MAX_CHARS)}…` : tail;
}

/**
 * Build the user-facing message for an ACP error code. Missing ctx fields
 * degrade gracefully (e.g. the command placeholder is dropped) so the
 * protocol layer can produce a best-effort message without knowing the
 * provider; the worker layer re-renders with full context.
 */
export function acpUserMessage(code: AcpErrorCode, ctx: AcpUserMessageContext = {}): string {
  switch (code) {
    case 'cli-missing': {
      const cmd = commandLabel(ctx);
      const reason = ctx.reason ?? '无法执行';
      const head = cmd ? `ACP agent ${cmd} 无法启动` : 'ACP agent 无法启动';
      // Frozen §4 template (verbatim, including the provider install hints).
      return `${head}：${reason}。codebuddy：npm i -g @tencent-ai/codebuddy-code；opencode：见 https://opencode.ai/docs/acp/`;
    }
    case 'handshake-timeout': {
      const cmd = commandLabel(ctx);
      const wait = ctx.seconds !== undefined ? `${ctx.seconds}s 无 initialize 响应` : '无 initialize 响应';
      return `与 ${cmd || 'agent'} 握手超时（${wait}），进程已终止。请重试；持续失败请检查 CLI 是否需要登录`;
    }
    case 'auth-required': {
      const methods = (ctx.authMethods ?? []).filter((name) => name.length > 0);
      const list = methods.length > 0 ? `（${methods.join('、')}）` : '';
      return `${subject(ctx)} 未登录：先在终端运行一次 ${commandLabel(ctx) || '该 CLI'} 完成登录${list}再重试`;
    }
    case 'protocol-mismatch': {
      const reason = ctx.reason ?? '协议不兼容';
      return `与 ${commandLabel(ctx) || 'agent'} 的 ACP 协议不匹配（${reason}）。请升级该 CLI 或提交 issue`;
    }
    case 'agent-error': {
      const cause = ctx.rpc?.message ?? ctx.stopReason ?? '未知错误';
      return `${subject(ctx)} 回合失败（${cause}）`;
    }
    case 'cancelled':
      return '任务已取消';
    case 'transport-closed': {
      const exit = ctx.exit;
      const exitPart = exit ? `（${exitLabel(exit)}）` : '';
      return `${commandLabel(ctx) || 'agent'} 进程提前退出${exitPart}。stderr 尾部：${stderrTailText(ctx.stderrTail)}`;
    }
  }
}

/** Classified ACP failure. `userMessage` is ready for upper-layer display. */
export class AcpError extends Error {
  readonly code: AcpErrorCode;
  readonly detail?: AcpErrorDetail;
  readonly userMessage: string;

  constructor(code: AcpErrorCode, message: string, detail?: AcpErrorDetail) {
    super(message);
    this.name = 'AcpError';
    this.code = code;
    this.detail = detail;
    this.userMessage = acpUserMessage(code, {
      rpc: detail?.rpc,
      exit: detail?.exit,
      stderrTail: detail?.stderrTail,
      reason: detail?.reason,
      seconds: detail?.seconds,
    });
  }
}
