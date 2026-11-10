/**
 * Pure ACP turn attribution + loop guard primitives (#56): no IO, no logging,
 * no shared mutable state, and no mutation of arguments.
 */
export type CancelFact = 'abort' | 'prompt-timeout' | null;
export type DenialSource = 'policy' | 'timeout' | 'controller';
export interface TurnDenial {
  source: DenialSource; toolName: string; reason: string;
  sanitizedTarget: string; key: string; injectable: boolean;
}
export type TurnEndCategory = 'our_cancel' | 'our_timeout' | 'denied_by_policy' | 'denied_by_timeout' | 'denied_by_user' | 'agent_ended_unexpectedly' | 'completed';
export interface TurnGuardState {
  turnSeq: number; denialReissues: number; perKey: Map<string, number>;
  consecutiveDenialTurns: number; runStartedAt: number;
  lastProgressSig: string; stagnantTurns: number;
  /**
   * Wall-time budget (ms) of this run (#76): task `runTimeoutMs` >
   * config `workerRunTimeoutMs` > `MAX_RUN_WALL_MS` (default 60 min).
   * Stamped once at run start; the guard's other budgets stay untouched.
   */
  wallLimitMs: number;
}
export const TURN_LIMITS = {
  MAX_TURNS: 12, MAX_DENIAL_REISSUES: 3, MAX_PER_KEY: 1,
  MAX_CONSECUTIVE_DENIAL_TURNS: 2, MAX_RUN_WALL_MS: 3_600_000, MAX_STAGNANT_TURNS: 2,
} as const;

export interface ClassifyTurnEndInput { stopReason: string; cancelFact: CancelFact; denials: TurnDenial[]; hasQueuedMessages: boolean }
const SOURCE_PRIORITY: readonly DenialSource[] = ['policy', 'timeout', 'controller'];
const CATEGORY_BY_SOURCE: Record<DenialSource, TurnEndCategory> = {
  policy: 'denied_by_policy', timeout: 'denied_by_timeout', controller: 'denied_by_user',
};

/** Cancel facts win over everything; a normal end_turn beats denials (the agent
 * saw the refusal and chose to wrap up — that is a completed turn); denials
 * beat other stop reasons. */
export function classifyTurnEnd(input: ClassifyTurnEndInput): TurnEndCategory {
  const { stopReason, cancelFact, denials } = input;
  if (cancelFact === 'abort') return 'our_cancel';
  if (cancelFact === 'prompt-timeout') return 'our_timeout';
  if (stopReason === 'end_turn') return 'completed';
  if (denials.length > 0) {
    const present = new Set(denials.map((d) => d.source));
    return CATEGORY_BY_SOURCE[SOURCE_PRIORITY.find((s) => present.has(s)) ?? 'controller'];
  }
  return 'agent_ended_unexpectedly';
}
function normalizeForKey(value: string): string { return value.toLowerCase().replace(/\s+/g, ' ').trim(); }
/** Stable budget identity: lower case, whitespace collapsed, source|tool|target. */
export function denialKey(input: { source: string; toolName: string; sanitizedTarget: string }): string {
  return [normalizeForKey(input.source), normalizeForKey(input.toolName), normalizeForKey(input.sanitizedTarget)].join('|');
}
const SENSITIVE_SEGMENT = /key|token|secret|password|credential|id_rsa|\.env/i;
export interface SanitizeTargetOptions { home?: string; workspace?: string }
/** Reduce a target to a low-cardinality label; a sensitive word redacts its whole segment. */
export function sanitizeTarget(target: string, options: SanitizeTargetOptions = {}): string {
  const candidates: Array<{ prefix: string; label: string }> = [];
  if (options.home) candidates.push({ prefix: options.home, label: '<home>' });
  if (options.workspace) candidates.push({ prefix: options.workspace, label: '<ws>' });
  // Workspace often lives under home: the longest matching prefix wins.
  candidates.sort((a, b) => b.prefix.length - a.prefix.length);
  const match = candidates.find((c) => target.startsWith(c.prefix));
  let base = target;
  if (match) base = `${match.label}${target.slice(match.prefix.length)}`;
  else if (target.startsWith('/')) base = `<path>/${target.split('/').filter(Boolean).slice(-2).join('/')}`;
  return base.split('/').map((s) => (SENSITIVE_SEGMENT.test(s) ? '[redacted]' : s)).join('/');
}

