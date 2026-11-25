/**
 * Desktop utility entry — hosts the wayang server inside an Electron
 * UtilityProcess.
 *
 * The parent (main process) is structurally a message port; the adapter turns
 * it into the io stream pair that serverMain already knows how to consume.
 * Everything process-specific lives here; all logic stays in core.
 */

import { readFileSync } from 'node:fs';
import { validateConfig, type WayangConfig } from '@wayang-ai/protocol';
import { messagePortToStreams, type MessagePortLike } from '@wayang-ai/protocol/rpc/message-port';
import { serverMain } from '@wayang-ai/core/server/main';
import { CONFIG_OBJECT_ENV } from '../shared/config-env';
import { parseHostFlags } from './flags';

function fatal(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr?.write(`[wayang-desktop utility] fatal: ${message}\n`);
  process.exit(1);
}

/**
 * The config object, never a path (design 4.1: the host owns config loading
 * and core never reads files): from the main-process env handoff, or a
 * single read of `--config` for standalone manual runs — the utility-side
 * mirror of the CLI server-entry's standalone fallback.
 */
function resolveUtilityConfig(configPath: string): WayangConfig {
  const injected = process.env[CONFIG_OBJECT_ENV];
  if (injected !== undefined) {
    // The desktop main process already validated this object.
    return JSON.parse(injected) as WayangConfig;
  }
  const config = JSON.parse(readFileSync(configPath, 'utf-8')) as WayangConfig;
  const problem = validateConfig(config);
  if (problem) throw new Error(`Invalid config ${configPath}: ${problem}`);
  return config;
}

try {
  // Electron types this only when the electron module is in scope, which it is
  // not inside the utility bundle — reach for it structurally.
  const port = (process as unknown as { parentPort?: MessagePortLike }).parentPort;
  if (!port) throw new Error('process.parentPort is unavailable — must run inside a UtilityProcess');

  const flags = parseHostFlags(process.argv.slice(2));
  void serverMain(
    {
      config: resolveUtilityConfig(flags.config),
      dataDir: flags.dataDir,
      workspaceDir: flags.workspaceDir,
      session: flags.session,
      injectPreviousTasks: flags.injectPreviousTasks,
      logLevel: flags.logLevel,
    },
    messagePortToStreams(port),
  ).catch(fatal);
} catch (err) {
  fatal(err);
}
