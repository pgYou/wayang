import { describe, it, expect } from 'vitest';
import {
  advanceGuard,
  buildDenialNotice,
  classifyTurnEnd,
  decideNextAction,
  denialKey,
  resetTurnGuard,
  sanitizeForPrompt,
  sanitizeTarget,
  turnEndErrorText,
  TURN_LIMITS,
} from '@/services/agents/acp/turn-attribution';
import type {
  TurnDenial,
  TurnGuardState,
} from '@/services/agents/acp/turn-attribution';

const NOW = 1_700_000_000_000;

function denial(overrides: Partial<TurnDenial> = {}): TurnDenial {
  const base: Omit<TurnDenial, 'key'> = {
    source: 'policy',
    toolName: 'bash',
    reason: '策略禁止该操作',
    sanitizedTarget: '<ws>/src/index.ts',
    injectable: true,
  };
  const merged = { ...base, ...overrides };
  return { ...merged, key: overrides.key ?? denialKey(merged) };
}

function guard(overrides: Partial<TurnGuardState> = {}): TurnGuardState {
  return { ...resetTurnGuard(NOW), ...overrides };
}

function classify(overrides: Partial<Parameters<typeof classifyTurnEnd>[0]> = {}) {
  return classifyTurnEnd({
    stopReason: 'cancelled',
    cancelFact: null,
    denials: [],
    hasQueuedMessages: false,
    ...overrides,
  });
}

describe('classifyTurnEnd', () => {
  it('abort fact → our_cancel', () => {
    expect(classify({ cancelFact: 'abort' })).toBe('our_cancel');
  });

  it('prompt-timeout fact → our_timeout', () => {
    expect(classify({ cancelFact: 'prompt-timeout' })).toBe('our_timeout');
  });

  it('denials containing policy → denied_by_policy (policy beats the other sources)', () => {
    const denials = [
      denial({ source: 'controller', toolName: 'read' }),
      denial({ source: 'timeout', toolName: 'bash' }),
      denial({ source: 'policy', toolName: 'edit_file' }),
    ];
    expect(classify({ denials })).toBe('denied_by_policy');
  });

  it('controller + timeout denials → denied_by_timeout', () => {
    const denials = [
      denial({ source: 'controller', toolName: 'read' }),
      denial({ source: 'timeout', toolName: 'bash' }),
    ];
    expect(classify({ denials })).toBe('denied_by_timeout');
  });

  it('only a controller denial → denied_by_user', () => {
    expect(classify({ denials: [denial({ source: 'controller' })] })).toBe('denied_by_user');
  });

  it('stopReason end_turn with no denials → completed', () => {
    expect(classify({ stopReason: 'end_turn', hasQueuedMessages: true })).toBe('completed');
  });

  it('cancelled with no cancel fact and no denials → agent_ended_unexpectedly', () => {
    expect(classify({ stopReason: 'cancelled' })).toBe('agent_ended_unexpectedly');
  });

  it('priority boundary: abort + denials → our_cancel', () => {
    expect(
      classify({ cancelFact: 'abort', denials: [denial({ source: 'policy' })] }),
    ).toBe('our_cancel');
  });

  it('priority boundary: prompt-timeout + denials → our_timeout', () => {
    expect(
      classify({ cancelFact: 'prompt-timeout', denials: [denial({ source: 'policy' })] }),
    ).toBe('our_timeout');
  });

  it('denials beat stopReason end_turn', () => {
    expect(
      classify({ stopReason: 'end_turn', denials: [denial({ source: 'timeout' })] }),
    ).toBe('denied_by_timeout');
  });
});

