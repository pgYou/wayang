/**
 * Wayang CLI — config loading + interactive onboard flow.
 *
 * Moved from `packages/core/src/onboard.ts` (monorepo-design 4.1 改造一):
 * file reading, env-var fallback and terminal prompts are host concerns —
 * the CLI owns locating the config file, reading/writing the JSON and
 * merging environment variables, and produces a validated `WayangConfig`
 * object. core receives the object and never senses where it came from.
 *
 * Runs before Ink render when no config file exists. Uses the prompts
 * library for terminal interaction.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import prompts from 'prompts';
import type { WayangConfig, WorkerConfig } from '@wayang-ai/protocol';
import { validateConfig, collectWorkerWarnings, collectProviderWarnings, normalizeWorkerTypes } from '@wayang-ai/protocol';
import { warnDeprecatedPermissionKeys } from '@wayang-ai/core/infra/permission/permission-config';

/** Fill missing apiKeys from environment variables. */
function fillApiKeys(config: WayangConfig): void {
  const envKey = process.env.WAYANG_LLM_API_KEY || '';
  for (const provider of Object.values(config.providers)) {
    if (!provider.apiKey && envKey) {
      provider.apiKey = envKey;
    }
  }
  // Optional tool API keys
  config.tavilyApiKey = config.tavilyApiKey || process.env.WAYANG_TAVILY_API_KEY || undefined;
}

/** Values onboard collected for the default model. */
export interface OnboardModelValues {
  endpoint: string;
  apiKey: string;
  modelName: string;
  /** Present when the user / env declared one (invalid values are left for validateConfig). */
  contextWindowTokens?: number;
  maxConcurrency: number;
}

/**
 * Build the config onboard writes (issue #88, new shape): a provider with
 * `type` + `baseURL` (no deprecated `modelName` / window fields), a
 * `models.default` entry carrying the model name and window, and
 * `controller.model` / `worker.model` referencing that entry. A new user must
 * not start with the four deprecation warnings the legacy shape produced.
 */
export function buildOnboardConfig(values: OnboardModelValues): WayangConfig {
  return {
    providers: {
      default: {
        type: 'openai-compatible',
        baseURL: values.endpoint,
        apiKey: values.apiKey,
      },
    },
    models: {
      default: {
        provider: 'default',
        name: values.modelName,
        ...(values.contextWindowTokens !== undefined && { contextWindowTokens: values.contextWindowTokens }),
      },
    },
    controller: { model: 'default' },
    worker: { model: 'default', maxConcurrency: values.maxConcurrency },
  };
}

/** Detect whether Claude Code CLI is installed. */
function detectClaudeCode(): string | null {
  try {
    const result = childProcess.execSync('which claude 2>/dev/null', { encoding: 'utf-8' }).trim();
    return result || null;
  } catch {
    return null;
  }
}

/** Prompt for Claude Code worker configuration. Skippable. */
async function promptClaudeCodeWorker(claudeDetected: boolean): Promise<WorkerConfig | undefined> {
  const hint = claudeDetected
    ? 'Claude Code detected. Configure as a worker?'
    : 'Configure Claude Code worker? (install Claude Code CLI first)';

  const { enable } = await prompts({
    type: 'confirm',
    name: 'enable',
    message: hint,
    initial: claudeDetected,
  });

  if (!enable) return undefined;

  const answers = await prompts([
    {
      type: 'text',
      name: 'emoji',
      message: 'Worker emoji',
      initial: '\u{1F980}',
    },
    {
      type: 'text',
      name: 'cliPath',
      message: 'Path to Claude Code CLI (leave empty for auto-detect)',
      initial: '',
    },
    {
      type: 'number',
      name: 'maxTurns',
      message: 'Max turns per task',
      initial: 1000,
      min: 1,
      max: 10_000,
    },
  ]);

  return {
    type: 'claude-code',
    enable: true,
    emoji: answers.emoji || '\u{1F980}',
    description: 'Coding assistant powered by Claude Code — excels at writing, debugging, and refactoring code',
    capabilities: ['code', 'debug', 'refactor', 'git'],
    maxTurns: answers.maxTurns ?? 1000,
    cliPath: answers.cliPath || undefined,
  };
}

