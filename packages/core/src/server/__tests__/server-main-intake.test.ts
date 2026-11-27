/**
 * serverMain's config intake: core accepts the canonical shape only. A config
 * that still carries a deprecated key, or fails validation, is a structured
 * CONFIG_INVALID boot error and the server never boots — the host translates
 * the legacy spellings at its config entry (protocol normalizeConfig), core
 * has no compat branch.
 *
 * The server itself is mocked: this suite pins the intake only.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WayangConfig } from '@wayang-ai/protocol';

const { runWayangServer } = vi.hoisted(() => ({ runWayangServer: vi.fn(async (_options: unknown) => undefined) }));
vi.mock('../wayang-server', () => ({ runWayangServer }));

import { ServerBootError, serverMain } from '../main';

const canonical: WayangConfig = {
  providers: { p: { baseURL: 'http://localhost:1', apiKey: 'k' } },
  models: { p: { provider: 'p', name: 'm' } },
  controller: { model: 'p' },
  worker: { model: 'p', maxConcurrency: 1 },
};

function options(config: unknown) {
  return { config: config as WayangConfig, dataDir: '/tmp/wayang-intake', workspaceDir: '/tmp/ws', session: 'new', injectPreviousTasks: false };
}

beforeEach(() => {
  runWayangServer.mockClear();
});

describe('serverMain config intake (canonical only)', () => {
  it('accepts a canonical config and hands it to the server untouched', async () => {
    await serverMain(options(canonical));
    expect(runWayangServer).toHaveBeenCalledTimes(1);
    expect(runWayangServer.mock.calls[0]?.[0]).toMatchObject({ config: canonical });
  });

  it('refuses a config that still carries a legacy key — the server never boots', async () => {
    // A host that only half-translated: the model reference is there, the
    // deprecated provider-key binding was left behind.
    const legacy = { ...canonical, controller: { model: 'p', provider: 'p' } };
    const boot = serverMain(options(legacy));
    await expect(boot).rejects.toBeInstanceOf(ServerBootError);
    await expect(boot).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(boot).rejects.toThrow(/deprecated keys \(controller\.provider\)/);
    expect(runWayangServer).not.toHaveBeenCalled();
  });

  it('refuses a structurally invalid config the same way', async () => {
    const broken = { ...canonical, providers: { p: { apiKey: 'k' } } };
    const boot = serverMain(options(broken));
    await expect(boot).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(boot).rejects.toThrow(/providers\.p\.baseURL is required/);
    expect(runWayangServer).not.toHaveBeenCalled();
  });

  it('reports a malformed top level instead of leaking a TypeError', async () => {
    const boot = serverMain(options({ controller: {}, worker: {} }));
    await expect(boot).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(boot).rejects.toThrow(/malformed config/);
    expect(runWayangServer).not.toHaveBeenCalled();
  });

  it('a missing config object stays CONFIG_MISSING', async () => {
    await expect(serverMain(options(undefined))).rejects.toMatchObject({ code: 'CONFIG_MISSING' });
    await expect(serverMain(options([]))).rejects.toMatchObject({ code: 'CONFIG_MISSING' });
    expect(runWayangServer).not.toHaveBeenCalled();
  });
});