describe('decideNextAction', () => {
  it('perKey at MAX_PER_KEY → terminate with the key in the reason', () => {
    const d = denial({ source: 'policy', toolName: 'bash' });
    const key = denialKey(d);
    const result = decideNextAction(
      guard({ perKey: new Map([[key, TURN_LIMITS.MAX_PER_KEY]]) }),
      'denied_by_policy',
      true,
      [d],
      NOW,
    );
    expect(result.action).toBe('terminate');
    expect(result.reason).toContain(key);
    expect(result.reason).toContain('per-key budget exhausted');
  });

  it('denialReissues at 3 → terminate with budget in the reason', () => {
    const result = decideNextAction(
      guard({ denialReissues: 3 }),
      'denied_by_timeout',
      true,
      [denial({ source: 'timeout' })],
      NOW,
    );
    expect(result.action).toBe('terminate');
    expect(result.reason).toContain('budget');
    expect(result.reason).toBe('denial reissue budget exhausted (3/3)');
  });

  it('two consecutive denial turns → terminate', () => {
    const d1 = denial({ toolName: 'bash', sanitizedTarget: '/a' });
    const d2 = denial({ toolName: 'read_file', sanitizedTarget: '/b' });
    const isolated = decideNextAction(
      guard({ consecutiveDenialTurns: 2 }),
      'denied_by_policy',
      true,
      [d2],
      NOW,
    );
    expect(isolated.action).toBe('terminate');

    let chained = resetTurnGuard(NOW);
    chained = advanceGuard(chained, {
      category: 'denied_by_policy', denials: [d1], progressSig: 'sig-1', now: NOW,
    });
    chained = advanceGuard(chained, {
      category: 'denied_by_policy', denials: [d2], progressSig: 'sig-2', now: NOW,
    });
    expect(chained.consecutiveDenialTurns).toBe(2);
    expect(decideNextAction(chained, 'denied_by_policy', true, [d2], NOW).action).toBe('terminate');
  });

  it('stagnantTurns at 2 (same progressSig) → terminate', () => {
    const result = decideNextAction(guard({ stagnantTurns: 2 }), 'completed', true, [], NOW);
    expect(result.action).toBe('terminate');
    expect(result.reason).toBe('no progress across 2 turns');
  });

  it('turnSeq at 12 → terminate with the turn limit reason', () => {
    const result = decideNextAction(guard({ turnSeq: 12 }), 'completed', true, [], NOW);
    expect(result.action).toBe('terminate');
    expect(result.reason).toBe('turn limit reached (12)');
  });

  it('runStartedAt far in the past → wall-time terminate', () => {
    const g = guard({ runStartedAt: NOW - TURN_LIMITS.MAX_RUN_WALL_MS - 1 });
    const result = decideNextAction(g, 'completed', true, [], NOW);
    expect(result.action).toBe('terminate');
    expect(result.reason).toBe('run wall time exceeded');
  });

  it('our_cancel → terminate "Aborted"; our_timeout → "request timed out"', () => {
    expect(decideNextAction(guard(), 'our_cancel', false, [], NOW)).toEqual({
      action: 'terminate', reason: 'Aborted',
    });
    expect(decideNextAction(guard(), 'our_timeout', false, [], NOW)).toEqual({
      action: 'terminate', reason: 'request timed out',
    });
  });

  it('denied_by_user → terminate "denied by user"', () => {
    expect(decideNextAction(guard(), 'denied_by_user', true, [], NOW)).toEqual({
      action: 'terminate', reason: 'denied by user',
    });
  });

  it('fresh policy/timeout denial → reissue', () => {
    expect(decideNextAction(guard(), 'denied_by_policy', true, [], NOW)).toEqual({ action: 'reissue' });
    expect(decideNextAction(guard(), 'denied_by_timeout', true, [], NOW)).toEqual({ action: 'reissue' });
  });

  it('unexpected end: queued messages → continue, otherwise terminate with reason', () => {
    expect(decideNextAction(guard(), 'agent_ended_unexpectedly', true, [], NOW)).toEqual({
      action: 'continue',
    });
    expect(decideNextAction(guard(), 'agent_ended_unexpectedly', false, [], NOW)).toEqual({
      action: 'terminate', reason: 'agent ended the turn unexpectedly',
    });
  });

  it('completed: queued messages → continue, otherwise terminate', () => {
    expect(decideNextAction(guard(), 'completed', true, [], NOW)).toEqual({ action: 'continue' });
    expect(decideNextAction(guard(), 'completed', false, [], NOW)).toEqual({ action: 'terminate' });
  });

  it('turnSeq 11 with queued messages still continues (boundary below the limit)', () => {
    expect(decideNextAction(guard({ turnSeq: 11 }), 'completed', true, [], NOW)).toEqual({
      action: 'continue',
    });
  });
});

