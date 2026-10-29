import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { JSONFileHelper } from '@/infra/state/persistence/json-file';

describe('JSONFileHelper', () => {
  let tempDir: string;
  let filePath: string;
  let helper: JSONFileHelper<any>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wayang-test-'));
    filePath = join(tempDir, 'data.json');
    helper = new JSONFileHelper(filePath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const write = (value: unknown) => helper.write({ path: 'data', op: 'set', value });

  it('should return null when file does not exist', () => {
    expect(helper.read()).toBeNull();
  });

  it('should write and read back data', () => {
    const data = { name: 'test', count: 42 };
    write(data);
    expect(helper.read()).toEqual(data);
  });

  it('should overwrite previous data', () => {
    write({ version: 1 });
    write({ version: 2 });
    expect(helper.read()).toEqual({ version: 2 });
  });

  it('should handle nested objects', () => {
    const data = { a: { b: { c: [1, 2, 3] } } };
    write(data);
    expect(helper.read()).toEqual(data);
  });

  it('should create parent directories automatically', () => {
    const deepPath = join(tempDir, 'a', 'b', 'c', 'data.json');
    const deepHelper = new JSONFileHelper(deepPath);
    deepHelper.write({ path: 'data', op: 'set', value: { ok: true } });
    expect(deepHelper.read()).toEqual({ ok: true });
  });

  it('should report mode as save', () => {
    expect(helper.mode).toBe('save');
  });

  // --- Atomic write ---

  it('should not leave temp files behind after a successful write', () => {
    write({ a: 1 });
    const leftovers = readdirSync(tempDir).filter(f => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('should keep the previous content intact when serialization fails', () => {
    write({ ok: true });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => write(cyclic)).toThrow();
    // The old snapshot must survive a failed write.
    expect(helper.read()).toEqual({ ok: true });
  });

  it('should leave no temp file when the write fails', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => write(cyclic)).toThrow();
    expect(readdirSync(tempDir).filter(f => f.endsWith('.tmp'))).toEqual([]);
  });

  // --- Corruption handling ---

  it('should throw on corrupt snapshot instead of returning empty state', () => {
    writeFileSync(filePath, '{ not valid json');
    expect(() => helper.read()).toThrow(/Corrupt snapshot/);
  });

  it('should quarantine the corrupt file so it can be inspected', () => {
    writeFileSync(filePath, '{ broken');
    expect(() => helper.read()).toThrow();
    const corrupt = readdirSync(tempDir).filter(f => f.includes('.corrupt.'));
    expect(corrupt).toHaveLength(1);
    expect(readFileSync(join(tempDir, corrupt[0]), 'utf-8')).toBe('{ broken');
  });

  it('should treat an empty file as absent', () => {
    writeFileSync(filePath, '   ');
    expect(helper.read()).toBeNull();
  });

  it('should not throw in raw() on corruption', () => {
    writeFileSync(filePath, 'nope');
    expect(helper.raw()).toBeNull();
  });

  it('should clear file to null', () => {
    write({ name: 'test' });
    helper.clear();
    expect(helper.read()).toBeNull();
  });
});
