/**
 * Desktop-native config store (desktop-app-design §2.11, 决策九).
 *
 * Single-file envelope persistence at `<userData>/config.json` (path sourced
 * from the platform config module — 决策十). The envelope keeps the core
 * config as protocol's `WayangConfig` and reserves a `desktop` section for
 * future host preferences. Writes are atomic (temp file + rename) so a crash
 * mid-write can never leave a half-written config behind.
 *
 * transitional (决策九, 域三 replaces this): while the envelope file does not
 * exist, `loadOrImport` seeds it ONCE from the CLI config
 * (`~/.wayang.config.json`, read-only — the desktop never writes it) by
 * validating and re-writing the config into the envelope. Once the welcome
 * page / explicit import UI lands, the implicit fallback is removed and
 * importing becomes an explicit action. Beyond that one-time import the
 * store never touches CLI files.
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { WayangConfig } from '@wayang-ai/protocol';
import { makeEnvelope, parseConfigEnvelope, validateOrReject, type ConfigEnvelope } from '../shared/config-envelope';

export { CONFIG_SCHEMA_VERSION } from '../shared/config-envelope';
export type { ConfigEnvelope } from '../shared/config-envelope';

/** Error kinds the cold-boot path distinguishes later (welcome page, 域三). */
export class ConfigStoreError extends Error {
  constructor(
    /** `import_failed` — the CLI import source was missing or invalid. */
    readonly code: 'import_failed',
    message: string,
  ) {
    super(message);
    this.name = 'ConfigStoreError';
  }
}

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
   * Effective wayang config for server boot.
   *
   * transitional (决策九): envelope missing → one-time implicit import from
   * the CLI config at `legacyConfigPath` (read → validate → write envelope →
   * use). Remove when the explicit import action (域三 welcome page) lands.
   */
  async loadOrImport(legacyConfigPath: string): Promise<WayangConfig> {
    const envelope = await this.load();
    if (envelope) return envelope.wayangConfig;

    let raw: string;
    try {
      raw = await readFile(legacyConfigPath, 'utf-8');
    } catch (err) {
      throw new ConfigStoreError(
        'import_failed',
        `no desktop config at ${this.configPath} and no CLI config to import at ${legacyConfigPath} (${(err as Error).message})`,
      );
    }
    let imported: WayangConfig;
    try {
      imported = JSON.parse(raw) as WayangConfig;
    } catch (err) {
      throw new ConfigStoreError('import_failed', `CLI config ${legacyConfigPath} is not valid JSON: ${(err as Error).message}`);
    }
    try {
      validateOrReject(imported, `CLI config ${legacyConfigPath}`);
    } catch (err) {
      throw new ConfigStoreError('import_failed', (err as Error).message);
    }
    await this.save(makeEnvelope(imported));
    return imported;
  }
}