describe('resetTurnGuard / advanceGuard', () => {
  it('resetTurnGuard returns the exact initial state', () => {
    expect(resetTurnGuard(NOW)).toEqual({
      turnSeq: 0,
      denialReissues: 0,
      perKey: new Map<string, number>(),
      consecutiveDenialTurns: 0,
      runStartedAt: NOW,
      lastProgressSig: '',
      stagnantTurns: 0,
    });
  });

  it('advanceGuard increments turnSeq, perKey and consecutive denial turns without mutating input', () => {
    const d = denial({ source: 'timeout', toolName: 'bash' });
    const g0 = resetTurnGuard(NOW);
    const g1 = advanceGuard(g0, {
      category: 'denied_by_timeout', denials: [d], progressSig: 'p1', now: NOW,
    });
    expect(g1.turnSeq).toBe(1);
    expect(g1.perKey.get(denialKey(d))).toBe(1);
    expect(g1.consecutiveDenialTurns).toBe(1);
    expect(g1.lastProgressSig).toBe('p1');
    expect(g1.stagnantTurns).toBe(0);
    expect(g1.denialReissues).toBe(0);
    expect(g1.runStartedAt).toBe(NOW);
    expect(g0.turnSeq).toBe(0);
    expect(g0.perKey.size).toBe(0);
    expect(g0.lastProgressSig).toBe('');
  });

  it('advanceGuard counts stagnation only for a repeated non-empty progressSig', () => {
    let g = resetTurnGuard(NOW);
    g = advanceGuard(g, { category: 'completed', denials: [], progressSig: 'p1', now: NOW });
    expect(g.stagnantTurns).toBe(0);
    g = advanceGuard(g, { category: 'completed', denials: [], progressSig: 'p1', now: NOW });
    expect(g.stagnantTurns).toBe(1);
    g = advanceGuard(g, { category: 'completed', denials: [], progressSig: 'p1', now: NOW });
    expect(g.stagnantTurns).toBe(2);
    g = advanceGuard(g, { category: 'completed', denials: [], progressSig: '', now: NOW });
    expect(g.stagnantTurns).toBe(0);
    expect(g.lastProgressSig).toBe('');
  });

  it('advanceGuard resets consecutiveDenialTurns on a non-denial turn', () => {
    const g1 = advanceGuard(resetTurnGuard(NOW), {
      category: 'denied_by_user', denials: [], progressSig: 'x', now: NOW,
    });
    expect(g1.consecutiveDenialTurns).toBe(1);
    const g2 = advanceGuard(g1, {
      category: 'completed', denials: [], progressSig: 'y', now: NOW,
    });
    expect(g2.consecutiveDenialTurns).toBe(0);
    expect(g2.denialReissues).toBe(0);
  });
});

describe('sanitizeTarget', () => {
  it('home prefix → <home>', () => {
    expect(
      sanitizeTarget('/data/home/lukegypeng/notes.txt', { home: '/data/home/lukegypeng' }),
    ).toBe('<home>/notes.txt');
  });

  it('workspace prefix → <ws> even when it also sits under home', () => {
    expect(
      sanitizeTarget('/data/home/lukegypeng/code/wayang-092-loop/src/a.ts', {
        home: '/data/home/lukegypeng',
        workspace: '/data/home/lukegypeng/code/wayang-092-loop',
      }),
    ).toBe('<ws>/src/a.ts');
  });

  it('other absolute paths keep only the last two segments with <path>', () => {
    expect(sanitizeTarget('/usr/local/lib/node_modules/foo/bar.js', {})).toBe('<path>/foo/bar.js');
  });

  it('a segment matching sensitive words is fully replaced with [redacted]', () => {
    expect(sanitizeTarget('/etc/.env.production', {})).toBe('<path>/etc/[redacted]');
    expect(
      sanitizeTarget('/home/u/keys/id_rsa', { home: '/home/u' }),
    ).toBe('<home>/[redacted]/[redacted]');
  });
});

describe('sanitizeForPrompt', () => {
  it('truncates long text at 200 chars and appends an ellipsis', () => {
    const result = sanitizeForPrompt('x'.repeat(250));
    expect(result).toBe(`${'x'.repeat(200)}…`);
    expect(result.length).toBe(201);
  });

  it('flattens newlines, strips control chars and collapses whitespace', () => {
    const result = sanitizeForPrompt('a\n\nb\u0007c   d\t e\r\nf');
    expect(result).toBe('a bc d e f');
    expect(result).not.toContain('\n');
    expect(result).not.toContain('\r');
    expect(result).not.toContain('\t');
    expect(Array.from(result).every((ch) => ch.charCodeAt(0) >= 0x20)).toBe(true);
  });

  it('short text is returned trimmed and unchanged', () => {
    expect(sanitizeForPrompt('  hello   world  ')).toBe('hello world');
  });
});

describe('denialKey', () => {
  it('normalizes case and extra whitespace, and is stable across equivalent inputs', () => {
    const a = denialKey({
      source: 'Policy', toolName: '  Bash   Tool  ', sanitizedTarget: '/WS/Some   Path',
    });
    const b = denialKey({
      source: 'policy', toolName: 'bash tool', sanitizedTarget: '/ws/some path',
    });
    expect(a).toBe('policy|bash tool|/ws/some path');
    expect(b).toBe(a);
  });
});

