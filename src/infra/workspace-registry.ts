/**
 * WorkspaceRegistry — minimal workspace identity: canonical path → slug.
 *
 * Why a registry at all: sessions need a human-friendly, stable handle for the
 * directory they were started in. Deriving the slug on the fly from the path is
 * not enough, because two different directories can share a basename and the
 * handle must stay stable across renames of the *display* suffix.
 *
 * Invariants:
 * - A slug is assigned once and never changes; `lastSeenAt` is the only field
 *   that moves on repeat visits, so downstream references stay valid.
 * - Slugs are never reused. A removed or reserved entry keeps its slug claimed
 *   for as long as it exists in the registry file.
 *
 * Storage: `<wayangDir>/workspaces.json`, a single JSON document. The
 * read-modify-write cycle here is deliberately synchronous, which is what makes
 * it safe within one process: two callers in the same Node process cannot
 * interleave between the read and the write because no tick boundary exists
 * between them.
 *
 * Concurrency scope: same-process serialization only. There is NO cross-process
 * lock. Two Wayang processes writing this file at the same time can clobber each
 * other's additions (last writer wins for the whole document). That is accepted
 * for now: entries are additive and idempotent per path, so the worst case is a
 * re-created entry with a fresh timestamp, not a corrupted file. If cross-process
 * safety is ever required, the fix is a lock file or an append-only log, not
 * a bigger in-process mutex.
 *
 * Corruption policy: a malformed registry is NEVER silently reset. On the
 * write path (`getOrCreateWorkspace`) the bad file is renamed to
 * `<file>.corrupt` (preserving evidence) and an error is thrown, so the caller
 * decides whether to start over. Read paths (`findWorkspace`, `listWorkspaces`,
 * `resolveWorkspaceRef`) never rename: they surface the error, and
 * `resolveWorkspaceRef` logs it with the backup path before degrading to the
 * rule-based slug (`degraded: true`). A version mismatch is never destructive:
 * a future v2 file is rejected in place, never renamed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync } from '@/infra/state/persistence/atomic-write';

/** One workspace identity as persisted in `workspaces.json`. */
export interface WorkspaceEntry {
  /** Stable, human-friendly handle. Assigned once, never reassigned. */
  slug: string;
  /** Canonical (realpath-resolved) directory path — also the registry key. */
  path: string;
  /** ISO timestamp of the first time this path was registered. */
  firstSeenAt: string;
  /** ISO timestamp of the most recent `getOrCreateWorkspace` call. */
  lastSeenAt: string;
  /** Slug is claimed but has no live session. Kept for slug non-reuse. */
  reserved: boolean;
}

/** The trimmed-down result callers usually want: identity only. */
export interface WorkspaceRef {
  path: string;
  slug: string;
  /**
   * Set only when the ref was resolved without a trustworthy registry read
   * (no `wayangDir`, corrupt document, unsupported version). The `slug` is then
   * a rule-based fallback rather than the reserved registry slug, so callers
   * that care can tell the difference. Absent/false means "registry-backed".
   */
  degraded?: boolean;
}

/** On-disk document shape. */
export interface WorkspaceRegistryFile {
  version: 1;
  workspaces: Record<string, WorkspaceEntry>;
}

const REGISTRY_VERSION = 1;
const REGISTRY_FILENAME = 'workspaces.json';
/** Slug used when a path's basename has no usable [a-z0-9] characters. */
const FALLBACK_SLUG = 'workspace';
/** Upper bound for collision probing; far beyond any realistic slug count. */
const MAX_COLLISION_ATTEMPTS = 10_000;

/** Absolute path of the registry document inside `wayangDir` (usually ~/.wayang). */
export function registryFilePath(wayangDir: string): string {
  return path.join(wayangDir, REGISTRY_FILENAME);
}

/**
 * Canonicalize a workspace path.
 *
 * `realpathSync` is preferred so that symlinked and `..`-laden paths collapse to
 * the same identity (one workspace, one slug). It requires the path to exist;
 * for paths that do not (yet) exist we fall back to `path.resolve`, which is
 * still absolute and normalized but does not follow symlinks.
 */
export function normalizeWorkspacePath(rawPath: string): string {
  try {
    return fs.realpathSync(rawPath);
  } catch {
    return path.resolve(rawPath);
  }
}

/**
 * Pure slug rule: basename → lowercase → non [a-z0-9] becomes '-' →
 * collapse repeats → trim leading/trailing '-' → fallback to 'workspace'.
 *
 * Collision suffixes ('-2', '-3', ...) are NOT applied here; that needs the
 * surrounding registry, see `allocateSlug`.
 */
export function workspaceSlugFromPath(workspacePath: string): string {
  const basename = path.basename(workspacePath);
  const slug = basename
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : FALLBACK_SLUG;
}

