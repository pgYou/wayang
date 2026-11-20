import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { JSONLFileHelper } from '@/infra/state/persistence/jsonl-file';

describe('JSONLFileHelper', () => {
  let tempDir: string;
  let filePath: string;
  let helper: JSONLFileHelper<any>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wayang-test-'));
    filePath = join(tempDir, 'data.jsonl');
    helper = new JSONLFileHelper(filePath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const append = (entry: unknown) => helper.write({ path: 'data', op: 'append', value: [], entry });

  it('should return empty array when file does not exist', () => {
    expect(helper.read()).toEqual([]);
  });

  it('should append and read entries', () => {
    append({ id: 1, text: 'first' });
    append({ id: 2, text: 'second' });

    const entries = helper.read() as any[];
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ id: 1, text: 'first' });
    expect(entries[1]).toEqual({ id: 2, text: 'second' });
  });

  it('should read from end until stop condition', () => {
    append({ type: 'start', msg: 'a' });
    append({ type: 'data', msg: 'b' });
    append({ type: 'data', msg: 'c' });
    append({ type: 'marker' });

    const result = helper.readFromEnd((e: any) => e.type === 'start');
    expect(result).toHaveLength(3);
    expect(result[0].msg).toBe('b');
    expect(result[1].msg).toBe('c');
    expect(result[2].type).toBe('marker');
  });

  it('should return all entries when stop condition never matches', () => {
    append({ id: 1 });
    append({ id: 2 });

    const result = helper.readFromEnd(() => false);
    expect(result).toHaveLength(2);
  });

  it('should clear file', () => {
    append({ id: 1 });
    helper.clear();
    expect(helper.read()).toEqual([]);
  });

  it('should handle mixed types', () => {
    append('plain string');
    append(42);
    append({ key: 'value' });

    const entries = helper.read();
    expect(entries).toEqual(['plain string', 42, { key: 'value' }]);
  });

  it('should report mode as append', () => {
    expect(helper.mode).toBe('append');
  });

  // --- Immutable history semantics ---

  it('should not rewrite history when the in-memory window shrinks (set)', () => {
    append({ id: 1 });
    append({ id: 2 });
    append({ id: 3 });

    // A window edit must NOT truncate the file — history stays complete.
    helper.write({ path: 'data', op: 'set', value: [{ id: 3 }] });
    helper.write({ path: 'data', op: 'remove', value: [{ id: 1 }, { id: 2 }] });

    const entries = helper.read() as any[];
    expect(entries.map(e => e.id)).toEqual([1, 2, 3]);
  });

  it('should ignore append calls with no entry', () => {
    helper.write({ path: 'data', op: 'append', value: [] });
    expect(helper.read()).toEqual([]);
  });

  // --- Torn-line tolerance ---

  it('should skip a torn trailing line instead of failing the whole read', () => {
    append({ id: 1 });
    appendFileSync(filePath, '{"id":2,"partial":tr');

    const entries = helper.read() as any[];
    expect(entries).toEqual([{ id: 1 }]);
  });

  it('should skip corrupt lines in the middle of the file', () => {
    append({ id: 1 });
    appendFileSync(filePath, 'not json at all\n');
    append({ id: 3 });

    const entries = helper.read() as any[];
    expect(entries.map(e => e.id)).toEqual([1, 3]);
  });

  it('should return empty array for an empty file', () => {
    writeFileSync(filePath, '');
    expect(helper.read()).toEqual([]);
  });
});
