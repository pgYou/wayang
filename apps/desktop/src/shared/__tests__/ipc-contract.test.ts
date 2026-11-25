import { describe, it, expect } from 'vitest';
import {
  IPC,
  IPC_INVOKE_CHANNELS,
  IPC_SUBSCRIBE,
  STATE_SLICE_PATHS,
  SLICE,
  IPC_ARG_VALIDATORS,
  DEFAULT_INVOKE_TIMEOUT_MS,
  INVOKE_TIMEOUT_OVERRIDES_MS,
  invokeTimeoutMs,
  sliceKey,
} from '../ipc-contract';
import { CONTEXT_USAGE_STATE_PATH } from '@wayang-ai/core/client/remote-supervisor';

/**
 * Single-contract pins (§2.2, 4.2 域二工作项①): the contract file is the
 * ONLY channel source — every channel name carries the `wayang:` prefix, the
 * slice map and the subscription table are one table, and the validators /
 * timeouts actually key off the contract's own channel names.
 */
describe('IPC channel contract', () => {
  it('every channel name uses the wayang: prefix (preload whitelist form)', () => {
    for (const channel of [...Object.values(IPC), ...Object.values(IPC_SUBSCRIBE)]) {
      expect(channel.startsWith('wayang:')).toBe(true);
    }
  });

  it('lists the §2.2 table plus the 域三 config/onboard channels and 2 subscriptions', () => {
    expect(Object.values(IPC)).toEqual([
      'wayang:sendInput',
      'wayang:abort',
      'wayang:answerInquiry',
      'wayang:respondPermission',
      'wayang:listTasks',
      'wayang:cancelTask',
      'wayang:contextUsage',
      'wayang:getInitialState',
      'wayang:newSession',
      'wayang:switchSession',
      'wayang:listSessions',
      'wayang:rendererLog',
      'wayang:getOnboardState',
      'wayang:importCliConfig',
      'wayang:saveConfig',
      'wayang:readConfig',
      'wayang:chooseDirectory',
      'wayang:restartServer',
    ]);
    expect(Object.values(IPC_SUBSCRIBE)).toEqual(['wayang:state', 'wayang:status']);
  });

  it('IPC_INVOKE_CHANNELS matches the invoke contract keys one-to-one', () => {
    expect(new Set(IPC_INVOKE_CHANNELS)).toEqual(new Set(Object.values(IPC)));
    for (const channel of Object.values(IPC)) {
      expect(IPC_ARG_VALIDATORS[channel]).toBeTypeOf('function');
    }
  });

  it('the state slice map and the subscription table are one table', () => {
    const subscribed = STATE_SLICE_PATHS.map(([target, path]) => sliceKey(target, path));
    expect(new Set(subscribed)).toEqual(new Set(Object.values(SLICE)));
    expect(subscribed).toHaveLength(STATE_SLICE_PATHS.length);
    // Dead path stays dead (§4.1 工作项③ pin, kept on the contract level).
    expect(subscribed).not.toContain('engine:tasks.completed');
  });

  it("the contextUsage slice mirrors core's shared state-path literal", () => {
    expect(SLICE.contextUsage).toBe(`controllerAgent:${CONTEXT_USAGE_STATE_PATH}`);
  });
});

describe('IPC arg validators', () => {
  it('accepts well-formed arguments', () => {
    expect(IPC_ARG_VALIDATORS[IPC.sendInput](['hello'])).toBeNull();
    expect(IPC_ARG_VALIDATORS[IPC.abort]([])).toBeNull();
    expect(IPC_ARG_VALIDATORS[IPC.respondPermission]([{ requestId: 'r1', approved: true, reason: 'ok' }])).toBeNull();
    expect(IPC_ARG_VALIDATORS[IPC.switchSession](['session-9'])).toBeNull();
    expect(IPC_ARG_VALIDATORS[IPC.rendererLog]([{ level: 'warn', message: 'x' }])).toBeNull();
  });

  it('rejects malformed arguments with a precise message', () => {
    expect(IPC_ARG_VALIDATORS[IPC.sendInput]([42])).toMatch(/text/);
    expect(IPC_ARG_VALIDATORS[IPC.sendInput]([])).toMatch(/exactly one/);
    expect(IPC_ARG_VALIDATORS[IPC.respondPermission]([{ requestId: 'r1' }])).toMatch(/approved/);
    expect(IPC_ARG_VALIDATORS[IPC.switchSession]([''])).toMatch(/non-empty/);
    expect(IPC_ARG_VALIDATORS[IPC.rendererLog]([{ level: 'loud', message: 'x' }])).toMatch(/level/);
  });
});

describe('invoke timeouts', () => {
  const WIDE = [IPC.newSession, IPC.switchSession, IPC.saveConfig, IPC.restartServer] as const;

  it('defaults every channel to the shared guard', () => {
    for (const channel of Object.values(IPC)) {
      if ((WIDE as readonly string[]).includes(channel)) continue;
      expect(invokeTimeoutMs(channel)).toBe(DEFAULT_INVOKE_TIMEOUT_MS);
    }
  });

  it('session boots and config saves/boots get the wider guard and only those', () => {
    for (const channel of WIDE) {
      expect(invokeTimeoutMs(channel)).toBeGreaterThan(DEFAULT_INVOKE_TIMEOUT_MS);
    }
    expect(Object.keys(INVOKE_TIMEOUT_OVERRIDES_MS)).toHaveLength(WIDE.length);
  });
});
