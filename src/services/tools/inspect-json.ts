import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineTool, safeExecute, MAX_RESULT_CHARS } from './common';
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
 * values, never to the pointer→value map's keys. A pointer whose ANY segment
 * (ancestor or last) addresses a sensitive key (`/a/privateKey/x`,
 * `/a/b/apiKey`) masks its picked value too, so selecting into a sensitive
 * subtree — not just the leaf key — cannot leak it. This keeps pointer picks
 * consistent with the whole-document view, where the sensitive key's entire
 * subtree is masked.
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

/**
 * Segments of a JSON Pointer (`/a/b/apiKey` → ['a', 'b', 'apiKey']), each
 * unescaped (`~1`/`~0` → `/`/`~`). Undefined for the whole-document pointer
 * `""` and for malformed pointers that do not start with `/` — those never
 * reach the sensitivity check anyway (malformed ones fail resolvePointer
 * first).
 */
function pointerTokens(pointer: string): string[] | undefined {
  if (pointer === '' || !pointer.startsWith('/')) return undefined;
  return pointer.slice(1).split('/').map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
}

export function inspectJsonTool(deps: { cwd?: string } = {}) {
  const workspace = deps.cwd ?? process.cwd();

  return defineTool({
    description: `Read a JSON file structurally: pick subtrees by RFC 6901 JSON Pointer (e.g. /workers/codebuddy/model), with secret values (apiKey/token/secret/password/authorization/cookie/privateKey/accessKey/passwd/credentials) masked by default — including whole subtrees under any sensitive key on the pointer path — and a total output cap. Prefer this over read_file when you only need fields of a JSON config, and over node -e one-liners entirely. Does NOT support JSONL (one JSON value per line) — use read_file for JSONL.`,
    parameters: z.object({
      path: z.string().describe('JSON file path (relative to workspace or absolute)'),
      pointers: z.array(z.string()).optional().describe('RFC 6901 JSON Pointers selecting subtrees; omit to return the whole document'),
      redact: z.boolean().optional().describe('Mask values of credential-like keys (apiKey/token/secret/password/authorization/cookie/privateKey/accessKey/passwd/credentials) as ***; default true'),
      maxChars: z.number().int().min(1).max(MAX_RESULT_CHARS).optional().describe(`Total output character cap (truncation markers excluded); ${MAX_RESULT_CHARS} is the transport layer's real cap — larger values are a parameter error; default 4000`),
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
          const tokens = pointerTokens(pointer);
          picked[pointer] =
            shouldRedact && tokens !== undefined && tokens.some(isSensitiveKey)
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