describe('buildDenialNotice', () => {
  it('renders the Chinese template verbatim for a single denial', () => {
    const d = denial({
      source: 'policy', toolName: 'bash', reason: '策略禁止', sanitizedTarget: '<ws>/x',
    });
    expect(buildDenialNotice([d])).toBe(
      [
        '[SYSTEM NOTICE] 非用户消息 | wayang 编排层注入',
        '上一回合有 1 个工具调用被拒绝，操作均未执行：',
        '1) 工具=bash；拒绝来源=策略；原因=策略禁止；目标=<ws>/x',
        '请勿重复上述被拒操作；请改用其它合规方式继续完成任务，若确实无法继续，请明确说明原因。',
        '[/SYSTEM NOTICE]',
      ].join('\n'),
    );
  });

  it('caps length at 800, keeps the notice markers, and appends the omission count', () => {
    const denials = Array.from({ length: 40 }, (_, i) =>
      denial({
        source: i % 3 === 0 ? 'policy' : i % 3 === 1 ? 'timeout' : 'controller',
        toolName: `tool_${i}`,
        reason: `原因 ${i} `.repeat(20),
        sanitizedTarget: `<ws>/dir_${i}/file_${i}`,
      }),
    );
    const notice = buildDenialNotice(denials);
    expect(notice.length).toBeLessThanOrEqual(800);
    expect(notice).toContain('[SYSTEM NOTICE]');
    expect(notice).toContain('[SYSTEM NOTICE] 非用户消息 | wayang 编排层注入');
    expect(notice).toContain('[/SYSTEM NOTICE]');
    expect(notice).toContain('上一回合有 40 个工具调用被拒绝，操作均未执行：');
    expect(notice).toContain('…(还有');
    expect(notice).toContain('条省略)');
    expect(notice).not.toContain('[Controller message]');
  });

  it('renders the English structure with tool / denied by / reason / target', () => {
    const notice = buildDenialNotice([denial({ toolName: 'bash', reason: 'blocked' })], 'en');
    expect(notice).toContain('[SYSTEM NOTICE]');
    expect(notice).toContain('[SYSTEM NOTICE] not a user message | injected by wayang orchestrator');
    expect(notice).toContain('1) tool=bash; denied by=Policy; reason=blocked; target=');
    expect(notice).toContain('Do not retry the denied operations above');
    expect(notice).toContain('[/SYSTEM NOTICE]');
    expect(notice).not.toContain('[Controller message]');
    expect(notice.length).toBeLessThanOrEqual(800);
  });

  it('an empty denial list produces a well-formed notice without an omission note', () => {
    const notice = buildDenialNotice([]);
    expect(notice).toContain('上一回合有 0 个工具调用被拒绝');
    expect(notice).not.toContain('条省略');
    expect(notice.endsWith('[/SYSTEM NOTICE]')).toBe(true);
  });
});

describe('turnEndErrorText', () => {
  const g = guard();

  it('returns the specified wording for every category', () => {
    expect(turnEndErrorText('our_cancel', g, [])).toBe('Aborted');
    expect(turnEndErrorText('our_timeout', g, [])).toBe('ACP worker request timed out');
    expect(
      turnEndErrorText('denied_by_user', g, [denial({ source: 'controller', toolName: 'read' })]),
    ).toBe('Permission denied by user: read');
    expect(
      turnEndErrorText('denied_by_policy', g, [denial({ toolName: 'bash' })]),
    ).toBe('Permission denied by policy: bash');
    expect(
      turnEndErrorText('denied_by_timeout', g, [denial({ source: 'timeout', toolName: 'edit_file' })]),
    ).toBe('Permission request timed out: edit_file');
    expect(
      turnEndErrorText('agent_ended_unexpectedly', g, [], { stopReason: 'cancelled' }),
    ).toBe('ACP worker ended the turn unexpectedly (stopReason=cancelled)');
    expect(turnEndErrorText('completed', g, [])).toBe('');
  });

  it('picks the tool of the winning source by priority', () => {
    const denials = [
      denial({ source: 'controller', toolName: 'read' }),
      denial({ source: 'policy', toolName: 'edit_file' }),
    ];
    expect(turnEndErrorText('denied_by_policy', g, denials)).toBe(
      'Permission denied by policy: edit_file',
    );
  });

  it('does not reuse the injected notice string', () => {
    const d = denial({ toolName: 'bash' });
    const notice = buildDenialNotice([d]);
    const error = turnEndErrorText('denied_by_policy', g, [d]);
    expect(error).not.toBe(notice);
    expect(error).not.toContain('[SYSTEM NOTICE]');
    expect(notice).not.toContain(error);
  });
});
