/**
 * Wayang — interactive session selection
 *
 * Runs before Ink render for --resume without session ID.
 * Uses prompts library for terminal interaction.
 */

import prompts from 'prompts';
import { listSessions, getSession } from './infra/session-helpers';
import type { SessionMeta } from './infra/session-helpers';

function formatSessionChoice(meta: SessionMeta, showWorkspace: boolean): string {
  const date = new Date(meta.createdAt).toLocaleString();
  const label = meta.firstInput ? `"${meta.firstInput}"` : '(no input yet)';
  const ws = showWorkspace ? `  [${meta.workspace}]` : '';
  return `${meta.sessionId}  ${date}  ${label}${ws}`;
}

/**
 * Show an interactive session picker.
 *
 * @param homeDir  Wayang home directory (contains sessions/)
 * @param workspaceDir  Current workspace directory (for filtering)
 * @param showAll  If true, show sessions from all workspaces
 * @returns Selected session info, or exits process on cancel/empty
 */
export async function selectSessionInteractive(
  homeDir: string,
  workspaceDir: string,
  showAll: boolean,
): Promise<{ sessionId: string; sessionDir: string; meta: SessionMeta }> {
  let sessions = listSessions(homeDir);

  if (!showAll) {
    sessions = sessions.filter(m => m.workspace === workspaceDir);
  }

  if (sessions.length === 0) {
    const scope = showAll ? 'any workspace' : `workspace ${workspaceDir}`;
    console.error(`Error: No sessions found for ${scope}. Start a new session first.`);
    process.exit(1);
  }

  const { selected } = await prompts({
    type: 'select',
    name: 'selected',
    message: 'Select a session to resume',
    choices: sessions.map(m => ({
      title: formatSessionChoice(m, showAll),
      value: m.sessionId,
    })),
  });

  if (!selected) {
    // User cancelled (Ctrl+C)
    process.exit(0);
  }

  const result = getSession(homeDir, selected);
  if (!result) {
    console.error(`Error: Session "${selected}" not found.`);
    process.exit(1);
  }

  // Workspace mismatch warning
  if (result.meta.workspace !== workspaceDir) {
    const { confirm } = await prompts({
      type: 'confirm',
      name: 'confirm',
      message: `Session workspace is ${result.meta.workspace}, current dir is ${workspaceDir}. Switch?`,
      initial: true,
    });
    if (!confirm) {
      process.exit(0);
    }
  }

  return result;
}
