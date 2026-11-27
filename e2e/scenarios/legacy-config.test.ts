import { describe, it, expect, afterAll } from 'vitest';
import { setupE2E, type E2ESetup } from '../harness';
import { isControllerRequest } from '@/__tests__/fake-openai-provider';

let setup: E2ESetup | undefined;
afterAll(async () => { await setup?.dispose(); });

// An existing user's config file may still be written the pre-#88 way
// (`~/.wayang.config.json`: provider `endpoint` + `modelName`, provider-key
// bindings). core accepts the canonical shape ONLY — its intake refuses any
// other — so this must keep working end to end through the one place that
// deals with the difference: the CLI's config entry.
describe('e2e: a pre-#88 config file keeps working', () => {
  it('boots on the legacy spelling, reports each translation once, and serves normally', async () => {
    setup = await setupE2E([{ match: isControllerRequest, text: 'Legacy config booted fine.' }], { configShape: 'legacy' });

    await setup.submit('hello from a legacy config');
    await setup.waitFor('controller reply', (s) => JSON.stringify(s.conversation).includes('Legacy config booted fine.'));

    // The server reached READY — core's intake accepted the config it was
    // handed, i.e. the CLI entry handed over the canonical translation.
    expect(setup.sessionId).not.toBe('');
    // Each translated spelling is surfaced once, at load.
    const stderr = setup.stderr();
    expect(stderr).toContain('providers.fake.endpoint is deprecated — translated to baseURL');
    expect(stderr).toContain('providers.fake.modelName is deprecated — translated to models.fake');
    expect(stderr).toContain('controller.provider is deprecated — translated to controller.model = "fake"');
    expect(stderr).toContain('worker.provider is deprecated — translated to worker.model = "fake"');
  }, 60_000);
});
