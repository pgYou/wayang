import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineTool, safeExecute } from './common';
import { expandHome } from './permission-rules';
import { isSensitiveKey } from './sensitive-keys';

const DEFAULT_MAX_CHARS = 4000;

/**
 * Resolve one RFC 6901 JSON Pointer against a parsed document. `""` addresses
 * the whole document; every other pointer starts with `/`. Array tokens are
 * indices; `~1` / `~0` unescape to `/` / `~` (unescape `~1` FIRST — reversing
 * the order would turn a literal `~1` into `/`).
 */
function resolvePointer(
  doc: unknown,
  pointer: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (pointer === '') return { ok: true, value: doc };
  if (!pointer.startsWith('/')) {
    return {
      ok: false,
      error: `invalid JSON Pointer "${pointer}" — a pointer must be empty (whole document) or start with "/"`,
    };
  }
  const tokens = pointer.slice(1).split('/').map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current: unknown = doc;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(token)) {
        return { ok: false, error: `pointer "${pointer}" needs an array index, got "${token}"` };
      }
      const index = Number(token);
      if (index >= current.length) {
        return { ok: false, error: `index ${index} out of bounds (array length ${current.length}) in pointer "${pointer}"` };
      }
      current = current[index];
    } else if (current !== null && typeof current === 'object') {
      if (!Object.prototype.hasOwnProperty.call(current, token)) {
        return { ok: false, error: `key "${token}" not found in pointer "${pointer}"` };
      }
      current = (current as Record<string, unknown>)[token];
    } else {
      return {
        ok: false,
        error: `cannot descend into ${current === null ? 'null' : typeof current} at "${token}" in pointer "${pointer}"`,
      };
    }
  }
  return { ok: true, value: current };
}

/** What an invalid pointer can offer instead: the document's root-level shape. */
function rootSummary(doc: unknown): string {
  if (Array.isArray(doc)) return `root is an array with ${doc.length} items`;
  if (doc !== null && typeof doc === 'object') {
    const keys = Object.keys(doc as Record<string, unknown>);
    return `root-level keys: ${keys.length > 0 ? keys.join(', ') : '(none)'}`;
  }
  return `root is ${doc === null ? 'null' : typeof doc}`;
}

/**
 * Mask credential-like values as `***`, recursively. Applied to EXTRACTED
 * values, never to the pointer→value map's keys — a pointer like `/tokens/1`
 * contains the word "token" but addresses an array item, and must not get its
 * value masked by accident. A pointer whose LAST segment addresses a
 * sensitive key (`/a/b/apiKey`) masks its picked value too, so selecting the
 * secret directly cannot leak it.
 */
function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? '***' : redactValue(val);
    }
    return out;
  }
  return value;
}

/** Last segment of a JSON Pointer (`/a/b/apiKey` → `apiKey`), unescaped. */
function lastTokenOf(pointer: string): string | undefined {
  if (pointer === '' || !pointer.startsWith('/')) return undefined;
  const tokens = pointer.slice(1).split('/');
  return tokens[tokens.length - 1].replace(/~1/g, '/').replace(/~0/g, '~');
}

export function inspectJsonTool(deps: { cwd?: string } = {}) {
  const workspace = deps.cwd ?? process.cwd();

  return defineTool({
    description: `Read a JSON file structurally: pick subtrees by RFC 6901 JSON Pointer (e.g. /workers/codebuddy/model), with secret values (apiKey/token/secret/password/authorization/cookie) masked by default and a total output cap. Prefer this over read_file when you only need fields of a JSON config, and over node -e one-liners entirely. Does NOT support JSONL (one JSON value per line) — use read_file for JSONL.`,
    parameters: z.object({
      path: z.string().describe('JSON file path (relative to workspace or absolute)'),
      pointers: z.array(z.string()).optional().describe('RFC 6901 JSON Pointers selecting subtrees; omit to return the whole document'),
      redact: z.boolean().optional().describe('Mask values of credential-like keys (apiKey/token/secret/password/authorization/cookie) as ***; default true'),
      maxChars: z.number().int().min(1).optional().describe('Total output character cap (truncation markers excluded); default 4000'),
    }),
    execute: safeExecute('inspect_json', async ({ path, pointers, redact, maxChars }) => {
      // Same `~` / `$HOME` expansion anchor read_file and the permission gate
      // use — the file opened is exactly what `cat` would print.
      const expanded = expandHome(path).path;
      const resolved = resolve(workspace, expanded);

      let raw: string;
      try {
        raw = readFileSync(resolved, 'utf-8');
      } catch (err) {
        throw new Error(`cannot read ${path}: ${(err as Error).message}`);
      }

      let doc: unknown;
      try {
        doc = JSON.parse(raw);
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        const position = /position (\d+)/.exec(message)?.[1];
        throw new Error(`invalid JSON at offset ${position ?? 'unknown'}: ${message}`);
      }

      const shouldRedact = redact ?? true;
      let result: unknown;
      if (pointers === undefined || pointers.length === 0) {
        result = shouldRedact ? redactValue(doc) : doc;
      } else {
        const picked: Record<string, unknown> = {};
        for (const pointer of pointers) {
          const resolvedPointer = resolvePointer(doc, pointer);
          if (!resolvedPointer.ok) {
            throw new Error(`${resolvedPointer.error}. ${rootSummary(doc)}`);
          }
          const lastToken = lastTokenOf(pointer);
          picked[pointer] =
            shouldRedact && lastToken !== undefined && isSensitiveKey(lastToken)
              ? '***'
              : shouldRedact
                ? redactValue(resolvedPointer.value)
                : resolvedPointer.value;
        }
        result = picked;
      }

      const body = JSON.stringify(result, null, 2);
      const cap = maxChars ?? DEFAULT_MAX_CHARS;
      if (body.length > cap) {
        return `${body.slice(0, cap)}\n\n[Truncated: maxChars=${cap}; showing ${cap} of ${body.length} chars. Narrow with pointers.]`;
      }
      return body;
    }),
  });
}