/** Flatten untrusted text before it is placed inside an injected notice. */
export function sanitizeForPrompt(text: string): string {
  // Control chars by code point (eslint no-control-regex rejects a control-char regex).
  const flattened = Array.from(text, (ch) => {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\r' || ch === '\n') return ' ';
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return /\s/.test(ch) ? ' ' : '';
    return ch;
  }).join('').replace(/\s+/g, ' ').trim();
  return flattened.length > 200 ? `${flattened.slice(0, 200)}…` : flattened;
}
const NOTICE_MAX_CHARS = 800;
const NOTICE_FIELD_MAX_CHARS = 100;
function clipField(value: string): string {
  const clean = sanitizeForPrompt(value);
  return clean.length > NOTICE_FIELD_MAX_CHARS ? `${clean.slice(0, NOTICE_FIELD_MAX_CHARS)}…` : clean;
}
const ZH_SOURCE: Record<DenialSource, string> = { policy: '策略', timeout: '审批超时', controller: '用户' };
const EN_SOURCE: Record<DenialSource, string> = { policy: 'Policy', timeout: 'Approval timeout', controller: 'User' };
interface NoticeTemplate {
  header: (total: number) => string; line: (index: number, d: TurnDenial) => string;
  omitted: (count: number) => string; footer: string;
}

const ZH_TEMPLATE: NoticeTemplate = {
  header: (total) =>
    `[SYSTEM NOTICE] 非用户消息 | wayang 编排层注入\n上一回合有 ${total} 个工具调用被拒绝，操作均未执行：\n`,
  line: (index, d) =>
    `${index}) 工具=${clipField(d.toolName)}；拒绝来源=${ZH_SOURCE[d.source]}；原因=${clipField(d.reason)}；目标=${clipField(d.sanitizedTarget)}`,
  omitted: (count) => `…(还有 ${count} 条省略)\n`,
  footer:
    '请勿重复上述被拒操作；请改用其它合规方式继续完成任务，若确实无法继续，请明确说明原因。\n[/SYSTEM NOTICE]',
};

const EN_TEMPLATE: NoticeTemplate = {
  header: (total) =>
    `[SYSTEM NOTICE] not a user message | injected by wayang orchestrator\nIn the previous turn, ${total} tool calls were denied; none of them were executed:\n`,
  line: (index, d) =>
    `${index}) tool=${clipField(d.toolName)}; denied by=${EN_SOURCE[d.source]}; reason=${clipField(d.reason)}; target=${clipField(d.sanitizedTarget)}`,
  omitted: (count) => `…(${count} more omitted)\n`,
  footer:
    'Do not retry the denied operations above; use other compliant approaches to continue the task, or state clearly that you cannot proceed.\n[/SYSTEM NOTICE]',
};

/** A reissue notice for the agent. Only injectable denials are rendered; an
 * empty result (nothing injectable) must not be injected by the caller. */
export function buildDenialNotice(denials: TurnDenial[], locale: string = 'zh'): string {
  const injectable = denials.filter((d) => d.injectable === true);
  if (injectable.length === 0) return '';
  const template = locale.toLowerCase().startsWith('en') ? EN_TEMPLATE : ZH_TEMPLATE;
  const header = template.header(injectable.length);
  const lines = injectable.map((d, index) => template.line(index + 1, d));
  const render = (kept: number): string => {
    const omitted = lines.length - kept;
    const note = omitted > 0 ? template.omitted(omitted) : '';
    const body = lines.slice(0, kept).map((line) => `${line}\n`).join('');
    return `${header}${body}${note}${template.footer}`;
  };

  let kept = 0;
  while (kept < lines.length && render(kept + 1).length <= NOTICE_MAX_CHARS) kept += 1;
  const notice = render(kept);
  return notice.length <= NOTICE_MAX_CHARS ? notice : notice.slice(0, NOTICE_MAX_CHARS);
}

export function resetTurnGuard(now: number, wallLimitMs: number = TURN_LIMITS.MAX_RUN_WALL_MS): TurnGuardState {
  return {
    turnSeq: 0,
    denialReissues: 0,
    perKey: new Map<string, number>(),
    consecutiveDenialTurns: 0,
    runStartedAt: now,
    lastProgressSig: '',
    stagnantTurns: 0,
    wallLimitMs,
  };
}

export interface AdvanceGuardInput {
  category: TurnEndCategory;
  denials: TurnDenial[];
  progressSig: string;
  now: number;
}

/** Fold one finished turn into a fresh guard state. denialReissues is owned by the caller. */
export function advanceGuard(guard: TurnGuardState, input: AdvanceGuardInput): TurnGuardState {
  const { category, denials, progressSig } = input;
  const perKey = new Map(guard.perKey);
  if (category.startsWith('denied_by_')) {
    for (const d of denials) {
      const key = denialKey(d);
      perKey.set(key, (perKey.get(key) ?? 0) + 1);
    }
  }
  const stagnantTurns =
    progressSig !== '' && progressSig === guard.lastProgressSig ? guard.stagnantTurns + 1 : 0;

  return {
    ...guard,
    turnSeq: guard.turnSeq + 1,
    perKey,
    consecutiveDenialTurns: category.startsWith('denied_by_')
      ? guard.consecutiveDenialTurns + 1
      : 0,
    lastProgressSig: progressSig,
    stagnantTurns,
  };
}

export interface TurnNextAction {
  action: 'terminate' | 'continue' | 'reissue';
  reason?: string;
}

