/**
 * Skill type definitions.
 *
 * A "skill" follows the Anthropic convention: a directory containing a
 * `SKILL.md` with YAML frontmatter plus optional resource files (scripts,
 * templates, etc.). The registry keeps a lightweight descriptor for every
 * discovered skill; the full content is read lazily via `get(name)`.
 */

/** Lightweight metadata for a discovered skill. */
export interface SkillDescriptor {
  /** Skill name — the directory name. Used as the unique key. */
  name: string;
  /** Human-readable description, required from frontmatter. */
  description: string;
  /** Absolute path to the skill directory. */
  dir: string;
}

/** Full skill content, loaded on demand by `SkillRegistry.get()`. */
export interface SkillContent {
  /** Skill name. */
  name: string;
  /** Description from frontmatter. */
  description: string;
  /** Absolute path to the skill directory. */
  dir: string;
  /** `SKILL.md` body with the frontmatter stripped. */
  content: string;
  /**
   * Relative paths of resource files in the skill directory (excluding
   * `SKILL.md` itself). Listed so the agent knows what it can invoke with
   * its existing file/shell tools.
   */
  resources: string[];
}
