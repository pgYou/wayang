import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createLogger } from '@/infra/logger';
import { WorkerState } from '@/services/agents/worker-state';
import { EEntryType, ESystemSubtype } from '@/types/index';

// --- JSONL fixtures ---

const makeUser = (uuid: string, content: string) => ({
  type: EEntryType.User,
  uuid,
  parentUuid: null,
  sessionId: 'w-001',
  timestamp: new Date().toISOString(),
  message: { role: 'user' as const, content },
});

const makeSystem = (uuid: string, subtype: ESystemSubtype, content: string, compactMeta?: any) => ({
  type: EEntryType.System,
  uuid,
  parentUuid: null,
  sessionId: 'w-001',
  timestamp: new Date().toISOString(),
  subtype,
  content,
  ...(compactMeta !== undefined ? { compactMeta } : {}),
});

const makeCompactMarker = (uuid: string, content: string) =>
  makeSystem(uuid, ESystemSubtype.Compact, content, { summarizedTokenCount: 100 });

function writeConversationJsonl(dir: string, workerId: string, entries: any[]) {
  const filePath = join(dir, 'workers', workerId, 'conversation.jsonl');
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

describe('WorkerState', () => {
  let tempDir: string;
  let state: WorkerState;
  const logger = createLogger('silent');
  const workerId = 'w-001';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wayang-test-'));
    state = new WorkerState(tempDir, workerId, logger);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should initialize with worker session id', () => {
    expect(state.get('runtimeState.session.id')).toBe(workerId);
    expect(state.get('conversation')).toEqual([]);
  });

  it('should set task info', () => {
    state.set('runtimeState.task', { id: 't1', description: 'do something' });
    expect(state.get('runtimeState.task.description')).toBe('do something');
  });

  it('should append conversation entries', () => {
    state.append('conversation', {
      type: 'system',
      uuid: 'sys-1',
      parentUuid: null,
      sessionId: workerId,
      timestamp: new Date().toISOString(),
      subtype: 'task_started',
      content: 'Task started',
    });

    expect(state.get('conversation')).toHaveLength(1);
  });

  it('should persist and restore', async () => {
    state.set('runtimeState.task', { id: 't1', description: 'test task' });
    state.append('conversation', {
      type: 'system',
      uuid: 'sys-1',
      parentUuid: null,
      sessionId: workerId,
      timestamp: new Date().toISOString(),
      subtype: 'task_started',
      content: 'Task started',
    });

    const state2 = new WorkerState(tempDir, workerId, logger);
    await state2.restore();

    expect(state2.get('runtimeState.task')).toEqual({ id: 't1', description: 'test task' });
    expect(state2.get('conversation')).toHaveLength(1);
  });

  it('should create worker subdirectory', () => {
    state.set('runtimeState.task', { id: 't1', description: 'test' });
    const fs = require('fs');
    expect(fs.existsSync(join(tempDir, 'workers', workerId, 'runtime-state.json'))).toBe(true);
  });

  it('should window around a real compact marker on restore', async () => {
    // Old entries beyond budget + marker + new entries.
    // Each big entry is ~20_001 tokens (80_001 chars) — a single one blows the
    // 20_000 budget when walking back from the marker.
    writeConversationJsonl(tempDir, workerId, [
      makeUser('old-big-1', 'a'.repeat(80_001)),
      makeUser('old-big-2', 'b'.repeat(80_001)),
      makeUser('old-light', 'light message'),
      makeCompactMarker('m-1', 'SUMMARY: worker history before the marker'),
      makeUser('new-1', 'new message'),
    ]);

    const state2 = new WorkerState(tempDir, workerId, logger);
    await state2.restore();

    const conversation = state2.get('conversation') as any[];
    const uuids = conversation.map((e) => e.uuid);
    // Walking back from the marker: light (4 tokens) fits, old-big-2 (20_001)
    // blows the budget → cut lands between old-big-2 and old-light
    expect(uuids).not.toContain('old-big-1');
    expect(uuids).not.toContain('old-big-2');
    expect(uuids).toEqual(['old-light', 'm-1', 'new-1']);
  });

  describe('workspace identity', () => {
    const workspace = { path: '/repo/my-project', slug: 'my-project' };
    const runtimeStatePath = () => join(tempDir, 'workers', workerId, 'runtime-state.json');

    it('stamps workspace into runtime-state and reads it back', async () => {
      const stateWithWs = new WorkerState(tempDir, workerId, logger, workspace);
      stateWithWs.set('runtimeState.task', { id: 't1', description: 'ship it' });

      const onDisk = JSON.parse(readFileSync(runtimeStatePath(), 'utf-8'));
      expect(onDisk.workspace).toEqual(workspace);

      const restored = new WorkerState(tempDir, workerId, logger, workspace);
      await restored.restore();
      expect(restored.get('runtimeState.workspace')).toEqual(workspace);
      expect(restored.get('runtimeState.task')).toEqual({ id: 't1', description: 'ship it' });
    });

    it('reads a pre-workspace runtime-state.json without losing fields', async () => {
      mkdirSync(join(tempDir, 'workers', workerId), { recursive: true });
      writeFileSync(
        runtimeStatePath(),
        JSON.stringify({
          session: { id: workerId, startedAt: 1 },
          task: { id: 'legacy-task', description: 'old' },
        }),
      );

      const legacy = new WorkerState(tempDir, workerId, logger);
      await legacy.restore();
      expect(legacy.get('runtimeState.workspace')).toBeUndefined();
      expect(legacy.get('runtimeState.task')).toEqual({ id: 'legacy-task', description: 'old' });
    });

    it('re-applies the resolved identity to a pre-workspace file on restore', async () => {
      mkdirSync(join(tempDir, 'workers', workerId), { recursive: true });
      writeFileSync(
        runtimeStatePath(),
        JSON.stringify({
          session: { id: workerId, startedAt: 1 },
          task: { id: 'legacy-task', description: 'old' },
        }),
      );

      const stateWithWs = new WorkerState(tempDir, workerId, logger, workspace);
      await stateWithWs.restore();
      expect(stateWithWs.get('runtimeState.workspace')).toEqual(workspace);
      expect(stateWithWs.get('runtimeState.task')).toEqual({ id: 'legacy-task', description: 'old' });
    });

    it('omits workspace when none was resolved', () => {
      const plain = new WorkerState(tempDir, workerId, logger);
      plain.set('runtimeState.task', { id: 't1', description: 'x' });
      const onDisk = JSON.parse(readFileSync(runtimeStatePath(), 'utf-8'));
      expect('workspace' in onDisk).toBe(false);
    });
  });

  it('should not misjudge ClaudeCodeWorker-style records as compact markers', async () => {
    // Legacy success records (subtype=compact, no compactMeta) and new-style
    // task_result records are plain display entries — never windowing markers.
    writeConversationJsonl(tempDir, workerId, [
      makeUser('u-1', 'do the task'),
      makeSystem('legacy-ok', ESystemSubtype.Compact, 'legacy success summary'),
      makeUser('u-2', 'another task'),
      makeSystem('result-ok', ESystemSubtype.TaskResult, 'task finished successfully'),
    ]);

    const state2 = new WorkerState(tempDir, workerId, logger);
    await state2.restore();

    expect(state2.get('conversation')).toHaveLength(4);
  });
});
