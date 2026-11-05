import fg from 'fast-glob';
import { z } from 'zod';
import { defineTool, safeExecute } from './common';
import { decideAccess, normalizePath } from '@/infra/permission/policy';
import { expandHome } from './permission-rules';

export function searchFilesTool(deps: { cwd?: string; userHome?: string }) {
  const workspace = deps.cwd ?? process.cwd();
  // When set, reads are gated by the shared access policy: the controller may
  // only read inside the user's home (the sensitive list wins). Left undefined
  // for the worker tool set, where the permission middleware applies the same
  // policy with the worker's own scope (task workspace / task allowedDirs /
  // config).
  const userHome = deps.userHome;

  return defineTool({
    description:
      'Search for files matching a glob pattern. Returns matching file paths relative to workspace. Reads are restricted to the home directory; sensitive locations (credentials, tool config) are blocked.',
    parameters: z.object({
      pattern: z
        .string()
        .describe('Glob pattern (e.g. "**/*.ts", "src/**/*.test.ts")'),
      path: z
        .string()
        .optional()
        .describe('Base directory for search (default: workspace root)'),
    }),
    execute: safeExecute('search_files', async ({ pattern, path }) => {
      // `~` / `$HOME` expand against the PROCESS home BEFORE normalization —
      // the same anchor the permission gate judges (`expandHome`) — so
      // `search_files(path: '~/x')` searches what a shell would call `~/x`,
      // not a literal `~` directory inside the workspace.
      const expandedPath = path !== undefined ? expandHome(path).path : undefined;
      // Canonicalize through the shared policy so symlinked ancestors are
      // resolved before the decision — a lexical prefix check would let a
      // symlink smuggle a sensitive path past the gate.
      const basePath = expandedPath
        ? normalizePath(expandedPath, { base: workspace })
        : normalizePath(workspace);

      if (userHome) {
        // The controller has no interactive approval channel, so `ask` is
        // treated as a refusal. A sensitive hit (`ask` for reads, `deny` under
        // `sensitiveMode: 'deny'`) and a plain "outside home" `ask` use
        // distinct wording so the two causes stay distinguishable in logs.
        const { decision, matchedEntry } = decideAccess({
          access: 'read',
          userHome: userHome,
          cwd: workspace,
          path: basePath,
        });
        // Echo the path the caller supplied, not the canonical target, so a
        // refusal never discloses where a symlink actually points.
        const requested = path ?? workspace;
        if (matchedEntry !== undefined || decision === 'deny') {
          return `[ERROR] search_files: refusing to search "${requested}" — the path is on the sensitive list (a protected location).`;
        }
        if (decision === 'ask') {
          return `[ERROR] search_files: refusing to search "${requested}" — the path is outside the home boundary (${userHome}). The controller can only read files under the home directory.`;
        }
      }

      const entries = await fg(pattern, {
        cwd: basePath,
        onlyFiles: true,
        ignore: ['node_modules', '.git'],
      });

      if (entries.length === 0) return 'No files matched the pattern';
      return entries.join('\n');
    }),
  });
}
