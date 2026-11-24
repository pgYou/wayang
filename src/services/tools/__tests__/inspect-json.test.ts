// inspect_json: structured JSON reads — RFC 6901 pointer projection, default
// secret redaction, structured parse errors and the maxChars output cap.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectJsonTool } from '@/services/tools/inspect-json';

/** Helper to call a defineTool's execute function. */
async function exec(toolLike: any, args: Record<string, unknown>): Promise<string> {
  return toolLike.execute(args);
}

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'wayang-inspect-json-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const CONFIG = {
  version: '1.2.0',
  workers: {
    codebuddy: { model: 'glm-5.3', apiKey: 'sk-live-111' },
    other: { model: 'gpt-x', password: 'pwd-222' },
  },
  tokens: ['tok-a', 'tok-b'],
};

describe('inspect_json pointers', () => {
  beforeEach(() => {
    writeFileSync(join(cwd, 'config.json'), JSON.stringify(CONFIG), 'utf-8');
  });

  it('a pointer selects one subtree', async () => {
    const out = await exec(inspectJsonTool({ cwd }), { path: 'config.json', pointers: ['/workers/codebuddy/model'] });
    expect(out).toBe(JSON.stringify({ '/workers/codebuddy/model': 'glm-5.3' }, null, 2));
  });

  it('multiple pointers are returned as a pointer → value map', async () => {
    const out = await exec(inspectJsonTool({ cwd }), { path: 'config.json', pointers: ['/version', '/workers/codebuddy/model'] });
    expect(out).toBe(JSON.stringify({ '/version': '1.2.0', '/workers/codebuddy/model': 'glm-5.3' }, null, 2));
  });

  it('an array index pointer works, and no pointers returns the whole document', async () => {
    const whole = await exec(inspectJsonTool({ cwd }), { path: 'config.json', redact: false });
    expect(JSON.parse(whole)).toEqual(CONFIG);
  });
});

describe('inspect_json redact', () => {
  beforeEach(() => {
    writeFileSync(join(cwd, 'config.json'), JSON.stringify(CONFIG), 'utf-8');
  });

  it('redact defaults to true: credential-like keys are masked anywhere in the tree', async () => {
    const out = await exec(inspectJsonTool({ cwd }), { path: 'config.json', pointers: ['/workers'] });
    expect(out).toContain('"apiKey": "***"');
    expect(out).toContain('"password": "***"');
    for (const secret of ['sk-live-111', 'pwd-222']) {
      expect(out).not.toContain(secret);
    }
    // Non-sensitive values survive untouched.
    expect(out).toContain('"model": "glm-5.3"');
  });

  it('a pointer whose final segment addresses a sensitive key masks the picked value', async () => {
    const out = await exec(inspectJsonTool({ cwd }), { path: 'config.json', pointers: ['/workers/codebuddy/apiKey'] });
    expect(out).not.toContain('sk-live-111');
    expect(out).toContain('"***"');
  });

  it('a pointer that merely CONTAINS the word "token" does not mask an unrelated value', async () => {
    const out = await exec(inspectJsonTool({ cwd }), { path: 'config.json', pointers: ['/tokens/1'] });
    expect(out).toBe(JSON.stringify({ '/tokens/1': 'tok-b' }, null, 2));
  });

  it('redact=false returns values as they are', async () => {
    const out = await exec(inspectJsonTool({ cwd }), { path: 'config.json', pointers: ['/workers/codebuddy/apiKey'], redact: false });
    expect(out).toContain('sk-live-111');
  });

  it('masks authorization/cookie credentials — top-level and inside nested headers', async () => {
    const doc = {
      authorization: 'Bearer top-level',
      headers: { Authorization: 'Bearer x', Cookie: 'a=b; c=d' },
    };
    writeFileSync(join(cwd, 'headers.json'), JSON.stringify(doc), 'utf-8');
    const out = await exec(inspectJsonTool({ cwd }), { path: 'headers.json' });
    expect(out).toContain('"authorization": "***"');
    expect(out).toContain('"Authorization": "***"');
    expect(out).toContain('"Cookie": "***"');
    for (const secret of ['Bearer top-level', 'Bearer x', 'a=b; c=d']) {
      expect(out).not.toContain(secret);
    }
  });

  it('a pointer directly at a sensitive header (/headers/Authorization) masks the picked value', async () => {
    const doc = { headers: { Authorization: 'Bearer x', Cookie: 'a=b' } };
    writeFileSync(join(cwd, 'headers.json'), JSON.stringify(doc), 'utf-8');
    const out = await exec(inspectJsonTool({ cwd }), { path: 'headers.json', pointers: ['/headers/Authorization'] });
    expect(out).not.toContain('Bearer x');
    expect(out).toContain('"***"');
  });

  it('redact=false leaves authorization/cookie header values in clear (regression)', async () => {
    const doc = { headers: { Authorization: 'Bearer x', Cookie: 'a=b' } };
    writeFileSync(join(cwd, 'headers.json'), JSON.stringify(doc), 'utf-8');
    const out = await exec(inspectJsonTool({ cwd }), { path: 'headers.json', redact: false });
    expect(out).toContain('Bearer x');
    expect(out).toContain('a=b');
    expect(out).not.toContain('***');
  });
});

