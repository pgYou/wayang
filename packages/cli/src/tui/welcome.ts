import pkg from '@/../package.json'
import { formatWorkspaceSummary } from '@/tui/utils/workspace-display'

export const logo = `
  ██     ██  █████  ██    ██  █████  ███    ██  ██████  
  ██     ██ ██   ██  ██  ██  ██   ██ ████   ██ ██       
  ██  █  ██ ███████   ████   ███████ ██ ██  ██ ██   ███ 
  ██ ███ ██ ██   ██    ██    ██   ██ ██  ██ ██ ██    ██ 
   ███ ███  ██   ██    ██    ██   ██ ██   ████  ██████                                                                                         
`
export const logo3d = `
  ██╗    ██╗ █████╗ ██╗   ██╗ █████╗ ███╗   ██╗ ██████╗ 
  ██║    ██║██╔══██╗╚██╗ ██╔╝██╔══██╗████╗  ██║██╔════╝ 
  ██║ █╗ ██║███████║ ╚████╔╝ ███████║██╔██╗ ██║██║  ███╗
  ██║███╗██║██╔══██║  ╚██╔╝  ██╔══██║██║╚██╗██║██║   ██║
  ╚███╔███╔╝██║  ██║   ██║   ██║  ██║██║ ╚████║╚██████╔╝
   ╚══╝╚══╝ ╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═══╝ ╚═════╝                                                                                             
`



const pkgVersion: string = pkg.version; // default version

/**
 * Workspace label for the session banner. A single-workspace session keeps
 * showing the full path it was started in; a multi-workspace session uses the
 * shared "first + N" expression (see `formatWorkspaceSummary`) rather than a
 * TUI-only convention.
 */
export function formatSessionWorkspaceLabel(
  workspace: string,
  workspaces?: ReadonlyArray<{ path?: string | null; slug?: string | null }> | null,
): string {
  if (!workspaces || workspaces.length <= 1) return workspace;
  return formatWorkspaceSummary(workspaces) ?? workspace;
}

export function writeWelcome(
  workspace: string,
  workspaces?: ReadonlyArray<{ path?: string | null; slug?: string | null }> | null,
): void {

  const GREEN = '\x1B[32m';
  const BOLD = '\x1B[1m';
  const DIM = '\x1B[2m';
  const RESET = '\x1B[0m';

  process.stdout.write('\n');

  process.stdout.write(GREEN + logo3d + RESET);
  process.stdout.write('\n');
  process.stdout.write(`  Welcome to play with ${BOLD}Wayang${RESET}\n`);
  process.stdout.write(`  ${DIM}${pkgVersion} · ${formatSessionWorkspaceLabel(workspace, workspaces)}${RESET}\n`);
  process.stdout.write('\n');
}