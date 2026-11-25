import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { ConfigStore } from '../config-store';
import { makeEnvelope, parseConfigEnvelope, CONFIG_SCHEMA_VERSION } from '../../shared/config-envelope';
import type { WayangConfig } from '@wayang-ai/protocol';

const validConfig: WayangConfig = {
  providers: {
    default: { endpoint: 'http://localhost:1234/v1', apiKey: 'test-key', modelName: 'test-model' },
  },
  controller: { provider: 'default' },
  worker: { provider: 'default', maxConcurrency: 3 },
};

let dir: string;
let configPath: string;
let legacyPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wayang-config-store-'));
  configPath = join(dir, 'config.json');
  legacyPath = join(dir, '.wayang.config.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ConfigStore envelope roundtrip', () => {
  it('save → load roundtrips the envelope with schemaVersion 1 and no temp residue', async () => {
    const store = new ConfigStore(configPath);
    await store.save(makeEnvelope(validConfig, { theme: 'light' }));
    expect(existsSync(`${configPath}.tmp`)).toBe(false);
    const raw = readFileSync(configPath, 'utf-8');
    expect(JSON.parse(raw).schemaVersion).toBe(CONFIG_SCHEMA_VERSION);
    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.wayangConfig).toEqual(validConfig);
    expect(loaded!.desktop).toEqual({ theme: 'light' });
  });

  it('load returns null when the envelope does not exist yet', async () => {
    const store = new ConfigStore(configPath);
    expect(await store.load()).toBeNull();
  });

  it('rejects a corrupt file (bad JSON) instead of returning a value', async () => {
    await writeFile(configPath, '{not json', 'utf-8');
    const store = new ConfigStore(configPath);
    await expect(store.load()).rejects.toThrow(/not valid JSON/);
  });

  it('rejects an envelope whose wayangConfig fails validateConfig', async () => {
    const broken = makeEnvelope(validConfig);
    broken.wayangConfig = { providers: {}, controller: { provider: 'default' }, worker: { provider: 'default' } } as unknown as WayangConfig;
    await writeFile(configPath, JSON.stringify(broken), 'utf-8');
    const store = new ConfigStore(configPath);
    await expect(store.load()).rejects.toThrow(/invalid wayangConfig/);
  });

  it('rejects unknown schema versions and non-envelope payloads', async () => {
    await writeFile(configPath, JSON.stringify({ schemaVersion: 2, wayangConfig: validConfig, desktop: {} }), 'utf-8');
    await expect(new ConfigStore(configPath).load()).rejects.toThrow(/unsupported config envelope schemaVersion 2/);
    await writeFile(configPath, JSON.stringify(validConfig), 'utf-8');
    await expect(new ConfigStore(configPath).load()).rejects.toThrow(/not a desktop envelope/);
  });
});

describe('ConfigStore atomic write', () => {
  it('a failed temp write leaves the previous file intact and no residue', async () => {
    const store = new ConfigStore(configPath);
    await store.save(makeEnvelope(validConfig));
    const before = readFileSync(configPath, 'utf-8');
    // Block the temp slot with a directory: writeFile fails (EISDIR), the
    // rename never happens, the old content must survive.
    mkdirSync(`${configPath}.tmp`);
    await expect(store.save(makeEnvelope(validConfig, { theme: 'x' }))).rejects.toThrow();
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
    rmSync(`${configPath}.tmp`, { recursive: true });
    // After the blocker is gone, saving works again and leaves no residue.
    await store.save(makeEnvelope(validConfig, { theme: 'x' }));
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).desktop).toEqual({ theme: 'x' });
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('ConfigStore.loadOrImport (transitional implicit CLI import)', () => {
  it('seeds the envelope once from the CLI config, then reads the envelope only', async () => {
    await writeFile(legacyPath, JSON.stringify(validConfig), 'utf-8');
    const store = new ConfigStore(configPath);
    const first = await store.loadOrImport(legacyPath);
    expect(first).toEqual(validConfig);
    expect(existsSync(configPath)).toBe(true);
    // The envelope is now the only source: removing the CLI file changes
    // nothing (runtime never touches it again).
    rmSync(legacyPath);
    const second = await store.loadOrImport(legacyPath);
    expect(second).toEqual(validConfig);
  });

  it('fails with import_failed when neither envelope nor CLI config exists', async () => {
    const store = new ConfigStore(configPath);
    await expect(store.loadOrImport(legacyPath)).rejects.toThrow(/no CLI config to import/);
  });

  it('fails with import_failed when the CLI config is invalid', async () => {
    await writeFile(legacyPath, JSON.stringify({ providers: {} }), 'utf-8');
    const store = new ConfigStore(configPath);
    await expect(store.loadOrImport(legacyPath)).rejects.toThrow(/invalid CLI config/);
    expect(existsSync(configPath)).toBe(false);
  });
});

describe('parseConfigEnvelope', () => {
  it('validates the embedded config via protocol validateConfig', () => {
    const envelope = makeEnvelope(validConfig);
    expect(parseConfigEnvelope(JSON.stringify(envelope)).wayangConfig).toEqual(validConfig);
    const corrupted = JSON.parse(JSON.stringify(envelope)) as { wayangConfig: WayangConfig };
    delete (corrupted.wayangConfig as { controller?: unknown }).controller;
    expect(() => parseConfigEnvelope(JSON.stringify(corrupted))).toThrow(/invalid wayangConfig/);
  });
});
