/**
 * E2E: session resume across server process restarts.
 *
 * Regression guard for the root double-join bug: `--wayang-root` (deprecated
 * alias `--home-dir`) has
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

    // `--wayang-root` is a root: sessions land in <root>/home/.wayang/sessions.
    // (The double-join regression put them under <root>/home/.wayang/.wayang.)
    const sessionDir = join(s1.root, 'home', '.wayang', 'sessions', s1.sessionId);
    expect(existsSync(join(sessionDir, 'meta.json'))).toBe(true);

    const { sessionId, root, provider } = s1;
    leftoverRoot = root;
    // Graceful shutdown of server #1; keep session data + fake provider.
    await s1.dispose({ root: true, provider: true });

    // --- Server #2: same root, explicit resume — exactly what the TUI
    // client spawns after finding the session (bootstrap passes the ROOT
    // as --wayang-root and the server resolves .wayang itself). ---
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
  it('conversation RPCs expose pre-resume turns with lineage; short-session compaction is skipped', async () => {
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

    // Snapshot the turn index BEFORE shutdown. Resuming a session whose tasks
    // all finished must not append turns or lifecycle signals for them.
    const listBeforeResume = await s1.client.request<{
      total: number;
      turns: Array<{ turnId: string; status: string; signalCount: number }>;
    }>(METHOD.CONVERSATION_LIST_TURNS, {});

    const { sessionId, root, provider } = s1;
    leftoverRoot = root;
    await s1.dispose({ root: true, provider: true });

    // --- Server #2: same root, resume. setupE2E ignores the script arg when
    // reusing a provider, so it starts with an empty queue. No summarizer
    // entry is scripted: this session has only two turns, so the retained
    // verbatim zone covers the whole conversation and PERFORM_COMPACTION
    // below must be SKIPPED — the summarizer LLM is never called.
    const s2 = await setupE2E([], { session: `resume:${sessionId}`, root, provider });
    setups.push(s2);
    expect(s2.sessionId).toBe(sessionId);

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

    // Resume replays nothing: the index read from the restored session is
    // identical to the one captured before shutdown. In particular no
    // worker_started / task_queued is re-emitted for already-finished tasks
    // (restore only rebuilds state; it never schedules), and no
    // previous_session_tasks signal exists for an explicit `resume:<id>`
    // (that injection is exclusive to the sessionless-resume default and
    // only covers pending/running tasks).
    expect(list.turns.map(t => ({ turnId: t.turnId, status: t.status, signalCount: t.signalCount })))
      .toEqual(listBeforeResume.turns.map(t => ({ turnId: t.turnId, status: t.status, signalCount: t.signalCount })));

    const [dispatchTurn, replyTurn] = list.turns;
    expect(dispatchTurn.userPreview).toContain('run the resume turn task');
    // Lineage: the dispatching user turn is its own root; the reply turn
    // (woken by the worker lifecycle signals) inherits that root.
    expect(dispatchTurn.rootTurnId).toBe(dispatchTurn.turnId);
    expect(replyTurn.rootTurnId).toBe(dispatchTurn.turnId);
    // Two signals, one per lifecycle phase of issue #30: the worker was
    // announced as worker_started when it actually spawned, then the next
    // controller activation (this turn) is woken by BOTH that still-unread
    // started signal and the terminal worker_completed. Before #30 only the
    // completed signal existed, hence the old expectation of 1.
    expect(dispatchTurn.signalCount).toBe(0);
    expect(replyTurn.signalCount).toBe(2);
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
    // Exact lifecycle set, in emission order, for one task that started and
    // completed once: worker_started then worker_completed. Anything else here
    // (a replayed started/queued at resume, a stray restored signal) is drift.
    expect(reply.signals.map(s => s.subtype)).toEqual(['worker_started', 'worker_completed']);
    // Both signals resolve exactly the task the dispatch turn created.
    const addTaskCall = full.toolCalls.find(tc => tc.toolName === 'add_task');
    expect(addTaskCall?.taskId).toBeTruthy();
    expect(reply.signals.every(s => s.taskId === addTaskCall?.taskId)).toBe(true);
    expect(reply.steps.some(st => st.content.includes('Task finished successfully.'))).toBe(true);

    // --- Compact after resume: SKIPPED by design. The session has only two
    // turns, so the whole conversation fits the retained verbatim zone
    // (context-manager keepStartIdx === 0 → skip): no marker, no summary
    // user entry, no summarizer call, nothing appended or truncated. ---
    const convBeforeCompact = s2.state.conversation.length;
    await s2.client.request(METHOD.PERFORM_COMPACTION);

    // Entry count is exactly unchanged — a real compaction would have
    // appended marker + summary (and a fallback truncation would shrink it).
    expect(s2.state.conversation).toHaveLength(convBeforeCompact);
    const convJson = JSON.stringify(s2.state.conversation);
    expect(convJson).not.toContain('[Context compacted]'); // no marker entry
    expect(convJson).not.toContain('[Conversation Summary]'); // no summary user entry
    // The skip path must not even reach the summarizer LLM.
    expect(provider.requests.some(isSummarizerRequest)).toBe(false);

    const listAfterCompact = await s2.client.request<{
      total: number;
      turns: Array<{ turnId: string; status: string; userPreview?: string }>;
    }>(METHOD.CONVERSATION_LIST_TURNS, {});
    // Same turns, same order — a skipped compaction leaves the index untouched.
    expect(listAfterCompact.total).toBe(list.total);
    expect(listAfterCompact.turns.map(t => t.turnId)).toEqual(list.turns.map(t => t.turnId));
    expect(listAfterCompact.turns.every(t => t.status === 'completed')).toBe(true);

    // --- The skipped compaction leaves the resumed session fully operational:
    // a new user turn still runs through the restored controller. ---
    provider.reset([
      { match: isControllerRequest, text: 'Still operational after the skipped compaction.' },
    ]);
    await s2.submit('ping after the skipped compaction');
    await s2.waitFor('post-skip controller reply', (s) =>
      JSON.stringify(s.conversation).includes('Still operational after the skipped compaction.'));

    const listAfterFollowUp = await s2.client.request<{
      total: number;
      turns: Array<{ turnId: string; status: string; userPreview?: string }>;
    }>(METHOD.CONVERSATION_LIST_TURNS, {});
    expect(listAfterFollowUp.total).toBe(list.total + 1);
    const followUpTurn = listAfterFollowUp.turns.at(-1);
    expect(followUpTurn?.status).toBe('completed');
    expect(followUpTurn?.userPreview).toContain('ping after the skipped compaction');

    leftoverRoot = undefined; // s2.dispose() (afterAll) removes the root
  }, 120_000);
});

describe('e2e: compaction on a long session', () => {
  it('PERFORM_COMPACTION on a long conversation appends the marker and the summary user entry', async () => {
    // The default 256k window gives the retained verbatim zone an 8k-16k
    // token budget. Two ~20k-token assistant entries (one riding the
    // add_task step, one as the final reply) push the conversation far past
    // that budget, so the retained zone covers only the last entry and the
    // compaction really runs — the opposite of the skipped path above.
    const bigText = 'E2E long-history filler payload. '.repeat(3_200); // 80k chars ≈ 20k tokens
    const summaryText = 'E2E COMPACT SUMMARY 9042 for the long session';

    const s = await setupE2E([
      {
        match: isControllerRequest,
        text: bigText,
        toolCalls: [{
          name: 'add_task',
          args: { title: 'Long history task', description: 'Do the thing, then report done.', priority: 'normal' },
        }],
      },
      { match: isControllerRequest, text: 'Dispatched the long-history task.' },
      { match: isWorkerRequest, toolCalls: [{ name: 'done', args: { summary: 'Long task finished' } }] },
      { match: isControllerRequest, text: `Task finished with a long report.\n${bigText}` },
      { match: isSummarizerRequest, text: summaryText },
    ]);
    setups.push(s);

    await s.submit('run the long-history task');
    await s.waitFor('controller final reply', (snapshot) =>
      JSON.stringify(snapshot.conversation).includes('Task finished with a long report.'));
    await s.waitFor('task completed in history', (snapshot) =>
      snapshot.history.length === 1 && snapshot.history[0].status === 'completed');

    // Long enough for the compaction guard (< 4 entries is skipped outright).
    expect(s.state.conversation.length).toBeGreaterThanOrEqual(4);

    await s.client.request(METHOD.PERFORM_COMPACTION);
    await s.waitFor('compact marker and summary appended', (snapshot) =>
      JSON.stringify(snapshot.conversation).includes('[Context compacted]')
      && JSON.stringify(snapshot.conversation).includes(summaryText));

    // The summarizer really ran (the skip path in the sibling test asserts
    // the exact opposite).
    expect(s.provider.requests.some(isSummarizerRequest)).toBe(true);

    const entries = s.state.conversation as Array<{
      type: string;
      uuid: string;
      subtype?: string;
      content?: string;
      compactMeta?: { summaryEntryUuid?: string; summarizedTokenCount?: number };
      message?: { role: string; content: string };
    }>;
    const markerIdx = entries.findIndex(e => e.type === 'system' && e.subtype === 'compact');
    const summaryIdx = entries.findIndex(e =>
      e.type === 'user' && e.message?.role === 'user'
      && e.message.content.startsWith('[Conversation Summary]'));
    expect(markerIdx).toBeGreaterThanOrEqual(0);
    // New format: marker first, the summary user entry right after it.
    expect(summaryIdx).toBe(markerIdx + 1);

    const marker = entries[markerIdx]!;
    const summaryEntry = entries[summaryIdx]!;
    expect(marker.content).toContain('[Context compacted]');
    // compactMeta.summaryEntryUuid points at the summary entry that follows.
    expect(marker.compactMeta?.summaryEntryUuid).toBe(summaryEntry.uuid);
    expect(marker.compactMeta?.summarizedTokenCount).toBeGreaterThan(0);
    expect(summaryEntry.message?.content).toBe(`[Conversation Summary]\n${summaryText}`);
  }, 120_000);
});
