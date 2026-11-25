/**
 * MCP bridge socket directory = the INJECTED cacheDir (design 4.2 改造二).
 *
 * Contract under test:
 * - `mcpSocketPathFor` derives the socket path from the cacheDir argument
 *   only — the session dir is not consulted anywhere in the transport;
 * - the CLI default (cacheDir = the session dir) reproduces the 0.9.9
 *   physical layout `<sessionDir>/.mcp/acp-mcp-<workerId>-<suffix>.sock`;
 * - a custom injected cacheDir moves the socket dir (desktop premise) and
 *   the 0700 `.mcp` subdir is still dedicated per run.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { mcpSocketPathFor } from '@/services/agents/acp/mcp-transport';

describe('mcpSocketPathFor — cacheDir-based derivation', () => {
  it('derives the socket path from the injected cacheDir', () => {
    expect(mcpSocketPathFor('/var/cache/wayang', 'w-7', 'deadbeef')).toBe(
      join('/var/cache/wayang', '.mcp', 'acp-mcp-w-7-deadbeef.sock'),
    );
  });

  it('CLI parity: cacheDir = the session dir reproduces the 0.9.9 layout', () => {
    const sessionDir = '/home/u/.wayang/sessions/20261124-000000-abcd';
    expect(mcpSocketPathFor(sessionDir, 'aw-1', '0123456789ab')).toBe(
      join(sessionDir, '.mcp', 'acp-mcp-aw-1-0123456789ab.sock'),
    );
  });

  it('different cacheDirs never collide on the same worker/suffix pair', () => {
    const a = mcpSocketPathFor('/cache/a', 'w-1', 's1');
    const b = mcpSocketPathFor('/cache/b', 'w-1', 's1');
    expect(a).not.toBe(b);
    expect(a.startsWith(join('/cache/a', '.mcp'))).toBe(true);
    expect(b.startsWith(join('/cache/b', '.mcp'))).toBe(true);
  });
});
