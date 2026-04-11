import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { JSONFileHelper } from '@/infra/state/persistence/json-file';

describe('JSONFileHelper', () => {
  let tempDir: string;
  let filePath: string;
  let helper: JSONFileHelper;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wayang-test-'));
    filePath = join(tempDir, 'data.json');
    helper = new JSONFileHelper(filePath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return null when file does not exist', () => {
    expect(helper.read()).toBeNull();
  });

  it('should write and read back data', () => {
    const data = { name: 'test', count: 42 };
    helper.write(data);
    expect(helper.read()).toEqual(data);
  });

  it('should overwrite previous data', () => {
    helper.write({ version: 1 });
    helper.write({ version: 2 });
    expect(helper.read()).toEqual({ version: 2 });
  });

  it('should clear file to empty object', () => {
    helper.write({ name: 'test' });
    helper.clear();
    expect(helper.read()).toEqual({});
  });

  it('should handle nested objects', () => {
    const data = { a: { b: { c: [1, 2, 3] } } };
    helper.write(data);
    expect(helper.read()).toEqual(data);
  });

  it('should create parent directories automatically', () => {
    const deepPath = join(tempDir, 'a', 'b', 'c', 'data.json');
    const deepHelper = new JSONFileHelper(deepPath);
    deepHelper.write({ ok: true });
    expect(deepHelper.read()).toEqual({ ok: true });
  });

  it('should report mode as save', () => {
    expect(helper.mode).toBe('save');
  });
});