/**
 * Decide what to do after a turn ended. `now` is injectable so callers/tests can
 * keep wall-clock checks deterministic; the default is Date.now() as specified.
 */
export function decideNextAction(
  guard: TurnGuardState,
  category: TurnEndCategory,
  hasQueuedMessages: boolean,
  denials: TurnDenial[] = [],
  now: number = Date.now(),
): TurnNextAction {
  if (guard.turnSeq >= TURN_LIMITS.MAX_TURNS) {
    return { action: 'terminate', reason: `turn limit reached (${TURN_LIMITS.MAX_TURNS})` };
  }
  if (now - guard.runStartedAt > guard.wallLimitMs) {
    return { action: 'terminate', reason: 'run wall time exceeded' };
  }
  if (guard.stagnantTurns >= TURN_LIMITS.MAX_STAGNANT_TURNS) {
    return {
      action: 'terminate',
      reason: `no progress across ${TURN_LIMITS.MAX_STAGNANT_TURNS} turns`,
    };
  }
  if (category === 'our_cancel') return { action: 'terminate', reason: 'Aborted' };
  if (category === 'our_timeout') return { action: 'terminate', reason: 'request timed out' };

  if (category === 'denied_by_policy' || category === 'denied_by_timeout' || category === 'denied_by_user') {
    // Every denial source shares the reissue machinery: the refusal goes back
    // to the agent as an injectable SYSTEM NOTICE and the agent decides
    // whether to try a different approach or end. Only an exhausted reissue
    // budget (or a real cancel/timeout above) terminates.
    // Protocol-level denials (permissionMode 'agent') carry injectable=false:
    // there is nothing to put in a follow-up notice. Even though the category
    // is still denied_by_policy, a turn whose denials are ALL non-injectable
    // must terminate instead of reissuing an empty notice.
    if (denials.length > 0 && denials.every((d) => d.injectable === false)) {
      const tool = denials[0].toolName;
      return { action: 'terminate', reason: `non-injectable denial: ${tool}` };
    }
    if (guard.denialReissues >= TURN_LIMITS.MAX_DENIAL_REISSUES) {
      return {
        action: 'terminate',
        reason: `denial reissue budget exhausted (${TURN_LIMITS.MAX_DENIAL_REISSUES}/${TURN_LIMITS.MAX_DENIAL_REISSUES})`,
      };
    }
    // MAX_CONSECUTIVE_DENIAL_TURNS is part of the state contract; two denial
    // turns in a row stop the loop even when each denial has a different key.
    if (guard.consecutiveDenialTurns >= TURN_LIMITS.MAX_CONSECUTIVE_DENIAL_TURNS) {
      return {
        action: 'terminate',
        reason: `consecutive denial turns reached (${TURN_LIMITS.MAX_CONSECUTIVE_DENIAL_TURNS})`,
      };
    }
    const source: DenialSource =
      category === 'denied_by_policy' ? 'policy' : category === 'denied_by_timeout' ? 'timeout' : 'controller';
    for (const d of denials.filter((item) => item.source === source)) {
      for (const key of [d.key, denialKey(d)]) {
        if ((guard.perKey.get(key) ?? 0) >= TURN_LIMITS.MAX_PER_KEY) {
          return { action: 'terminate', reason: `per-key budget exhausted: ${key}` };
        }
      }
    }
    return { action: 'reissue' };
  }

  if (category === 'agent_ended_unexpectedly') {
    return hasQueuedMessages
      ? { action: 'continue' }
      : { action: 'terminate', reason: 'agent ended the turn unexpectedly' };
  }
  return hasQueuedMessages ? { action: 'continue' } : { action: 'terminate' };
}

export interface TurnEndErrorOptions {
  /** stopReason of the turn, used by the 'agent_ended_unexpectedly' wording. */
  stopReason?: string;
}

/** Short error text for the orchestrator. Independent of the injected notice. */
export function turnEndErrorText(
  category: TurnEndCategory,
  denials: TurnDenial[],
  options: TurnEndErrorOptions = {},
): string {
  const winner: DenialSource | null =
    category === 'denied_by_policy'
      ? 'policy'
      : category === 'denied_by_timeout'
        ? 'timeout'
        : category === 'denied_by_user'
          ? 'controller'
          : null;
  if (winner) {
    const toolName =
      denials.find((d) => d.source === winner)?.toolName ?? denials[0]?.toolName ?? 'unknown';
    const wording: Record<DenialSource, string> = {
      policy: `Permission denied by policy: ${toolName}`,
      timeout: `Permission request timed out: ${toolName}`,
      controller: `Permission denied by user: ${toolName}`,
    };
    return wording[winner];
  }
  switch (category) {
    case 'our_cancel':
      return 'Aborted';
    case 'our_timeout':
      return 'ACP worker request timed out';
    case 'agent_ended_unexpectedly':
      return `ACP worker ended the turn unexpectedly (stopReason=${options.stopReason ?? 'unknown'})`;
    case 'completed':
      return '';
    default:
      return '';
  }
}
