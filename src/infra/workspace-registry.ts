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
 * Corruption policy: a malformed registry is NEVER silently reset. The bad file
 * is renamed to `<file>.corrupt` (preserving evidence) and an error is thrown,
 * so the caller decides whether to start over.
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
 * Move a corrupt registry aside so it is never overwritten, then return the
 * error to throw. The backup keeps the original bytes for post-mortem.
 */
function quarantineCorruptFile(filePath: string, detail: string): Error {
  const primaryBackup = `${filePath}.corrupt`;
  let backupPath = primaryBackup;
  if (fs.existsSync(backupPath)) {
    // Do not destroy an earlier backup; make this one distinguishable.
    backupPath = `${filePath}.${Date.now()}.corrupt`;
  }
  try {
    fs.renameSync(filePath, backupPath);
  } catch (renameErr) {
    throw new Error(
      `Workspace registry at ${filePath} is corrupt (${detail}) and could not be moved to ${backupPath}: ${
        (renameErr as Error).message
      }`,
    );
  }
  return new Error(`Workspace registry at ${filePath} is corrupt (${detail}); original moved to ${backupPath}`);
}

function parseRegistry(filePath: string, raw: string): WorkspaceRegistryFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw quarantineCorruptFile(filePath, `invalid JSON: ${(err as Error).message}`);
  }

  if (!isPlainObject(parsed)) {
    throw quarantineCorruptFile(filePath, 'top-level value is not an object');
  }
  if (parsed.version !== REGISTRY_VERSION) {
    throw quarantineCorruptFile(filePath, `unsupported version: ${String(parsed.version)}`);
  }
  if (!isPlainObject(parsed.workspaces)) {
    throw quarantineCorruptFile(filePath, '"workspaces" is not an object');
  }

  const workspaces: Record<string, WorkspaceEntry> = {};
  for (const [key, value] of Object.entries(parsed.workspaces)) {
    if (
      !isPlainObject(value) ||
      typeof value.slug !== 'string' ||
      value.slug.length === 0 ||
      typeof value.path !== 'string'
    ) {
      throw quarantineCorruptFile(filePath, `malformed entry for ${JSON.stringify(key)}`);
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
function readRegistry(wayangDir: string): WorkspaceRegistryFile {
  const filePath = registryFilePath(wayangDir);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyRegistry();
    throw err;
  }
  return parseRegistry(filePath, raw);
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
  const registry = readRegistry(wayangDir);
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

/** Look up a registered workspace without writing anything. */
export function findWorkspace(wayangDir: string, rawPath: string): WorkspaceEntry | undefined {
  const registry = readRegistry(wayangDir);
  const entry = registry.workspaces[normalizeWorkspacePath(rawPath)];
  return entry ? { ...entry } : undefined;
}

/** All registered workspaces, oldest first (stable for snapshots/UI lists). */
export function listWorkspaces(wayangDir: string): WorkspaceEntry[] {
  const registry = readRegistry(wayangDir);
  return Object.values(registry.workspaces)
    .map(entry => ({ ...entry }))
    .sort((a, b) => {
      if (a.firstSeenAt === b.firstSeenAt) return a.slug.localeCompare(b.slug);
      return a.firstSeenAt < b.firstSeenAt ? -1 : 1;
    });
}