function emptyRegistry(): WorkspaceRegistryFile {
  return { version: REGISTRY_VERSION, workspaces: {} };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Which failure policy a registry read applies:
 * - `write`: a corrupt document may be moved aside (`quarantine`) before the
 *   error is thrown, so the write path can start over without destroying bytes.
 * - `read`: never touch the file; just surface the error so the caller can
 *   degrade. Read-only callers (resolveWorkspaceRef / findWorkspace /
 *   listWorkspaces) must not rename files as a side effect.
 */
type RegistryAccessMode = 'read' | 'write';

/**
 * Corrupt/unsupported registry error. `backupPath` is the evidence location:
 * the actual rename target on the write path, or the intended target on the
 * read path (where nothing is renamed). Callers log it for post-mortem.
 */
class WorkspaceRegistryCorruptionError extends Error {
  readonly filePath: string;
  readonly backupPath?: string;

  constructor(message: string, filePath: string, backupPath?: string) {
    super(message);
    this.name = 'WorkspaceRegistryCorruptionError';
    this.filePath = filePath;
    this.backupPath = backupPath;
  }
}

/** Where a quarantine rename would put the file (never destroys an old backup). */
function plannedBackupPath(filePath: string): string {
  const primaryBackup = `${filePath}.corrupt`;
  // Do not clobber an earlier backup; make this one distinguishable.
  return fs.existsSync(primaryBackup) ? `${filePath}.${Date.now()}.corrupt` : primaryBackup;
}

/**
 * Move a corrupt registry aside so it is never overwritten, then return the
 * error to throw. The backup keeps the original bytes for post-mortem.
 */
function quarantineCorruptFile(filePath: string, detail: string): WorkspaceRegistryCorruptionError {
  const backupPath = plannedBackupPath(filePath);
  try {
    fs.renameSync(filePath, backupPath);
  } catch (renameErr) {
    throw new WorkspaceRegistryCorruptionError(
      `Workspace registry at ${filePath} is corrupt (${detail}) and could not be moved to ${backupPath}: ${
        (renameErr as Error).message
      }`,
      filePath,
      backupPath,
    );
  }
  return new WorkspaceRegistryCorruptionError(
    `Workspace registry at ${filePath} is corrupt (${detail}); original moved to ${backupPath}`,
    filePath,
    backupPath,
  );
}

/**
 * Corruption surfaced on the read path: leave the file exactly as-is (renaming
 * is reserved for the write path) but still report where the evidence would be
 * moved by a later write, so the caller can log a concrete path.
 */
function reportCorruptFile(filePath: string, detail: string): WorkspaceRegistryCorruptionError {
  const backupPath = plannedBackupPath(filePath);
  return new WorkspaceRegistryCorruptionError(
    `Workspace registry at ${filePath} is corrupt (${detail}); file left untouched (a later write will quarantine it to ${backupPath})`,
    filePath,
    backupPath,
  );
}

/**
 * Version mismatch is never destructive: a future v2 document must not be
 * renamed into `.corrupt`. Throw/return an error and leave the bytes intact on
 * both read and write paths.
 */
function unsupportedVersionError(filePath: string, found: unknown): WorkspaceRegistryCorruptionError {
  return new WorkspaceRegistryCorruptionError(
    `Workspace registry at ${filePath} has an unsupported version (${String(found)}); file left untouched`,
    filePath,
  );
}

/** Route a corruption to the mode-appropriate policy (rename only on write). */
function corruptionError(
  mode: RegistryAccessMode,
  filePath: string,
  detail: string,
): WorkspaceRegistryCorruptionError {
  return mode === 'write' ? quarantineCorruptFile(filePath, detail) : reportCorruptFile(filePath, detail);
}

function parseRegistry(filePath: string, raw: string, mode: RegistryAccessMode): WorkspaceRegistryFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw corruptionError(mode, filePath, `invalid JSON: ${(err as Error).message}`);
  }

  if (!isPlainObject(parsed)) {
    throw corruptionError(mode, filePath, 'top-level value is not an object');
  }
  // version mismatch: reject without ever renaming, regardless of mode.
  if (parsed.version !== REGISTRY_VERSION) {
    throw unsupportedVersionError(filePath, parsed.version);
  }
  if (!isPlainObject(parsed.workspaces)) {
    throw corruptionError(mode, filePath, '"workspaces" is not an object');
  }

  const workspaces: Record<string, WorkspaceEntry> = {};
  for (const [key, value] of Object.entries(parsed.workspaces)) {
    if (
      !isPlainObject(value) ||
      typeof value.slug !== 'string' ||
      value.slug.length === 0 ||
      typeof value.path !== 'string'
    ) {
      throw corruptionError(mode, filePath, `malformed entry for ${JSON.stringify(key)}`);
    }
    workspaces[key] = {
      slug: value.slug,
      path: value.path,
      firstSeenAt: typeof value.firstSeenAt === 'string' ? value.firstSeenAt : '',
      lastSeenAt: typeof value.lastSeenAt === 'string' ? value.lastSeenAt : '',
      reserved: value.reserved === true,
    };
  }

  return { version: REGISTRY_VERSION, workspaces };
}

/** Read + validate the registry; a missing file is an empty registry. */
function readRegistry(wayangDir: string, mode: RegistryAccessMode): WorkspaceRegistryFile {
  const filePath = registryFilePath(wayangDir);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyRegistry();
    throw err;
  }
  return parseRegistry(filePath, raw, mode);
}

