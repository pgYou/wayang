/**
 * opencode gate validation tests (#62): default deny on unprovable configs
 * (no matching rule → refuse), the explicit read-only exemption table with
 * EXACT matching (no prefix/substring inheritance), the ask-all proof
 * requirement, and the loader (file path / inline JSON / unreadable /
 * malformed).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GATE_ASK_ALL_RULE,
  GATE_EXEMPT_ACTIONS,
  validateGateRuleset,
  validateInheritedGateConfig,
} from '@/services/agents/acp/opencode-gate';

describe('validateGateRuleset (#62 inherited-config validation)', () => {
  it('accepts the ask-all ruleset (the very matrix the injected gate writes)', () => {
    expect(validateGateRuleset({ permissions: [{ action: '*', resource: '*', effect: 'ask' }] })).toEqual({ equivalent: true });
    expect(validateGateRuleset({ permissions: [GATE_ASK_ALL_RULE] })).toEqual({ equivalent: true });
  });

  it('default deny: a non-object config, missing permissions, an empty ruleset, or an allow-only ruleset is refused', () => {
    for (const parsed of [null, 'string', 42, [], {}, { permissions: 'yes' }, { permissions: [] }]) {
      const verdict = validateGateRuleset(parsed);
      expect(verdict.equivalent).toBe(false);
      expect(verdict.reason).toBeTruthy();
    }
    const allowOnly = validateGateRuleset({ permissions: [{ action: '*', resource: '*', effect: 'allow' }] });
    expect(allowOnly.equivalent).toBe(false);
    expect(allowOnly.reason).toContain('ask-all');
  });

  it('a scoped-resource ask rule does not prove out-of-workspace coverage (resource must be "*")', () => {
    expect(validateGateRuleset({ permissions: [{ action: '*', resource: './**', effect: 'ask' }] }).equivalent).toBe(false);
    expect(validateGateRuleset({ permissions: [{ action: '*', effect: 'ask' }] }).equivalent).toBe(false);
  });

  it('allow rules for exempt read-only actions keep an ask-all config equivalent', () => {
    expect(
      validateGateRuleset({
        permissions: [
          { action: 'read', resource: '*', effect: 'allow' },
          { action: 'glob', effect: 'allow' },
          { action: '*', resource: '*', effect: 'ask' },
        ],
      }),
    ).toEqual({ equivalent: true });
  });

  it('exemption matching is EXACT — prefixes, substrings, wildcards and sensitive actions never inherit it', () => {
    for (const action of ['read_file', 'readwrite', 're', 'reads', 'READ', '*', 'bash', 'edit', 'delete', 'move', 'fetch', 'webfetch', 'unknown-tool']) {
      const verdict = validateGateRuleset({
        permissions: [
          { action, resource: '*', effect: 'allow' },
          { action: '*', resource: '*', effect: 'ask' },
        ],
      });
      expect(verdict.equivalent, `action "${action}" must not be exempt`).toBe(false);
    }
  });

  it('the exemption table is the explicit read-only set — sensitive tools are never in it', () => {
    expect([...GATE_EXEMPT_ACTIONS]).toEqual(['read', 'grep', 'glob', 'list']);
    for (const sensitive of ['bash', 'edit', 'write', 'delete', 'move', 'fetch', 'webfetch']) {
      expect(GATE_EXEMPT_ACTIONS).not.toContain(sensitive);
    }
  });

  it('deny rules only restrict further and never disqualify a config', () => {
    expect(
      validateGateRuleset({
        permissions: [
          { action: 'bash', resource: 'rm *', effect: 'deny' },
          { action: '*', resource: '*', effect: 'ask' },
        ],
      }),
    ).toEqual({ equivalent: true });
  });

  it('malformed rules (non-object, unknown or missing effect) are a default deny', () => {
    for (const rule of ['not-a-rule', 42, null, { action: 'read', effect: 'Allow' }, { action: 'read' }]) {
      const verdict = validateGateRuleset({ permissions: [rule, { action: '*', resource: '*', effect: 'ask' }] });
      expect(verdict.equivalent, `rule ${JSON.stringify(rule)} must disqualify`).toBe(false);
      expect(verdict.reason).toBeTruthy();
    }
  });
});

describe('validateInheritedGateConfig (loader)', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opencode-gate-test-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reads a config file path and validates its ruleset', () => {
    const askAllPath = join(tempDir, 'ask-all.json');
    writeFileSync(askAllPath, JSON.stringify({ permissions: [{ action: '*', resource: '*', effect: 'ask' }] }), 'utf8');
    expect(validateInheritedGateConfig(askAllPath)).toEqual({ equivalent: true });

    const allowAllPath = join(tempDir, 'allow-all.json');
    writeFileSync(allowAllPath, JSON.stringify({ permissions: [{ action: '*', resource: '*', effect: 'allow' }] }), 'utf8');
    const refused = validateInheritedGateConfig(allowAllPath);
    expect(refused.equivalent).toBe(false);
    expect(refused.reason).toContain('ask-all');
  });

  it('accepts an inline JSON value (trimmed value starting with "{")', () => {
    expect(
      validateInheritedGateConfig('  {"permissions":[{"action":"*","resource":"*","effect":"ask"}]}  '),
    ).toEqual({ equivalent: true });
  });

  it('default deny: an unreadable path or invalid JSON is refused with a reason', () => {
    const missing = validateInheritedGateConfig(join(tempDir, 'does-not-exist.json'));
    expect(missing.equivalent).toBe(false);
    expect(missing.reason).toContain('could not read');

    const badJsonPath = join(tempDir, 'bad.json');
    writeFileSync(badJsonPath, 'not json at all', 'utf8');
    const bad = validateInheritedGateConfig(badJsonPath);
    expect(bad.equivalent).toBe(false);
    expect(bad.reason).toContain('not valid JSON');
  });
});
