/**
 * Desktop-native config store (desktop-app-design §2.11, 决策九).
 *
 * Single-file envelope persistence at `<userData>/config.json` (path sourced
 * from the platform config module — 决策十). The envelope keeps the core
 * config as protocol's `WayangConfig` and reserves a `desktop` section for
 * host preferences. Writes are atomic (temp file + rename) so a crash
 * mid-write can never leave a half-written config behind.
 *
 * No implicit CLI fallback: a missing/invalid envelope means the welcome page
 * (域三 决策九落地) — importing the CLI config is an EXPLICIT user action
 * (`importFrom`, read-only, never writes the CLI file). Beyond that one
 * explicit import this store never touches CLI files.
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { WayangConfig } from '@wayang-ai/protocol';
import { parseConfigEnvelope, validateOrReject, type ConfigEnvelope } from '../shared/config-envelope';

export { CONFIG_SCHEMA_VERSION } from '../shared/config-envelope';
export type { ConfigEnvelope } from '../shared/config-envelope';

export class ConfigStore {
  /** @param configPath full path of the envelope file (`<userData>/config.json`). */
  constructor(readonly configPath: string) {}

  private get tmpPath(): string {
    return `${this.configPath}.tmp`;
  }

  /** Read and validate the envelope; null when the file does not exist yet. */
  async load(): Promise<ConfigEnvelope | null> {
    let raw: string;
    try {
      raw = await readFile(this.configPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    return parseConfigEnvelope(raw);
  }

  /** Atomically persist an envelope (temp file + rename, single file). */
  async save(envelope: ConfigEnvelope): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true });
    const raw = `${JSON.stringify(envelope, null, 2)}\n`;
    // Atomic single-file semantics: write the sibling temp file fully, then
    // rename over the target — readers observe either the old or the new
    // content, never a partial write.
    try {
      await writeFile(this.tmpPath, raw, 'utf-8');
      await rename(this.tmpPath, this.configPath);
    } catch (err) {
      // Leave no temp residue behind on failure; the previous file (if any)
      // stays untouched.
      await unlink(this.tmpPath).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Explicit CLI-config import (§2.11「导入 CLI 配置」, 决策九): read the
   * given file (the legacy `~/.wayang.config.json`, read-only), validate it
   * with the shared protocol validator and return the config — the caller
   * decides whether to write it into the envelope (the confirm page). This
   * is the ONLY touch of the CLI config domain; the file is never written.
   */
  async importFrom(legacyConfigPath: string): Promise<WayangConfig> {
    let raw: string;
    try {
      raw = await readFile(legacyConfigPath, 'utf-8');
    } catch (err) {
      throw new Error(`无法读取 CLI 配置 ${legacyConfigPath}（${(err as Error).message}）`);
    }
    let imported: WayangConfig;
    try {
      imported = JSON.parse(raw) as WayangConfig;
    } catch (err) {
      throw new Error(`CLI 配置 ${legacyConfigPath} 不是有效 JSON：${(err as Error).message}`);
    }
    validateOrReject(imported, `CLI config ${legacyConfigPath}`);
    return imported;
  }
}
