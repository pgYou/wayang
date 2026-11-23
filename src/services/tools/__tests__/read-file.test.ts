// read_file output caps and secret redaction.
//
// maxChars / maxLineChars bound what a single call can pull into the context
// (huge JSONL records were the driver); redact masks credential-like values
// BEFORE any cut, so a truncated slice can never leak a partial secret.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileTool } from '@/services/tools/read-file';

/** Helper to call a defineTool's execute function. */
async function exec(toolLike: any, args: Record<string, unknown>): Promise<string> {
  const execute = toolLike.execute;
  return execute(args);
}

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'wayang-read-file-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('read_file output caps', () => {
  it('maxLineChars truncates an over-long line with a marker, other lines intact', async () => {
    writeFileSync(join(cwd, 'long-line.txt'), `${'a'.repeat(500)}\nshort`, 'utf-8');
    const out = await exec(readFileTool({ cwd }), { path: 'long-line.txt', maxLineChars: 100 });
    expect(out).toContain(`1\t${'a'.repeat(100)}[line truncated: 100/500 chars]`);
    expect(out).toContain('2\tshort');
    expect(out).not.toContain('a'.repeat(101));
    expect(out).not.toContain('3\t');
  });

  it('maxChars truncates total output with a marker', async () => {
    writeFileSync(join(cwd, 'bulk.txt'), 'x'.repeat(3000), 'utf-8');
    const out = await exec(readFileTool({ cwd }), { path: 'bulk.txt', maxChars: 1000 });
    expect(out.startsWith(`1\t${'x'.repeat(998)}`)).toBe(true);
    expect(out).toContain('[Truncated: maxChars=1000; showing 1000 of 3002 chars.');
    expect(out).not.toContain('x'.repeat(999));
    // Content before the marker note is exactly the cap (markers excluded).
    expect(out.slice(0, out.indexOf('\n\n[Truncated')).length).toBe(1000);
  });
});

describe('read_file redact', () => {
  it('redact=true masks apiKey/token/secret/password values in JSON double-quote form', async () => {
    const content = [
      '{',
      '  "apiKey": "sk-json-111",',
      '  "auth_token": "tok-json-222",',
      '  "client-secret": "sec-json-333",',
      '  "PASSWORD": "pwd-json-444",',
      '  "name": "plain"',
      '}',
    ].join('\n');
    writeFileSync(join(cwd, 'creds.json'), content, 'utf-8');
    const out = await exec(readFileTool({ cwd }), { path: 'creds.json', redact: true });
    expect(out).toContain('"apiKey": "***"');
    expect(out).toContain('"auth_token": "***"');
    expect(out).toContain('"client-secret": "***"');
    expect(out).toContain('"PASSWORD": "***"');
    expect(out).toContain('"name": "plain"');
    for (const secret of ['sk-json-111', 'tok-json-222', 'sec-json-333', 'pwd-json-444']) {
      expect(out).not.toContain(secret);
    }
  });

  it('redact=true masks apiKey/token/secret/password values in YAML colon form', async () => {
    const content = [
      'apiKey: sk-yaml-111',
      'token: tok-yaml-222',
      'secret: sec-yaml-333',
      'password: pwd-yaml-444',
      'name: plain-value',
    ].join('\n');
    writeFileSync(join(cwd, 'creds.yaml'), content, 'utf-8');
    const out = await exec(readFileTool({ cwd }), { path: 'creds.yaml', redact: true });
    expect(out).toContain('apiKey: ***');
    expect(out).toContain('token: ***');
    expect(out).toContain('secret: ***');
    expect(out).toContain('password: ***');
    expect(out).toContain('name: plain-value');
    for (const secret of ['sk-yaml-111', 'tok-yaml-222', 'sec-yaml-333', 'pwd-yaml-444']) {
      expect(out).not.toContain(secret);
    }
  });

  it('redact defaults to false — omitted and explicit false leave values intact', async () => {
    writeFileSync(join(cwd, 'plain.json'), '{"apiKey": "sk-plain"}', 'utf-8');
    const omitted = await exec(readFileTool({ cwd }), { path: 'plain.json' });
    expect(omitted).toContain('sk-plain');
    expect(omitted).not.toContain('***');
    const explicit = await exec(readFileTool({ cwd }), { path: 'plain.json', redact: false });
    expect(explicit).toContain('sk-plain');
    expect(explicit).not.toContain('***');
  });
});

describe('read_file redact-then-truncate ordering', () => {
  it('redacts before truncating: long secret-bearing content never leaks partial values', async () => {
    // The JSON-quoted secret is far longer than maxLineChars. If truncation
    // ran first, the cut would land mid-value and leave an unterminated quote
    // the redaction regex can no longer pair — a partial secret would leak.
    const longSecret = `sk-combo-${'A'.repeat(500)}`;
    const lines = [
      `{"apiKey": "${longSecret}", "ok": 1}`,
      ...Array.from({ length: 30 }, (_, i) => `filler-${i}: ${'f'.repeat(240)}`),
    ];
    writeFileSync(join(cwd, 'combo.json'), lines.join('\n'), 'utf-8');
    const out = await exec(readFileTool({ cwd }), {
      path: 'combo.json',
      redact: true,
      maxLineChars: 200,
      maxChars: 500,
    });
    // Secret fully masked, nothing partial survived any cut.
    expect(out).toContain('"apiKey": "***"');
    expect(out).not.toContain('sk-combo');
    expect(out).not.toContain('A'.repeat(10));
    // Both caps engaged, both marked.
    expect(out).toContain('[line truncated: 200/');
    expect(out).toContain('[Truncated: maxChars=500;');
    expect(out).not.toContain('f'.repeat(201));
  });
});
