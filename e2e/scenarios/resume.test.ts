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
import { isControllerRequest, isSummarizerRequest, isWorkerRequest } from '@/__tests__/fake-openai-provider';
import { METHOD } from '@/rpc/protocol';

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

describe('e2e: turn index across server restarts', () => {
  it('conversation RPCs expose pre-resume turns with lineage, status, and no compact leakage', async () => {
    // --- Server #1: one full task chain — user → add_task → worker done → reply.
    const s1 = await setupE2E([
      {
        match: isControllerRequest,
        toolCalls: [{
          name: 'add_task',
          args: { title: 'Resume turn task', description: 'Do the thing, then report done.', priority: 'normal' },
        }],
      },
      { match: isControllerRequest, text: 'Dispatched the resume-marker task.' },
      { match: isWorkerRequest, toolCalls: [{ name: 'done', args: { summary: 'Resume task finished' } }] },
      { match: isControllerRequest, text: 'Task finished successfully.' },
    ]);
    setups.push(s1);

    await s1.submit('run the resume turn task');
    await s1.waitFor('controller final reply', (s) =>
      JSON.stringify(s.conversation).includes('Task finished successfully.'));
    await s1.waitFor('task completed in history', (s) =>
      s.history.length === 1 && s.history[0].status === 'completed');

    const { sessionId, root, provider } = s1;
    leftoverRoot = root;
    await s1.dispose({ root: true, provider: true });

    // --- Server #2: same root, resume. setupE2E ignores the script arg when
    // reusing a provider, so re-script it explicitly afterwards — the
    // compaction below is the only LLM call after restore.
    const s2 = await setupE2E([], { session: `resume:${sessionId}`, root, provider });
    setups.push(s2);
    expect(s2.sessionId).toBe(sessionId);
    provider.reset([
      { match: isSummarizerRequest, text: 'E2E COMPACT SUMMARY MARKER 8347 text' },
    ]);

    // Conversation restored from disk before any assertions.
    await s2.waitFor('conversation restored', (s) =>
      JSON.stringify(s.conversation).includes('run the resume turn task'));

    // --- conversation_list_turns: pre-resume turns are visible ---
    const list = await s2.client.request<{
      total: number;
      turns: Array<{
        turnId: string;
        rootTurnId?: string;
        status: string;
        stepCount: number;
        signalCount: number;
        userPreview?: string;
      }>;
    }>(METHOD.CONVERSATION_LIST_TURNS, {});
    expect(list.total).toBeGreaterThanOrEqual(2);

    const [dispatchTurn, replyTurn] = list.turns;
    expect(dispatchTurn.userPreview).toContain('run the resume turn task');
    // Lineage: the dispatching user turn is its own root; the reply turn
    // (woken by the worker-completed signal) inherits that root.
    expect(dispatchTurn.rootTurnId).toBe(dispatchTurn.turnId);
    expect(replyTurn.rootTurnId).toBe(dispatchTurn.turnId);
    expect(replyTurn.signalCount).toBe(1);
    // Status sanity: task completed → both turns completed (not failed).
    expect(dispatchTurn.status).toBe('completed');
    expect(replyTurn.status).toBe('completed');

    // --- conversation_get_turn: full structure + tool-call lineage ---
    const full = await s2.client.request<{
      turnId: string;
      status: string;
      userEntry?: { content: string };
      steps: Array<{ content: string; toolCalls?: unknown[] }>;
      toolCalls: Array<{ toolName: string; taskId?: string }>;
      signals: Array<{ subtype: string; taskId?: string }>;
    }>(METHOD.CONVERSATION_GET_TURN, { turnId: dispatchTurn.turnId });
    expect(full.userEntry?.content).toContain('run the resume turn task');
    expect(full.steps.some(st => st.content.includes('Dispatched the resume-marker task.'))).toBe(true);
    expect(full.toolCalls.some(tc => tc.toolName === 'add_task' && tc.taskId)).toBe(true);

    const reply = await s2.client.request<{
      status: string;
      signals: Array<{ subtype: string; taskId?: string }>;
      steps: Array<{ content: string }>;
    }>(METHOD.CONVERSATION_GET_TURN, { turnId: replyTurn.turnId });
    expect(reply.signals[0].subtype).toBe('worker_completed');
    // The completing signal resolves exactly the task the dispatch turn created.
    const addTaskCall = full.toolCalls.find(tc => tc.toolName === 'add_task');
    expect(reply.signals[0].taskId).toBe(addTaskCall?.taskId);
    expect(reply.steps.some(st => st.content.includes('Task finished successfully.'))).toBe(true);

    // --- Compact after resume: the marker must never surface as turn content ---
    await s2.client.request(METHOD.PERFORM_COMPACTION);
    await s2.waitFor('compact marker appended', (s) =>
      JSON.stringify(s.conversation).includes('E2E COMPACT SUMMARY MARKER 8347 text'));

    const listAfterCompact = await s2.client.request<{
      total: number;
      turns: Array<{ turnId: string; status: string; userPreview?: string }>;
    }>(METHOD.CONVERSATION_LIST_TURNS, {});
    // Same turns, same order — the marker attaches to the last turn without
    // creating a new one.
    expect(listAfterCompact.total).toBe(list.total);
    expect(listAfterCompact.turns.map(t => t.turnId)).toEqual(list.turns.map(t => t.turnId));
    expect(listAfterCompact.turns.every(t => t.status === 'completed')).toBe(true);
    // The compaction summary is marker content, not turn content.
    expect(JSON.stringify(listAfterCompact.turns)).not.toContain('E2E COMPACT SUMMARY MARKER 8347 text');

    const turnAfterCompact = await s2.client.request<{
      steps: Array<{ content: string }>;
      userEntry?: { content: string };
      signals: Array<{ content: string }>;
      entryIds: string[];
    }>(METHOD.CONVERSATION_GET_TURN, { turnId: replyTurn.turnId });
    expect(JSON.stringify(turnAfterCompact.steps)).not.toContain('E2E COMPACT SUMMARY MARKER 8347 text');
    expect(turnAfterCompact.userEntry?.content ?? '').not.toContain('E2E COMPACT SUMMARY MARKER 8347 text');
    expect(turnAfterCompact.signals.every(s => !s.content.includes('E2E COMPACT SUMMARY MARKER 8347 text'))).toBe(true);

    leftoverRoot = undefined; // s2.dispose() (afterAll) removes the root
  }, 120_000);
});
