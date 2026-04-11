import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { JSONLFileHelper } from '@/infra/state/persistence/jsonl-file';

describe('JSONLFileHelper', () => {
  let tempDir: string;
  let filePath: string;
  let helper: JSONLFileHelper;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wayang-test-'));
    filePath = join(tempDir, 'data.jsonl');
    helper = new JSONLFileHelper(filePath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return empty array when file does not exist', () => {
    expect(helper.read()).toEqual([]);
  });

  it('should append and read entries', () => {
    helper.write({ id: 1, text: 'first' });
    helper.write({ id: 2, text: 'second' });

    const entries = helper.read() as any[];
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ id: 1, text: 'first' });
    expect(entries[1]).toEqual({ id: 2, text: 'second' });
  });

  it('should read from end until stop condition', () => {
    helper.write({ type: 'start', msg: 'a' });
    helper.write({ type: 'data', msg: 'b' });
    helper.write({ type: 'data', msg: 'c' });
    helper.write({ type: 'marker' });

    const result = helper.readFromEnd((e: any) => e.type === 'start');
    // readFromEnd reads from end, stops when hitting 'start'
    // So it should get 'marker', 'data' (c), 'data' (b)
    expect(result).toHaveLength(3);
    expect(result[0].msg).toBe('b');
    expect(result[1].msg).toBe('c');
    expect(result[2].type).toBe('marker');
  });

  it('should return all entries when stop condition never matches', () => {
    helper.write({ id: 1 });
    helper.write({ id: 2 });

    const result = helper.readFromEnd(() => false);
    expect(result).toHaveLength(2);
  });

  it('should clear file', () => {
    helper.write({ id: 1 });
    helper.clear();
    expect(helper.read()).toEqual([]);
  });

  it('should handle mixed types', () => {
    helper.write('plain string');
    helper.write(42);
    helper.write({ key: 'value' });

    const entries = helper.read();
    expect(entries).toEqual(['plain string', 42, { key: 'value' }]);
  });

  it('should report mode as append', () => {
    expect(helper.mode).toBe('append');
  });
});
