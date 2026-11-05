import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileTool } from '@/services/tools/write-file';
import { editFileTool } from '@/services/tools/edit-file';
import { readFileTool } from '@/services/tools/read-file';
import { isPathWithin, normalizePath } from '@/infra/permission/policy';

/** Helper to call a defineTool's execute function. */
async function exec(toolLike: any, args: Record<string, unknown>): Promise<string> {
  const execute = toolLike.execute;
  return execute(args);
}

// The tool-level `isInsideWorkspace` helper was removed: containment is now
// decided by the shared policy. These cases keep the same coverage against the
// ONE remaining boundary primitive (canonicalize, then segment-boundary test).
describe('isPathWithin (the single boundary check used by the policy)', () => {
  it('should return true for paths inside workspace', () => {
    expect(isPathWithin('/project', normalizePath('/project/src/file.ts'))).toBe(true);
    expect(isPathWithin('/project', normalizePath('/project/a/b/c.txt'))).toBe(true);
  });

  it('should return false for paths outside workspace', () => {
    expect(isPathWithin('/project', normalizePath('/etc/passwd'))).toBe(false);
    expect(isPathWithin('/project', normalizePath('/project/../etc/passwd'))).toBe(false);
  });

  it('should return false for absolute paths unrelated to workspace', () => {
    expect(isPathWithin('/project', normalizePath('/tmp/file.txt'))).toBe(false);
  });

  it('should not treat a sibling prefix as containment', () => {
    expect(isPathWithin('/project', '/project-other/file.ts')).toBe(false);
  });
});

describe('write_file path validation', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'wayang-test-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('should write file within cwd', async () => {
    const tool = writeFileTool({ cwd });
    const result = await exec(tool, { path: 'hello.txt', content: 'world' });
    expect(result).toContain('Written');
    expect(result).not.toContain('[ERROR]');
  });

  it('should write to nested path within cwd', async () => {
    const tool = writeFileTool({ cwd });
    const result = await exec(tool, { path: 'sub/dir/file.txt', content: 'nested' });
    expect(result).toContain('Written');
    expect(result).not.toContain('[ERROR]');
  });

  it('should fallback to process.cwd() when no cwd provided', async () => {
    const tool = writeFileTool();
    // Relative path resolves within process.cwd(), should succeed
    const result = await exec(tool, { path: '__wayang_test_tmp__.txt', content: 'test' });
    expect(result).toContain('Written');
    // Cleanup
    const { unlinkSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    try { unlinkSync(resolve(process.cwd(), '__wayang_test_tmp__.txt')); } catch { /* already gone */ }
  });

  it('should reject writing to an existing file', async () => {
    writeFileSync(join(cwd, 'existing.txt'), 'original', 'utf-8');
    const tool = writeFileTool({ cwd });
    const result = await exec(tool, { path: 'existing.txt', content: 'overwritten' });
    expect(result).toContain('[ERROR]');
    expect(result).toContain('already exists');
    expect(result).toContain('edit_file');
    // Verify file content unchanged
    expect(readFileSync(join(cwd, 'existing.txt'), 'utf-8')).toBe('original');
  });

  it('should create a new file when it does not exist', async () => {
    const tool = writeFileTool({ cwd });
    const result = await exec(tool, { path: 'new.txt', content: 'fresh' });
    expect(result).toContain('Written');
    expect(readFileSync(join(cwd, 'new.txt'), 'utf-8')).toBe('fresh');
  });
});

describe('read_file path validation', () => {
  let cwd: string;
  let home: string;
  let realHome: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'wayang-test-'));
    home = mkdtempSync(join(tmpdir(), 'wayang-home-'));
    // `~` expansion anchors on the PROCESS home (os.homedir() reads $HOME on
    // POSIX), so point $HOME at a temp dir for the duration of these tests.
    realHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    process.env.HOME = realHome;
  });

  it('should read file within cwd', async () => {
    writeFileSync(join(cwd, 'test.txt'), 'hello', 'utf-8');
    const tool = readFileTool({ cwd });
    const result = await exec(tool, { path: 'test.txt' });
    expect(result).toBe('1\thello');
  });

  /**
   * 0.8.4: a leading `~` expands against the PROCESS home — the same file a
   * shell opens for `cat ~/x` and the same path the permission gate judges.
   * The old behavior (expand against the injected policy home) opened a
   * DIFFERENT file than the worker's shell whenever the policy anchor did not
   * match the process home.
   */
  it('expands a leading ~/ against the process home, not the workspace', async () => {
    writeFileSync(join(home, 'x.txt'), 'from home', 'utf-8');
    mkdirSync(join(home, 'nested'), { recursive: true });
    writeFileSync(join(home, 'nested', 'y.txt'), 'nested', 'utf-8');
    const tool = readFileTool({ cwd });
    expect(await exec(tool, { path: '~/x.txt' })).toBe('1\tfrom home');
    expect(await exec(tool, { path: '~/nested/y.txt' })).toBe('1\tnested');
  });

  it('expands $HOME/ and ${HOME}/ exactly like ~/', async () => {
    writeFileSync(join(home, 'x.txt'), 'from home', 'utf-8');
    const tool = readFileTool({ cwd });
    expect(await exec(tool, { path: '$HOME/x.txt' })).toBe('1\tfrom home');
    expect(await exec(tool, { path: '${HOME}/x.txt' })).toBe('1\tfrom home');
  });

  it('~user stays unexpanded (cannot be resolved safely)', async () => {
    writeFileSync(join(home, 'x.txt'), 'from home', 'utf-8');
    const tool = readFileTool({ cwd });
    const result = await exec(tool, { path: '~someone/x.txt' });
    // Not the home file: the unexpanded spelling resolves inside the
    // workspace and fails, exactly as before.
    expect(result).toContain('[ERROR]');
    expect(result).not.toContain('from home');
    expect(result).toContain(join(cwd, '~someone', 'x.txt'));
  });
});

describe('write_file / edit_file ~/ expansion (process home)', () => {
  let cwd: string;
  let home: string;
  let realHome: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'wayang-test-'));
    home = mkdtempSync(join(tmpdir(), 'wayang-home-'));
    realHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    process.env.HOME = realHome;
  });

  /**
   * The gate (evaluateFileAccess) expands `~` before judging, so the tool
   * must operate on the SAME expanded path — otherwise an approval names
   * `<home>/w.txt` while the tool writes a literal `~` directory inside the
   * workspace.
   */
  it('write_file writes to the expanded process-home path, not a workspace literal', async () => {
    const tool = writeFileTool({ cwd });
    const result = await exec(tool, { path: '~/w.txt', content: 'hi' });
    expect(result).toContain(join(home, 'w.txt'));
    expect(existsSync(join(home, 'w.txt'))).toBe(true);
    expect(existsSync(join(cwd, '~'))).toBe(false);
  });

  it('edit_file edits the expanded process-home path', async () => {
    writeFileSync(join(home, 'e.txt'), 'old', 'utf-8');
    const tool = editFileTool({ cwd });
    const result = await exec(tool, { path: '~/e.txt', old_string: 'old', new_string: 'new' });
    expect(result).toContain('Replaced');
    expect(readFileSync(join(home, 'e.txt'), 'utf-8')).toBe('new');
  });
});