/** Interactive onboard — runs when no config file exists. */
async function buildConfigInteractive(): Promise<WayangConfig> {
  console.log('\n  Welcome to paly with Wayang! Let\'s configure your setup.\n');

  const answers = await prompts([
    {
      type: 'text',
      name: 'endpoint',
      message: 'API endpoint (OpenAI-compatible base URL, e.g. https://api.openai.com/v1)',
    },
    {
      type: 'text',
      name: 'apiKey',
      message: 'API key',
    },
    {
      type: 'text',
      name: 'modelName',
      message: 'Model name',
    },
    {
      type: 'number',
      name: 'contextWindowTokens',
      message: 'Model context window in tokens (input budget, not max output; compaction starts at 60%)',
      initial: 256_000,
      min: 1_000,
    },
    {
      type: 'number',
      name: 'maxConcurrency',
      message: 'Max concurrent workers',
      initial: 3,
      min: 1,
      max: 10,
    },
  ]);

  if (!answers.apiKey) {
    console.error('Error: API key is required.');
    process.exit(1);
  }

  const config: WayangConfig = buildOnboardConfig({
    endpoint: answers.endpoint,
    apiKey: answers.apiKey,
    modelName: answers.modelName,
    ...(answers.contextWindowTokens > 0 && { contextWindowTokens: answers.contextWindowTokens }),
    maxConcurrency: answers.maxConcurrency ?? 3,
  });

  // Offer Claude Code worker setup
  const claudePath = detectClaudeCode();
  const workerConfig = await promptClaudeCodeWorker(!!claudePath);
  if (workerConfig) {
    config.workers = { 'claude-code': workerConfig };
  }

  // ACP workers are configured by editing the config file, not onboarded —
  // one pointer so the option is discoverable (05 §7). Default generated
  // content is unchanged.
  console.log('  Tip: ACP workers (acp / codebuddy / opencode) can be added later under "workers" in the config file.');

  return config;
}

export interface LoadConfigOptions {
  /** Server mode: never prompt and never write — missing config/env is a hard error. */
  nonInteractive?: boolean;
}

/**
 * Load config from file, env vars, or interactive onboard.
 * Writes config to disk if newly created.
 */
export async function loadConfig(configPath: string, options: LoadConfigOptions = {}): Promise<WayangConfig> {
  const { nonInteractive = false } = options;
  let config: WayangConfig;
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (err) {
      if (nonInteractive) throw new Error(`Invalid config JSON at ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  } else {
    // Try env vars first, fall back to interactive onboard
    const envKey = process.env.WAYANG_LLM_API_KEY || '';
    const envEndpoint = process.env.WAYANG_ENDPOINT || '';
    const envModel = process.env.WAYANG_MODEL || '';

    if (envKey && envEndpoint && envModel) {
      // Optional — invalid values are reported by validateConfig below.
      const envWindow = process.env.WAYANG_CONTEXT_WINDOW_TOKENS;
      config = buildOnboardConfig({
        endpoint: envEndpoint,
        apiKey: envKey,
        modelName: envModel,
        ...(envWindow && { contextWindowTokens: Number(envWindow) }),
        maxConcurrency: 3,
      });
    } else if (nonInteractive) {
      throw new Error(`Config not found at ${configPath} and WAYANG_* env vars are incomplete. Run \`wayang\` once to configure.`);
    } else {
      config = await buildConfigInteractive();
    }

    if (!nonInteractive) {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    }
  }
  fillApiKeys(config);

  // Worker-type compatibility: 'codebuddy-acp' / 'opencode-acp' are the
  // pre-generic-ACP spellings. Rewritten once, here at the config-parse exit,
  // so validation and every consumer only see the canonical names.
  normalizeWorkerTypes(config, (message) => console.warn(`Warning: ${message}`));

  // Config-key compatibility: `permission.deniedDirs` is a deprecated alias of
  // `permission.sensitiveDirs`. It is still honoured (see
  // `mergeSensitiveDirs`), and a config that uses it gets one pointer to the
  // new key per process — warn only when the legacy key is really populated.
  warnDeprecatedPermissionKeys(config.permission, (message) => console.warn(`Warning: ${message}`));
  // Config-key compatibility: `workerRunTimeoutMs` is deprecated — v0.9.7
  // removed worker run wall-time limits. A config still carrying the key is
  // not an error: it is silently ignored, with one warning.
  if ((config as unknown as Record<string, unknown>).workerRunTimeoutMs !== undefined) {
    console.warn(
      'Warning: workerRunTimeoutMs is deprecated and ignored — worker run wall-time limits were removed; the key can be deleted from the config.',
    );
  }
  // issue #77: an active workspace-boundary extension must be visible, not
  // silent — one line at startup naming the configured roots. Each workspace
  // admitted through them is additionally audited on the session log.
  const extraWorkspaceRoots = config.permission?.extraWorkspaceRoots;
  if (Array.isArray(extraWorkspaceRoots) && extraWorkspaceRoots.length > 0) {
    console.warn(
      `Warning: permission.extraWorkspaceRoots is active (${extraWorkspaceRoots.join(', ')}) — add_task workspaces under these roots are allowed beyond the home boundary; every such admission is audited on the session log.`,
    );
  }
  // `*-acp` rows accept `maxTurns`/`cliPath` for backwards compatibility, but
  // neither has any effect there (05 §4) — surface that once at load instead
  // of failing configs that used to work.
  for (const warning of collectWorkerWarnings(config)) {
    console.warn(`Warning: ${warning}`);
  }
  // issue #88: deprecated provider model fields, and a provider `modelName`
  // that lost to a `model` reference, are surfaced once at load. The
  // validation layer only returns the strings — it never prints.
  for (const warning of collectProviderWarnings(config)) {
    console.warn(`Warning: ${warning}`);
  }

  const err = validateConfig(config);
  if (err) {
    if (nonInteractive) throw new Error(`Invalid config: ${err}`);
    console.error(`Error: ${err}`);
    console.error('Run `wayang` without arguments to configure.');
    process.exit(1);
  }

  return config;
}
