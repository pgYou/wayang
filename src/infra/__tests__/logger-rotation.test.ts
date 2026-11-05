import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RotatingFileSink } from '@/infra/rotating-file-sink';
import { createFileLogger } from '@/infra/logger';
import type { WayangConfig } from '@/types/index';
import { SystemContext } from '@/infra/system-context';
import { ControllerAgentState } from '@/services/agents/controller-state';

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wayang-log-rotation-'));
  logPath = join(dir, 'wayang.log');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write one line to the sink and resolve once it hit the disk. */
function write(sink: RotatingFileSink, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sink.write(text, 'utf8', (err) => (err ? reject(err) : resolve()));
  });
}

function size(path: string): number {
  return statSync(path).size;
}

describe('RotatingFileSink', () => {
  it('keeps a single file while writes stay within the budget', async () => {
    const sink = new RotatingFileSink(logPath, { maxFileSizeBytes: 100, maxFiles: 3 });
    await write(sink, 'a'.repeat(30) + '\n');
    await write(sink, 'b'.repeat(30) + '\n');
    await write(sink, 'c'.repeat(30) + '\n');

    expect(existsSync(logPath)).toBe(true);
    expect(existsSync(`${logPath}.1`)).toBe(false);
    expect(size(logPath)).toBe(93);
  });

  it('does not rotate when the file lands exactly at the budget', async () => {
    const sink = new RotatingFileSink(logPath, { maxFileSizeBytes: 100, maxFiles: 3 });
    // 59 + newline = 60 bytes, then 39 + newline = 40 bytes → exactly 100.
    await write(sink, 'x'.repeat(59) + '\n');
    await write(sink, 'y'.repeat(39) + '\n');

    expect(existsSync(`${logPath}.1`)).toBe(false);
    expect(size(logPath)).toBe(100);

    // The very next write (even two bytes) rotates.
    await write(sink, 'z\n');
    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(readFileSync(`${logPath}.1`, 'utf8')).toBe('x'.repeat(59) + '\n' + 'y'.repeat(39) + '\n');
    expect(readFileSync(logPath, 'utf8')).toBe('z\n');
  });

  it('rotates a little over the budget: old content to .1, new line to the fresh file', async () => {
    const sink = new RotatingFileSink(logPath, { maxFileSizeBytes: 100, maxFiles: 3 });
    await write(sink, 'a'.repeat(90) + '\n');
    await write(sink, 'b'.repeat(20) + '\n'); // 90 + 21 > 100 → rotate first

    expect(size(`${logPath}.1`)).toBe(91);
    expect(size(logPath)).toBe(21);
    expect(readFileSync(logPath, 'utf8')).toBe('b'.repeat(20) + '\n');
  });

  it('keeps only maxFiles rotated files and never grows without bound', async () => {
    const sink = new RotatingFileSink(logPath, { maxFileSizeBytes: 10, maxFiles: 2 });
    // Drive four rotations with 9-byte lines (9 + 9 > 10 each time).
    for (let i = 0; i < 5; i++) {
      await write(sink, `line-${i}   \n`);
    }

    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(existsSync(`${logPath}.2`)).toBe(true);
    expect(existsSync(`${logPath}.3`)).toBe(false);
    // Oldest kept chunk is the second generation; the first was dropped.
    expect(readFileSync(`${logPath}.2`, 'utf8')).not.toContain('line-0');
    // Every rotated file stays within the budget.
    expect(size(`${logPath}.1`)).toBeLessThanOrEqual(10);
    expect(size(`${logPath}.2`)).toBeLessThanOrEqual(10);
  });

  it('writes a single oversized line whole and rotates on the next write', async () => {
    const sink = new RotatingFileSink(logPath, { maxFileSizeBytes: 50, maxFiles: 3 });
    const big = 'HUGE'.repeat(50) + '\n'; // 201 bytes > budget
    await write(sink, big);

    // A line is never split: the first write into an empty file goes through.
    expect(size(logPath)).toBe(201);

    await write(sink, 'tail\n');
    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(size(`${logPath}.1`)).toBe(201);
    expect(readFileSync(logPath, 'utf8')).toBe('tail\n');
  });

  it('resumes byte accounting from a pre-existing file', async () => {
    // A previous process left 90 bytes; the budget is 100, so a fresh sink
    // must rotate immediately on a 20-byte line instead of restarting at 0.
    writeFileSync(logPath, 'a'.repeat(90));
    const sink = new RotatingFileSink(logPath, { maxFileSizeBytes: 100, maxFiles: 3 });
    await write(sink, 'b'.repeat(20) + '\n');

    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(size(`${logPath}.1`)).toBe(90);
  });

  it('emits close after end() so draining is awaitable', async () => {
    const sink = new RotatingFileSink(logPath, { maxFileSizeBytes: 100, maxFiles: 3 });
    await write(sink, 'one line\n');
    const closed = new Promise<void>((resolve) => sink.once('close', resolve));
    sink.end();
    await closed;
    expect(readFileSync(logPath, 'utf8')).toBe('one line\n');
  });
});

