import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { ConfigStore } from '../config-store';
import { makeEnvelope, parseConfigEnvelope, CONFIG_SCHEMA_VERSION } from '../../shared/config-envelope';
import type { WayangConfig } from '@wayang-ai/protocol';

// The canonical shape (models + model references) — the only form the desktop stores.
const validConfig: WayangConfig = {
  providers: {
    default: { baseURL: 'http://localhost:1234/v1', apiKey: 'test-key' },
  },
  models: {
    default: { provider: 'default', name: 'test-model' },
  },
  controller: { model: 'default' },
  worker: { model: 'default', maxConcurrency: 3 },
};

/** A pre-#88 CLI config: endpoint alias, provider implicit model, provider-key bindings. */
const legacyConfig = {
  providers: {
    ds: { endpoint: 'https://api.deepseek.com', apiKey: 'k1', modelName: 'deepseek-flash' },
    hub: { endpoint: 'https://hub/v3', apiKey: 'k2', modelName: 'ds-v4', contextWindowTokens: 1_000_000 },
  },
  controller: { provider: 'hub' },
  worker: { provider: 'hub', maxConcurrency: 3 },
} as unknown as WayangConfig;

/** What the import must hand back: models entries + model references, no legacy key. */
const translatedConfig: WayangConfig = {
  providers: {
    ds: { baseURL: 'https://api.deepseek.com', apiKey: 'k1' },
    hub: { baseURL: 'https://hub/v3', apiKey: 'k2' },
  },
  models: {
    ds: { provider: 'ds', name: 'deepseek-flash' },
    hub: { provider: 'hub', name: 'ds-v4', contextWindowTokens: 1_000_000 },
  },
  controller: { model: 'hub' },
  worker: { model: 'hub', maxConcurrency: 3 },
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

describe('ConfigStore.importFrom (explicit CLI import, 决策九 域三落地)', () => {
  it('reads and validates the CLI config read-only — never writes the envelope or the CLI file', async () => {
    const before = JSON.stringify(validConfig);
    await writeFile(legacyPath, before, 'utf-8');
    const store = new ConfigStore(configPath);
    const imported = await store.importFrom(legacyPath);
    expect(imported).toEqual(validConfig);
    // Import is read-only in BOTH directions: no envelope is seeded and the
    // CLI file is untouched (the confirm page decides whether to save).
    expect(existsSync(configPath)).toBe(false);
    expect(readFileSync(legacyPath, 'utf-8')).toBe(before);
  });

  it('rejects when the CLI config file is missing (no silent fallback)', async () => {
    const store = new ConfigStore(configPath);
    await expect(store.importFrom(legacyPath)).rejects.toThrow(/无法读取 CLI 配置/);
    expect(existsSync(configPath)).toBe(false);
  });

  it('rejects when the CLI config is invalid JSON or fails validateConfig', async () => {
    await writeFile(legacyPath, '{not json', 'utf-8');
    await expect(new ConfigStore(configPath).importFrom(legacyPath)).rejects.toThrow(/不是有效 JSON/);
    await writeFile(legacyPath, JSON.stringify({ providers: {} }), 'utf-8');
    await expect(new ConfigStore(configPath).importFrom(legacyPath)).rejects.toThrow(/invalid CLI config/);
    expect(existsSync(configPath)).toBe(false);
  });
});

describe('旧版 CLI 配置：导入时翻译一次，桌面存储不做兼容', () => {
  it('importFrom 交回规范格式（models 条目 + model 引用，无任何废弃键）；CLI 文件只读未动', async () => {
    await writeFile(legacyPath, JSON.stringify(legacyConfig), 'utf-8');
    const imported = await new ConfigStore(configPath).importFrom(legacyPath);
    // 翻译逻辑在 protocol normalizeConfig（自有单测）；这里钉的是接线：
    // 导入是唯一翻译点，落进桌面的已经是规范格式。
    expect(imported).toStrictEqual(translatedConfig);
    expect(JSON.parse(readFileSync(legacyPath, 'utf-8'))).toStrictEqual(legacyConfig);
  });

  it('load 拒绝带旧版键的 envelope——报错走重新 onboard，而不是静默兼容', async () => {
    await writeFile(configPath, JSON.stringify(makeEnvelope(legacyConfig)), 'utf-8');
    await expect(new ConfigStore(configPath).load()).rejects.toThrow(/含旧版配置键 providers\.ds\.endpoint、providers\.ds\.modelName/);

    // 只剩旧的 provider 键绑定同样被拒。
    const legacyBinding = {
      ...validConfig,
      controller: { provider: 'default' },
      worker: { provider: 'default', maxConcurrency: 3 },
    } as unknown as WayangConfig;
    await writeFile(configPath, JSON.stringify(makeEnvelope(legacyBinding)), 'utf-8');
    await expect(new ConfigStore(configPath).load()).rejects.toThrow(/含旧版配置键 controller\.provider、worker\.provider/);
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
