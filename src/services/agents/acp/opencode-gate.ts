/**
 * opencode permission-gate shared definitions and INHERITED-config validation
 * (#62): the ask-all rule the worker injects, the explicit read-only
 * exemption table, and the fail-closed validator deciding whether an
 * inherited `OPENCODE_CONFIG` still gates tool operations with ask rules.
 *
 * Why validation exists (measured #25, 03 booklet §3.2): opencode 2.2.5's
 * default permission rules are allow-all (only `.env` reads ask). An
 * inherited OPENCODE_CONFIG that does not ask therefore silently restores
 * those defaults — the permission bridge is bypassed entirely, including
 * writes outside the workspace. A mere warn (the pre-#62 behavior) drowns
 * too easily; wayang now refuses to launch on a config it cannot PROVE is
 * gate-equivalent (the fail-closed discipline of 04 booklet §5).
 *
 * What counts as proof — a ruleset is gate-equivalent iff BOTH hold:
 *  1. it contains the ask-all rule (`action:'*'`, `resource:'*'`,
 *     `effect:'ask'`) — the same rule the injected gate writes. A scoped
 *     resource (e.g. `'./**'`) proves nothing about out-of-workspace writes.
 *  2. every `allow` rule names an action from GATE_EXEMPT_ACTIONS — matched
 *     EXACTLY (see the table). A wildcard or sensitive allow cannot be
 *     proven not to defeat the ask gate (opencode's rule precedence is
 *     unmeasured), so it disqualifies the whole config. `deny` rules only
 *     restrict further and never disqualify.
 * Anything else — missing/empty `permissions`, an unreadable or malformed
 * config, an unknown effect — is NOT equivalent: no matching rule means
 * refuse (default deny).
 */

import { readFileSync } from 'node:fs';

/** Gate file name inside the worker's own session dir (written at launch, removed at run end). */
export const GATE_FILE_NAME = 'opencode-acp-gate.json';

/** The ask-all rule the injected gate writes (measured #25): every tool operation must ask. */
export const GATE_ASK_ALL_RULE = { action: '*', resource: '*', effect: 'ask' } as const;

/**
 * The ONLY tool actions that may run without asking under a validated
 * inherited config: read-only local tools. An explicit enumeration on
 * purpose — matching is EXACT (never a prefix/substring/pattern test), so a
 * future or adversarial `read_file` / `readEnv` never inherits the `read`
 * exemption. Anything not listed — bash, edit, delete, move, webfetch, and
 * every unknown action — is sensitive: an `allow` rule for it disqualifies
 * the config.
 */
export const GATE_EXEMPT_ACTIONS: readonly string[] = ['read', 'grep', 'glob', 'list'];

/** Verdict of validating an inherited OPENCODE_CONFIG; `reason` is display-ready. */
export interface GateConfigVerdict {
  equivalent: boolean;
  reason?: string;
}

function isAskAllRule(rule: unknown): boolean {
  if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) return false;
  const r = rule as Record<string, unknown>;
  return r.effect === 'ask' && r.action === '*' && r.resource === '*';
}

/** The exemption check: exact membership, nothing else (no prefix, no substring). */
function isExemptAction(action: unknown): boolean {
  return typeof action === 'string' && GATE_EXEMPT_ACTIONS.includes(action);
}

/**
 * Validate a PARSED opencode config's `permissions` ruleset (pure; exported
 * for unit tests). Default deny: without a provable ask-all +
 * read-only-only-allows shape the verdict is `equivalent:false`.
 */
export function validateGateRuleset(parsed: unknown): GateConfigVerdict {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { equivalent: false, reason: 'config is not a JSON object' };
  }
  const permissions = (parsed as Record<string, unknown>).permissions;
  if (!Array.isArray(permissions)) {
    return { equivalent: false, reason: 'no "permissions" ruleset (opencode defaults are allow-all)' };
  }
  if (!permissions.some(isAskAllRule)) {
    return { equivalent: false, reason: 'no ask-all rule {"action":"*","resource":"*","effect":"ask"}' };
  }
  for (const rule of permissions) {
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
      return { equivalent: false, reason: 'malformed permission rule (not an object)' };
    }
    const r = rule as Record<string, unknown>;
    if (typeof r.effect !== 'string' || (r.effect !== 'allow' && r.effect !== 'ask' && r.effect !== 'deny')) {
      return { equivalent: false, reason: `unknown permission effect "${String(r.effect)}"` };
    }
    if (r.effect === 'allow' && !isExemptAction(r.action)) {
      return {
        equivalent: false,
        reason: `allow rule for non-read-only action "${String(r.action)}" — cannot prove it does not defeat the ask gate`,
      };
    }
  }
  return { equivalent: true };
}

/**
 * Load the inherited OPENCODE_CONFIG value and validate it. The measured
 * form (03 booklet §3.2) is a PATH to a JSON config file; an inline JSON
 * object (trimmed value starts with `{`) is accepted too. Unreadable or
 * unparseable values are a default deny — an unverifiable config cannot
 * prove the gate.
 */
export function validateInheritedGateConfig(value: string): GateConfigVerdict {
  const trimmed = value.trim();
  let text: string;
  if (trimmed.startsWith('{')) {
    text = trimmed;
  } else {
    try {
      text = readFileSync(value, 'utf8');
    } catch (err) {
      return {
        equivalent: false,
        reason: `could not read the OPENCODE_CONFIG file (${err instanceof Error ? err.message : String(err)})`,
      };
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      equivalent: false,
      reason: `OPENCODE_CONFIG is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  return validateGateRuleset(parsed);
}
