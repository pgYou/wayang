/**
 * Controller startup rules — home and cwd AGENTS.md loaded into the system prompt.
 *
 * The Controller plans work and writes task descriptions in the project it was
 * started in, so it needs that project's conventions up front. Until now the
 * only rules it ever saw arrived passively, echoed back by `add_task` results
 * (those describe the TARGET workspace and are meant for the worker — see
 * workspace-rules / project-rules.ts).
 *
 * This module reads at most two files, once at startup:
 *
 *   1. `<homeDir>/AGENTS.md` — user-wide baseline
 *   2. `<cwd>/AGENTS.md`     — project rules, applied after the baseline
 *
 * Order encodes precedence: the cwd rules come last and win on conflict, and
 * the rendered section says so explicitly. Nothing here re-reads the files
 * later in the session — the Controller prompt is static per process.
 *
 * Deliberately separate from project-rules.ts (worker side): a worker walks up
 * from its own task workspace looking for AGENTS.md/CLAUDE.md, while the
 * Controller reads exactly these two startup locations and only AGENTS.md.
 */

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Rules file name looked up in the home and cwd directories. */
export const CONTROLLER_RULES_FILENAME = 'AGENTS.md';

/**
 * Hard cap on the injected rules content, in UTF-8 BYTES (`maxBytes` counts
 * file bodies only — headings, the precedence note and the truncation marker
 * are outside the budget).
 *
 * Bytes, not characters: the issue asks for 32KB, and byte length is what an
 * on-disk file / API payload actually measures. The tradeoff is that a CJK
 * rules file (≈3 bytes per character) effectively gets ~11k characters out of
 * the same budget, which is accepted — the cap exists to bound the prompt, and
 * a conservative bound is the safe side.
 */
export const CONTROLLER_RULES_MAX_BYTES = 32 * 1024;

export interface ControllerRulesOptions {
  /** User home directory — rules here are the baseline. */
  homeDir: string;
  /** Startup working directory — rules here come last and take precedence. */
  cwd: string;
  /** Override the total content cap (UTF-8 bytes). Defaults to 32KB. */
  maxBytes?: number;
}

/** A rules file that was read successfully. */
interface RuleFile {
  /** Canonical path (realpath) — used for the source label and dedupe. */
  path: string;
  content: string;
}

/**
 * Load the Controller's startup rules and render them as one prompt section.
 *
 * Returns an empty string when neither file exists (or both are empty/
 * unreadable) so `assemble()` drops the section and the prompt stays exactly
 * as it was before. Never throws: any I/O problem is treated as "no rules",
 * because a missing or unreadable rules file must not fail startup.
 */
export function loadControllerRules(opts: ControllerRulesOptions): string {
  const maxBytes = opts.maxBytes ?? CONTROLLER_RULES_MAX_BYTES;

  // Home first (baseline), cwd second (supplement). Dedupe by canonical path:
  // starting wayang inside the home directory makes both lookups hit the same
  // file, which must be loaded once.
  const files: RuleFile[] = [];
  for (const dir of [opts.homeDir, opts.cwd]) {
    if (!dir) continue;
    const file = readRulesFile(dir);
    if (!file) continue;
    if (files.some((seen) => seen.path === file.path)) continue;
    files.push(file);
  }
  if (files.length === 0) return '';

  // Fill in file order until the cap is reached: earlier files stay complete,
  // the file that crosses the limit is cut, anything after it is dropped.
  const bodies: string[] = [];
  let usedBytes = 0;
  let truncated = false;
  for (const file of files) {
    const heading = `## Project rules (from ${file.path})`;
    const size = Buffer.byteLength(file.content, 'utf8');
    if (usedBytes + size <= maxBytes) {
      bodies.push(`${heading}\n\n${file.content.trimEnd()}`);
      usedBytes += size;
      continue;
    }
    const budget = maxBytes - usedBytes;
    const head = budget > 0 ? truncateToBytes(file.content, budget).trimEnd() : '';
    bodies.push(head ? `${heading}\n\n${head}` : heading);
    truncated = true;
    break;
  }

  const intro =
    `${CONTROLLER_RULES_FILENAME} content loaded once at startup. The home directory file comes ` +
    'first as the baseline; the working directory file comes second and takes precedence ' +
    'wherever the two disagree. Follow these rules unless the user explicitly overrides them.';

  const parts = [`# Project rules\n\n${intro}`, ...bodies];
  if (truncated) {
    parts.push(
      `...truncated at ${maxBytes} bytes (rules content exceeded the ${maxBytes}-byte total ` +
        'limit: the rest of the last file and any later files were dropped)',
    );
  }
  return parts.join('\n\n');
}

/**
 * Read `<dir>/AGENTS.md`, or null when it is absent, unreadable, not a regular
 * file, or blank.
 *
 * All failures are swallowed on purpose — a broken rules file is not worth a
 * warning, let alone a failed startup.
 */
function readRulesFile(dir: string): RuleFile | null {
  const candidate = join(dir, CONTROLLER_RULES_FILENAME);
  try {
    // realpathSync both resolves symlinks and rejects missing paths.
    const path = realpathSync(candidate);
    if (!statSync(path).isFile()) return null;
    const content = readFileSync(path, 'utf8');
    if (!content.trim()) return null;
    return { path, content };
  } catch {
    // ENOENT / EACCES / ENOTDIR / ELOOP — treat as absent.
    return null;
  }
}

/**
 * Cut `text` down to at most `maxBytes` UTF-8 bytes without splitting a
 * multi-byte character (a mid-character cut decodes to a trailing U+FFFD,
 * which is stripped).
 */
function truncateToBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  return buf.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/, '');
}
