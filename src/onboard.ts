/**
 * Wayang — interactive onboard flow
 *
 * Runs before Ink render when no config file exists.
 * Uses prompts library for terminal interaction.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import prompts from 'prompts';
import type { WayangConfig, WorkerConfig } from './types/index';
import { validateConfig } from './types/index';

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
      initial: 10,
      min: 1,
      max: 100,
    },
  ]);

  return {
    type: 'claude-code',
    enable: true,
    emoji: answers.emoji || '\u{1F980}',
    description: 'Coding assistant powered by Claude Code — excels at writing, debugging, and refactoring code',
    capabilities: ['code', 'debug', 'refactor', 'git'],
    maxTurns: answers.maxTurns ?? 10,
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

  const config: WayangConfig = {
    providers: {
      default: {
        endpoint: answers.endpoint,
        apiKey: answers.apiKey,
        modelName: answers.modelName,
      },
    },
    controller: { provider: 'default' },
    worker: { provider: 'default', maxConcurrency: answers.maxConcurrency ?? 3 },
  };

  // Offer Claude Code worker setup
  const claudePath = detectClaudeCode();
  const workerConfig = await promptClaudeCodeWorker(!!claudePath);
  if (workerConfig) {
    config.workers = { 'claude-code': workerConfig };
  }

  return config;
}

/**
 * Load config from file, env vars, or interactive onboard.
 * Writes config to disk if newly created.
 */
export async function loadConfig(configPath: string): Promise<WayangConfig> {
  let config: WayangConfig;
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } else {
    // Try env vars first, fall back to interactive onboard
    const envKey = process.env.WAYANG_LLM_API_KEY || '';
    const envEndpoint = process.env.WAYANG_ENDPOINT || '';
    const envModel = process.env.WAYANG_MODEL || '';

    if (envKey && envEndpoint && envModel) {
      config = {
        providers: { default: { endpoint: envEndpoint, apiKey: envKey, modelName: envModel } },
        controller: { provider: 'default' },
        worker: { provider: 'default', maxConcurrency: 3 },
      };
    } else {
      config = await buildConfigInteractive();
    }

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  }
  fillApiKeys(config);

  const err = validateConfig(config);
  if (err) {
    console.error(`Error: ${err}`);
    console.error('Run `wayang` without arguments to configure.');
    process.exit(1);
  }

  return config;
}