describe('inspect_json errors', () => {
  it('invalid JSON returns a structured error with the parse offset, no stack', async () => {
    writeFileSync(join(cwd, 'broken.json'), '{\n  "version": "1"\n  "name": "x"\n}\n', 'utf-8');
    const out = await exec(inspectJsonTool({ cwd }), { path: 'broken.json' });
    expect(out).toContain('[ERROR] inspect_json: invalid JSON at offset');
    expect(out).toMatch(/offset \d+/);
    expect(out).not.toContain('    at ');
  });

  it('an invalid pointer names the failure and lists the root-level keys', async () => {
    writeFileSync(join(cwd, 'config.json'), JSON.stringify(CONFIG), 'utf-8');
    const out = await exec(inspectJsonTool({ cwd }), { path: 'config.json', pointers: ['/nope/deep'] });
    expect(out).toContain('[ERROR] inspect_json: key "nope" not found in pointer "/nope/deep"');
    expect(out).toContain('root-level keys: version, workers, tokens');
  });

  it('a pointer that does not start with "/" is rejected as malformed', async () => {
    writeFileSync(join(cwd, 'config.json'), JSON.stringify(CONFIG), 'utf-8');
    const out = await exec(inspectJsonTool({ cwd }), { path: 'config.json', pointers: ['workers'] });
    expect(out).toContain('[ERROR] inspect_json: invalid JSON Pointer "workers"');
  });
});

describe('inspect_json maxChars', () => {
  it('output past the cap is cut with an explicit truncation marker', async () => {
    const doc = { log: 'x'.repeat(5000) };
    writeFileSync(join(cwd, 'big.json'), JSON.stringify(doc), 'utf-8');
    const out = await exec(inspectJsonTool({ cwd }), { path: 'big.json', maxChars: 500 });
    expect(out.slice(0, 500).length).toBe(500);
    expect(out).toContain('[Truncated: maxChars=500; showing 500 of');
    expect(out).not.toContain('x'.repeat(600));
  });

  it('default cap is 4000 chars (markers excluded)', async () => {
    const doc = { log: 'y'.repeat(6000) };
    writeFileSync(join(cwd, 'big.json'), JSON.stringify(doc), 'utf-8');
    const out = await exec(inspectJsonTool({ cwd }), { path: 'big.json' });
    expect(out).toContain('[Truncated: maxChars=4000; showing 4000 of');
    expect(out.slice(0, out.indexOf('\n\n[Truncated')).length).toBe(4000);
  });
});
