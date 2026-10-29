/**
 * E2E: session resume across server process restarts.
 *
 * Regression guard for the `--home-dir` double-join bug: `--home-dir` has
 * ROOT semantics — the server joins `.wayang` itself, so sessions must live
 * under `<home>/.wayang/sessions`, and a second server process spawned the
 * way the TUI client does (same root, `--session resume:<id>`) must find and
 * restore the session.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setupE2E, type E2ESetup } from '../harness';
import { isControllerRequest } from '@/__tests__/fake-openai-provider';

const setups: E2ESetup[] = [];
let leftoverRoot: string | undefined;

afterAll(async () => {
  for (const s of setups) await s.dispose();
  // If the test failed between server #1 shutdown and server #2 cleanup.
  if (leftoverRoot) rmSync(leftoverRoot, { recursive: true, force: true });
});

describe('e2e: resume across server restarts', () => {
  it('session lives under <home>/.wayang/sessions and is restorable by a resumed server', async () => {
    // --- Server #1: new session, one controller exchange to persist. ---
    const s1 = await setupE2E([
      { match: isControllerRequest, text: 'Noted: alpha-marker.' },
    ]);
    setups.push(s1);

    await s1.submit('remember alpha-marker');
    await s1.waitFor('controller reply', (s) =>
      JSON.stringify(s.conversation).includes('Noted: alpha-marker.'));

    // `--home-dir` is a root: sessions land in <root>/home/.wayang/sessions.
    // (The double-join regression put them under <root>/home/.wayang/.wayang.)
    const sessionDir = join(s1.root, 'home', '.wayang', 'sessions', s1.sessionId);
    expect(existsSync(join(sessionDir, 'meta.json'))).toBe(true);

    const { sessionId, root, provider } = s1;
    leftoverRoot = root;
    // Graceful shutdown of server #1; keep session data + fake provider.
    await s1.dispose({ root: true, provider: true });

    // --- Server #2: same root, explicit resume — exactly what the TUI
    // client spawns after finding the session (bootstrap passes the ROOT
    // as --home-dir and the server resolves .wayang itself). ---
    const s2 = await setupE2E([], { session: `resume:${sessionId}`, root, provider });
    setups.push(s2);

    expect(s2.sessionId).toBe(sessionId);
    expect(s2.sessionDir).toBe(sessionDir);

    // Conversation restored from disk by the new process.
    await s2.waitFor('conversation restored', (s) =>
      JSON.stringify(s.conversation).includes('alpha-marker'));

    leftoverRoot = undefined; // s2.dispose() (afterAll) removes the root
  }, 90_000);
});
