/**
 * SkillRegistry — discovers, stores, and lazily serves skill content.
 *
 * Construction scans the provided directories once and builds a list of
 * {@link SkillDescriptor}s (description only). The full SKILL.md body is read
 * on demand via {@link SkillRegistry.get} and cached in memory, so repeated
 * `use_skill` calls from multiple agents don't re-read disk.
 *
 * On name conflict, directories later in the input array win — callers must
 * pass them in priority order (lowest → highest), see {@link resolveSkillDirs}.
 */

import { readFileSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import type { Logger } from '@/infra/logger';
import type { SkillContent, SkillDescriptor } from './types';

const SKILL_FILE = 'SKILL.md';

// ---------------------------------------------------------------------------
// Frontmatter parser (YAML, via the `yaml` package)
// ---------------------------------------------------------------------------

interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Split a `---\n<yaml>\n---\n<body>` document.
 *
 * Tolerates leading BOM and CRLF line endings. When no frontmatter block is
 * present (or the fence is unclosed), the whole text is returned as the body
 * with an empty frontmatter object.
 */
function parseFrontmatter(raw: string): ParsedMarkdown {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

  // Optional opening fence on the very first line.
  const openMatch = text.match(/^---\s*\n/);
  if (!openMatch) return { frontmatter: {}, body: text.trim() };

  const afterOpen = text.slice(openMatch[0].length);
  const closeIdx = afterOpen.search(/\n---\s*(?:\n|$)/);
  if (closeIdx === -1) {
    // Unclosed fence — treat the whole thing as body, ignore frontmatter.
    return { frontmatter: {}, body: text.trim() };
  }

  const frontmatterText = afterOpen.slice(0, closeIdx);
  const body = afterOpen.slice(closeIdx).replace(/^\n---\s*\n?/, '');

  let frontmatter: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(frontmatterText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed YAML — fall back to an empty frontmatter, keep the body.
    frontmatter = {};
  }

  return { frontmatter, body: body.trim() };
}

/** Coerce a frontmatter value to a trimmed string; returns '' for non-strings. */
function asString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

// ---------------------------------------------------------------------------
// Resource listing
// ---------------------------------------------------------------------------

/**
 * List resource files (relative to the skill dir) excluding SKILL.md itself.
 * Shallow walk — one level under the skill dir plus immediate subdirectories.
 * Deep nesting is rare for skills; a bounded walk keeps the result readable.
 */
function listResources(skillDir: string): string[] {
  const out: string[] = [];

  const walk = (relDir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(join(skillDir, relDir), { withFileTypes: true }) as Dirent[];
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.name === SKILL_FILE) continue;
      if (entry.isDirectory()) {
        // Skip hidden dirs (e.g. .git) and node_modules.
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        walk(rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  };

  walk('');
  return out.sort();
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class SkillRegistry {
  private readonly descriptors = new Map<string, SkillDescriptor>();
  private readonly cache = new Map<string, SkillContent>();
  private readonly logger?: Logger;

  constructor(dirs: string[], logger?: Logger) {
    this.logger = logger;
    for (const dir of dirs) this.scan(dir);
  }

  /** Number of discovered skills. */
  get size(): number {
    return this.descriptors.size;
  }

  /** All discovered descriptors (no particular order). */
  list(): SkillDescriptor[] {
    return [...this.descriptors.values()];
  }

  /** Whether a skill with the given name exists. */
  has(name: string): boolean {
    return this.descriptors.has(name);
  }

  /**
   * Load the full content for a skill. Returns `undefined` if not found.
   * Results are cached so repeated calls don't re-read disk.
   */
  get(name: string): SkillContent | undefined {
    const existing = this.cache.get(name);
    if (existing) return existing;

    const desc = this.descriptors.get(name);
    if (!desc) return undefined;

    const filePath = join(desc.dir, SKILL_FILE);
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch (err: unknown) {
      this.logger?.warn({ skill: name, error: err instanceof Error ? err.message : String(err) }, 'Failed to read skill file');
      return undefined;
    }

    const { frontmatter, body } = parseFrontmatter(raw);
    const inlineDesc = asString(frontmatter.description);
    const content: SkillContent = {
      name: desc.name,
      description: inlineDesc || desc.description,
      dir: desc.dir,
      content: body,
      resources: listResources(desc.dir),
    };

    this.cache.set(name, content);
    return content;
  }

  // --- Internal: discovery --------------------------------------------------

  private scan(dir: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
    } catch {
      return; // dir vanished between resolution and scan — treat as empty.
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      const skillDir = join(dir, entry.name);
      const skillFile = join(skillDir, SKILL_FILE);
      if (!existsAsFile(skillFile)) continue;

      const { frontmatter } = safeReadFrontmatter(skillFile);
      const description = asString(frontmatter.description);
      if (!description) {
        this.logger?.warn({ skill: entry.name, dir: skillDir }, 'Skill missing frontmatter.description — skipped');
        continue;
      }

      // Later scan dirs override earlier ones — see resolveSkillDirs priority.
      this.descriptors.set(entry.name, { name: entry.name, description, dir: skillDir });
      this.cache.delete(entry.name); // invalidate cache if re-scanned.
    }
  }
}

// ---------------------------------------------------------------------------
// Small fs helpers (kept module-local to avoid extra imports in callers)
// ---------------------------------------------------------------------------

function existsAsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function safeReadFrontmatter(path: string): ParsedMarkdown {
  try {
    return parseFrontmatter(readFileSync(path, 'utf-8'));
  } catch {
    return { frontmatter: {}, body: '' };
  }
}
