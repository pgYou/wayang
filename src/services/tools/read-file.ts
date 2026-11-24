import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineTool, safeExecute } from './common';
import { expandHome } from './permission-rules';
import { isSensitiveKey } from './sensitive-keys';

const DEFAULT_MAX_LINES = 500;

/**
 * "key": "value" / 'key': 'value' — quoted key and quoted value (JSON, JS
 * object literals). Character classes exclude newlines, so a pair never
 * spans lines; the separator is kept tight for the same reason.
 */
const QUOTED_PAIR_RE = /("[^"\n]*"|'[^'\n]*')([ \t]*:[ \t]*)("[^"\n]*"|'[^'\n]*')/g;

/**
 * key: value — unquoted key, value runs to end of line (YAML / ini / config
 * dumps). Line-anchored, so it cannot fire mid-line.
 */
const COLON_PAIR_RE = /^([ \t]*)([A-Za-z0-9_.-]+)([ \t]*:[ \t]*)([^\n]*)$/gm;

/**
 * Mask the values of credential-like keys as `***`. Two shapes: JSON-style
 * quoted pairs and YAML/ini-style `key: value` lines. Quoted pairs run first,
 * so a `"key": "***"` line is already settled when the colon rule scans it.
 */
function redactSecrets(text: string): string {
  const quoted = text.replace(
    QUOTED_PAIR_RE,
    (match, key: string, sep: string, value: string) =>
      isSensitiveKey(key.slice(1, -1)) ? `${key}${sep}${value[0]}***${value[value.length - 1]}` : match,
  );
  return quoted.replace(
    COLON_PAIR_RE,
    (match, indent: string, key: string, sep: string) =>
      isSensitiveKey(key) ? `${indent}${key}${sep}***` : match,
  );
}

export function readFileTool(deps: { cwd?: string } = {}) {
  const workspace = deps.cwd ?? process.cwd();

  return defineTool({
    description: `Read file content (with line numbers). Returns at most ${DEFAULT_MAX_LINES} lines by default. Use offset (1-based start line number) and limit to read specific sections of large files. Use maxLineChars to cap over-long single lines (e.g. JSONL records) and maxChars to cap total output; both cuts carry an explicit truncation marker. Set redact=true to mask values of credential-like keys (apiKey/token/secret/password/authorization/cookie) before any truncation.`,
    parameters: z.object({
      path: z.string().describe('File path (relative to workspace or absolute)'),
      offset: z.number().int().min(1).optional().describe('Start line number (1-based)'),
      limit: z.number().int().min(1).optional().describe('Number of lines to read'),
      maxChars: z.number().int().min(1).optional().describe('Total output character cap (truncation markers excluded); excess is cut with a [Truncated] marker'),
      maxLineChars: z.number().int().min(1).optional().describe('Per-line character cap; an over-long line is cut with a [line truncated] marker'),
      redact: z.boolean().optional().describe('Mask values of credential-like keys (apiKey/token/secret/password/authorization/cookie) as *** before any truncation; default false'),
    }),
    execute: safeExecute('read_file', async ({ path, offset, limit, maxChars, maxLineChars, redact }) => {
      // A leading `~` / `$HOME` expands against the PROCESS home — the same
      // anchor the permission gate uses (`expandHome`) and the same file a
      // shell opens for `cat ~/x`. Never the policy boundary: a scope may
      // anchor anywhere, and expansion must not follow it. `~user` stays
      // unexpanded (it cannot be resolved safely; the gate asks about it).
      const expanded = expandHome(path).path;
      const resolved = resolve(workspace, expanded);
      let content = readFileSync(resolved, 'utf-8');
      // Redact BEFORE any truncation: a cut slice must never carry a plaintext
      // secret that happened to survive the cut.
      if (redact) content = redactSecrets(content);
      const lines = content.split('\n');
      const totalLines = lines.length;
      const start = offset ? offset - 1 : 0;
      const effectiveLimit = limit ?? DEFAULT_MAX_LINES;
      let slice = lines.slice(start, start + effectiveLimit);
      if (maxLineChars !== undefined) {
        slice = slice.map((line) =>
          line.length > maxLineChars
            ? `${line.slice(0, maxLineChars)}[line truncated: ${maxLineChars}/${line.length} chars]`
            : line);
      }
      const numbered = slice.map((line, i) => `${start + i + 1}\t${line}`).join('\n');

      const notes: string[] = [];
      let body = numbered;
      if (maxChars !== undefined && numbered.length > maxChars) {
        body = numbered.slice(0, maxChars);
        notes.push(`[Truncated: maxChars=${maxChars}; showing ${maxChars} of ${numbered.length} chars. Use offset/limit or maxLineChars to narrow the read.]`);
      }
      const end = start + slice.length;
      if (end < totalLines) {
        notes.push(`[Truncated: showing lines ${start + 1}-${end} of ${totalLines}. Use offset and limit to read more.]`);
      }
      return notes.length > 0 ? `${body}\n\n${notes.join('\n')}` : body;
    }),
  });
}
