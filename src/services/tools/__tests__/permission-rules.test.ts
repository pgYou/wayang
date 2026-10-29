import { describe, it, expect } from 'vitest';
import { needsBashPermission, needsFilePermission } from '@/services/tools/permission-rules';

const WS = '/workspace/proj';

describe('needsBashPermission', () => {
  describe('tier 1: dangerous commands are always gated', () => {
    it.each([
      'rm -rf build',
      'sudo make install',
      'chmod +x deploy.sh',
      'echo hi && rm -rf build',
      'true; dd if=/dev/zero of=x bs=1 count=1',
      'cat foo | sudo tee /etc/hosts',
    ])('%s', (command) => {
      expect(needsBashPermission(WS, command)).toBe(true);
    });
  });

  describe('tier 2: paths outside the workspace are gated', () => {
    it.each([
      'cat /etc/hosts',
      './configure --prefix=/usr/local',
      'cat ~/.ssh/config',
      'tee /tmp/x.yml',
      'ln -s /usr/local/bin/node node',
    ])('%s', (command) => {
      expect(needsBashPermission(WS, command)).toBe(true);
    });

    it('absolute path inside the workspace passes', () => {
      expect(needsBashPermission(WS, `cat ${WS}/src/cli.ts`)).toBe(false);
    });

    it('cd into the workspace passes', () => {
      expect(needsBashPermission(WS, `cd ${WS} && git diff v0.4.0 HEAD -- package.json`)).toBe(false);
    });
  });

  describe('regression: relative sub-paths are not absolute paths', () => {
    // The old extractor matched any /word substring, so `src/cli.ts` produced
    // the bogus absolute path `/cli.ts` and gated nearly every command.
    it.each([
      'sed -n 1,10p src/cli.ts',
      'mkdir -p build/out',
      'stat -f %z dist/cli.js',
      'wc -l < src/cli.ts',
      'npx vitest run src/services/tools/permission-rules.test.ts',
      `cd ${WS} && git diff v0.4.0 HEAD -- package.json src/types/config.ts src/types/index.ts tsconfig.json`,
    ])('%s', (command) => {
      expect(needsBashPermission(WS, command)).toBe(false);
    });
  });

  describe('regression: URLs are not filesystem paths', () => {
    it.each([
      'curl -s https://api.example.com/v1/data',
      'git clone https://github.com/foo/bar.git',
      'open https://github.com/foo/bar',
      'npm install axios',
    ])('%s', (command) => {
      expect(needsBashPermission(WS, command)).toBe(false);
    });
  });

  it('plain commands pass', () => {
    expect(needsBashPermission(WS, 'ls -la')).toBe(false);
    expect(needsBashPermission(WS, 'npm test')).toBe(false);
    expect(needsBashPermission(WS, 'cat package.json')).toBe(false);
    expect(needsBashPermission(WS, 'git status')).toBe(false);
  });
});

describe('needsFilePermission', () => {
  it('relative path inside the workspace passes', () => {
    expect(needsFilePermission(WS, { path: 'src/cli.ts' })).toBe(false);
  });

  it('absolute path inside the workspace passes', () => {
    expect(needsFilePermission(WS, { path: `${WS}/src/cli.ts` })).toBe(false);
  });

  it('absolute path outside the workspace is gated', () => {
    expect(needsFilePermission(WS, { path: '/etc/hosts' })).toBe(true);
  });

  it('~ paths expand to home and are gated', () => {
    expect(needsFilePermission(WS, { path: '~/.zshrc' })).toBe(true);
    expect(needsBashPermission(WS, 'cat ~/.zshrc')).toBe(true);
  });

  it('missing or non-string path passes', () => {
    expect(needsFilePermission(WS, {})).toBe(false);
    expect(needsFilePermission(WS, { path: '' })).toBe(false);
    expect(needsFilePermission(WS, { path: 42 })).toBe(false);
  });
});
