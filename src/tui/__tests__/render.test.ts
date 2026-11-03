import { describe, it, expect, vi } from 'vitest';

// Partial mock: every export stays real (app.tsx imports Box/Text/useApp/
// useInput from 'ink' at module load) — only render itself is replaced, so
// the options render.ts passes can be asserted without mounting a TUI.
vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    render: vi.fn(() => ({ waitUntilExit: () => Promise.resolve() })),
  };
});

// The welcome banner writes to the real stdout; not what this file tests.
vi.mock('@/tui/welcome', () => ({ writeWelcome: vi.fn() }));

import { render } from 'ink';
import type { ReactElement } from 'react';
import { renderInkUI } from '@/tui/render';
import { App } from '@/tui/app';
import type { RemoteSupervisor } from '@/client/remote-supervisor';

const supervisor = { ctx: { workspaceDir: '/tmp/wayang-test' } } as unknown as RemoteSupervisor;

describe('renderInkUI render options', () => {
  it('renders the App with exitOnCtrlC: false — Ctrl+C belongs to AppContent', async () => {
    // Swallow the clear-screen sequence renderInkUI writes before mounting.
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await renderInkUI(supervisor);
    } finally {
      stdoutSpy.mockRestore();
    }

    expect(render).toHaveBeenCalledTimes(1);
    const [nodeArg, options] = vi.mocked(render).mock.calls[0];
    // render()'s signature takes ReactNode; renderInkUI always passes an element.
    const node = nodeArg as ReactElement;
    // The mounted tree is the App wired to the supervisor...
    expect(node.type).toBe(App);
    expect(node.props).toMatchObject({ supervisor });
    // ...and Ink must NOT own Ctrl+C: with the default (true) Ink unmounts on
    // the first press, before AppContent's useInput handler ever sees the key
    // (busy → abort / idle → double-press quit would both be unreachable).
    expect(options).toMatchObject({ exitOnCtrlC: false });
  });
});