/** Write the whole document via temp file + rename (crash-safe overwrite). */
function writeRegistry(wayangDir: string, registry: WorkspaceRegistryFile): void {
  atomicWriteFileSync(registryFilePath(wayangDir), `${JSON.stringify(registry, null, 2)}\n`);
}

/** Pick the first free slug: base, then base-2, base-3, ... */
function allocateSlug(registry: WorkspaceRegistryFile, base: string): string {
  const taken = new Set(Object.values(registry.workspaces).map(entry => entry.slug));
  if (!taken.has(base)) return base;

  for (let suffix = 2; suffix <= MAX_COLLISION_ATTEMPTS; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`Could not allocate a unique slug for "${base}" after ${MAX_COLLISION_ATTEMPTS} attempts`);
}

/**
 * Return the workspace identity for `rawPath`, registering it on first sight.
 *
 * Repeat calls for the same canonical path return the same slug and only bump
 * `lastSeenAt`; the slug never changes for the lifetime of the entry.
 */
export function getOrCreateWorkspace(wayangDir: string, rawPath: string): WorkspaceRef {
  const resolvedPath = normalizeWorkspacePath(rawPath);
  const registry = readRegistry(wayangDir, 'write');
  const now = new Date().toISOString();

  const existing = registry.workspaces[resolvedPath];
  if (existing) {
    existing.path = resolvedPath;
    existing.lastSeenAt = now;
    writeRegistry(wayangDir, registry);
    return { path: resolvedPath, slug: existing.slug };
  }

  const slug = allocateSlug(registry, workspaceSlugFromPath(resolvedPath));
  registry.workspaces[resolvedPath] = {
    slug,
    path: resolvedPath,
    firstSeenAt: now,
    lastSeenAt: now,
    reserved: false,
  };
  writeRegistry(wayangDir, registry);
  return { path: resolvedPath, slug };
}

/**
 * Identity to stamp into a persisted record (session meta, task, worker
 * runtime-state) for the workspace at `rawPath`.
 *
 * Registry-first, so one directory keeps one slug across every record. The
 * lookup is read-only when the path is already registered (no timestamp churn
 * on a pure read path) and registers on first sight.
 *
 * `wayangDir` is null when the caller has no home dir to consult; then, and
 * whenever the registry is unreadable or corrupt, resolution degrades to the
 * pure slug rule and the returned ref is flagged `degraded: true`. Stamping a
 * *metadata* field must never be the reason a session or worker fails to start,
 * so the failure is not propagated — but it is never swallowed silently: the
 * corruption is logged once (with its backup/evidence path) before degrading.
 *
 * This is a read path: it does NOT quarantine (rename) a corrupt file. The
 * rename happens only if a write ever reaches `getOrCreateWorkspace`, so a
 * plain resolve leaves the bad bytes in place for a human to inspect.
 */
export function resolveWorkspaceRef(wayangDir: string | null, rawPath: string): WorkspaceRef {
  const resolvedPath = normalizeWorkspacePath(rawPath);
  const fallbackSlug = workspaceSlugFromPath(resolvedPath);

  if (!wayangDir) {
    return { path: resolvedPath, slug: fallbackSlug, degraded: true };
  }

  try {
    const registered = findWorkspace(wayangDir, resolvedPath);
    if (registered) return { path: registered.path, slug: registered.slug };
    return getOrCreateWorkspace(wayangDir, resolvedPath);
  } catch (err) {
    const corruption = err instanceof WorkspaceRegistryCorruptionError ? err : undefined;
    const backupNote = corruption?.backupPath ? ` (backup path: ${corruption.backupPath})` : '';
    // Never a silent catch: surface the failure (and where the evidence lives)
    // so corruption is visible even though the caller still gets a usable slug.
    console.error(
      `[workspace-registry] resolveWorkspaceRef could not read the registry for ${resolvedPath}: ${
        (err as Error).message
      }${backupNote}; degrading to rule-based slug "${fallbackSlug}"`,
    );
    return { path: resolvedPath, slug: fallbackSlug, degraded: true };
  }
}

/** Look up a registered workspace without writing anything (read-only policy). */
export function findWorkspace(wayangDir: string, rawPath: string): WorkspaceEntry | undefined {
  const registry = readRegistry(wayangDir, 'read');
  const entry = registry.workspaces[normalizeWorkspacePath(rawPath)];
  return entry ? { ...entry } : undefined;
}

/** All registered workspaces, oldest first (stable for snapshots/UI lists). */
export function listWorkspaces(wayangDir: string): WorkspaceEntry[] {
  const registry = readRegistry(wayangDir, 'read');
  return Object.values(registry.workspaces)
    .map(entry => ({ ...entry }))
    .sort((a, b) => {
      if (a.firstSeenAt === b.firstSeenAt) return a.slug.localeCompare(b.slug);
      return a.firstSeenAt < b.firstSeenAt ? -1 : 1;
    });
}
