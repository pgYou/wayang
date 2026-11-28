// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

/**
 * the session menu drives the three 域二 channels —
 * new-session confirm → newSession + store.rehydrate; history dialog →
 * listSessions → select → confirm → switchSession + store.rehydrate.
 */

vi.mock('@/renderer/shared/lib/wayang-api', () => ({
  wayang: {
    listSessions: vi.fn(),
    newSession: vi.fn(),
    switchSession: vi.fn(),
  },
}));

vi.mock('@/renderer/shared/lib/store', () => ({
  wayangStore: { rehydrate: vi.fn() },
}));

vi.mock('@/renderer/shared/lib/session-lazy', () => ({
  beginNewSession: vi.fn(),
  cancelLazyNewSession: vi.fn(),
}));

// UI shims: the radix-backed primitives are externalized by vitest and
// resolve the repo-root react 18 (the dual-React-major hoist), which breaks
// hooks inside one bundle. The shims keep this test on the WIRING (channels
// + rehydrate + error paths); the primitives themselves are shadcn-canonical
// code exercised by the dev-run visual pass.
vi.mock('@/renderer/shared/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div role="menu">{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
    ...rest
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
  } & Record<string, unknown>) => (
    <div role="menuitem" {...rest} onClick={onSelect}>
      {children}
    </div>
  ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}));
vi.mock('@/renderer/shared/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) => (open ? <div role="dialog">{children}</div> : null),
  DialogContent: ({ children, ...rest }: { children?: React.ReactNode }) => <div {...rest}>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/renderer/shared/components/ui/scroll-area', () => ({ ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/renderer/shared/components/ui/skeleton', () => ({ Skeleton: () => <div data-testid="skeleton" /> }));
vi.mock('@/renderer/shared/components/ui/button', () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
}));
vi.mock('@/renderer/shared/components/ui/badge', () => ({ Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
// lucide-react is externalized by vitest and its hoisted copy resolves the
// repo-root react 18 — the icons would inject foreign elements into the 19
// tree. Shims keep the icons inert.
vi.mock('lucide-react', () => ({
  EllipsisIcon: (props: Record<string, unknown>) => <span data-icon="ellipsis" {...props} />,
  HistoryIcon: (props: Record<string, unknown>) => <span data-icon="history" {...props} />,
  LoaderIcon: (props: Record<string, unknown>) => <span data-icon="loader" {...props} />,
  PlusIcon: (props: Record<string, unknown>) => <span data-icon="plus" {...props} />,
}));

import { byTestId, queryByTestId, rowAction } from '@/renderer/shared/lib/__tests__/anchors';
import { wayang } from '@/renderer/shared/lib/wayang-api';
import { wayangStore } from '@/renderer/shared/lib/store';
import { beginNewSession } from '@/renderer/shared/lib/session-lazy';
import { SessionMenu } from '../parts/session-menu';

const entries = [
  { sessionId: 's-1', title: '帮我发布桌面应用', createdAt: 1730000000000, lastActiveAt: 1730000100000 },
  { sessionId: 's-2', title: null, createdAt: 1730001000000, lastActiveAt: 1730001100000 },
];

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  container?.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
});

function renderMenu(): HTMLElement {
  root = createRoot(container!);
  act(() => {
    root!.render(<SessionMenu />);
  });
  return container!;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

describe('SessionMenu', () => {
  it('history dialog lists sessions with time + summary; selecting + confirm switches and rehydrates', async () => {
    vi.mocked(wayang.listSessions).mockResolvedValue(entries);
    vi.mocked(wayang.switchSession).mockResolvedValue({ sessionId: 's-1' });
    const el = renderMenu();

    // Open the dropdown, then the history dialog.
    await click(byTestId('session-menu-trigger', el));
    await click(byTestId('session-menu-history', el));
    // The dialog opened and listSessions fired (list: time + summary).
    expect(wayang.listSessions).toHaveBeenCalledTimes(1);
    await click(rowAction('session-item', 's-1', el));
    await click(byTestId('session-switch-confirm', el));

    expect(wayang.switchSession).toHaveBeenCalledWith('s-1');
    expect(wayangStore.rehydrate).toHaveBeenCalledTimes(1);
  });

  it('listSessions failure surfaces the error inside the dialog', async () => {
    vi.mocked(wayang.listSessions).mockRejectedValue(new Error('server not ready'));
    const el = renderMenu();
    await click(byTestId('session-menu-trigger', el));
    await click(byTestId('session-menu-history', el));
    expect(el.textContent).toContain('server not ready');
  });

  it('新会话 confirm path: lazy — local reset only, no server session until first input', async () => {
    const el = renderMenu();
    await click(byTestId('session-menu-trigger', el));
    await click(byTestId('session-menu-new', el));
    await click(byTestId('session-new-confirm', el));
    // 懒加载：确认后只重置本地视图（beginNewSession），server 不创建会话。
    expect(beginNewSession).toHaveBeenCalledTimes(1);
    expect(wayang.newSession).not.toHaveBeenCalled();
    expect(wayangStore.rehydrate).not.toHaveBeenCalled();
    // 确认弹窗关闭。
    expect(queryByTestId('session-new-dialog', el)).toBeNull();
  });

  it('a failing switch keeps the dialog open with the error', async () => {
    vi.mocked(wayang.listSessions).mockResolvedValue(entries);
    vi.mocked(wayang.switchSession).mockRejectedValue(new Error('unknown session'));
    const el = renderMenu();
    await click(byTestId('session-menu-trigger', el));
    await click(byTestId('session-menu-history', el));
    await click(rowAction('session-item', 's-1', el));
    await click(byTestId('session-switch-confirm', el));
    expect(el.textContent).toContain('unknown session');
    // No rehydrate when the switch failed.
    expect(wayangStore.rehydrate).not.toHaveBeenCalled();
  });
});