describe('createFileLogger (rotation wiring)', () => {
  it('writes pretty single-line records and gates by level', async () => {
    const sink = createFileLogger('info', logPath, { maxFileSizeBytes: 1024 * 1024, maxFiles: 3 });
    sink.logger.info('hello rotation');
    sink.logger.debug('must not appear');
    await sink.close();

    const text = readFileSync(logPath, 'utf8');
    expect(text).toContain('hello rotation');
    expect(text).toContain('INFO');
    expect(text).not.toContain('must not appear');
    // singleLine: one record per line.
    expect(text.trimEnd().split('\n')).toHaveLength(1);
  });

  it('rotates the real log file at the configured size', async () => {
    const sink = createFileLogger('info', logPath, { maxFileSizeBytes: 120, maxFiles: 1 });
    for (let i = 0; i < 8; i++) {
      sink.logger.info(`rotation-driver-line-${i}`);
    }
    await sink.close();

    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(existsSync(`${logPath}.2`)).toBe(false);
    // The active file holds only the tail; the rotated one the older lines.
    const active = readFileSync(logPath, 'utf8');
    expect(active).toContain('rotation-driver-line-7');
    expect(active).not.toContain('rotation-driver-line-0');
    expect(readFileSync(`${logPath}.1`, 'utf8')).not.toContain('rotation-driver-line-7');
    // Both files are bounded by the (line-sized) budget.
    expect(size(logPath)).toBeLessThanOrEqual(120);
    expect(size(`${logPath}.1`)).toBeLessThanOrEqual(120);
  });

  it('close is idempotent and late writes are swallowed, not thrown', async () => {
    const sink = createFileLogger('info', logPath, { maxFileSizeBytes: 1024, maxFiles: 1 });
    sink.logger.info('before close');
    await sink.close();
    await sink.close(); // idempotent

    expect(() => sink.logger.info('after close')).not.toThrow();
    // Give the late write's async 'error' a tick — it must stay swallowed.
    await new Promise((resolve) => setImmediate(resolve));
    expect(readFileSync(logPath, 'utf8')).toContain('before close');
  });
});

describe('resume flow is unaffected by log rotation', () => {
  it('restores the full conversation with rotated log files present', async () => {
    // A session directory that already lived through rotations: a rotated
    // shard, an active log, and a conversation history.
    writeFileSync(`${logPath}.1`, '[00:00:00.000] INFO: old rotated line\n');
    writeFileSync(logPath, '[00:00:01.000] INFO: active line\n');
    const conversationPath = join(dir, 'conversation.jsonl');
    writeFileSync(
      conversationPath,
      JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, sessionId: 's', timestamp: new Date().toISOString(), message: { role: 'user', content: 'first' } }) + '\n' +
      JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: null, sessionId: 's', timestamp: new Date().toISOString(), message: { role: 'user', content: 'second' } }) + '\n',
    );

    const config: WayangConfig = {
      providers: { default: { endpoint: 'http://localhost:1', apiKey: 'k', modelName: 'm' } },
      controller: { provider: 'default' },
      worker: { provider: 'default', maxConcurrency: 1 },
    };
    const ctx = new SystemContext(config, 's', dir, dir);
    const state = new ControllerAgentState(ctx);
    await state.restore();

    // The full history came back — restore never reads wayang.log.
    const conversation = state.get<unknown[]>('conversation') ?? [];
    expect(conversation).toHaveLength(2);

    await ctx.closeLogger();

    // The rotated shard is untouched; the active log only grew by restore's
    // own info line — conversation and log paths never interfere.
    expect(readFileSync(`${logPath}.1`, 'utf8')).toBe('[00:00:00.000] INFO: old rotated line\n');
    expect(readFileSync(logPath, 'utf8')).toContain('active line');
    expect(readFileSync(logPath, 'utf8')).toContain('ControllerAgentState restored');
    // Conversation history is intact after the logger wrote into the same dir.
    expect(readFileSync(conversationPath, 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
  });
});
