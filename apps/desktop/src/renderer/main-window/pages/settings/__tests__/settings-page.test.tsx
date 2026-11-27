// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import { act } from 'react';
import type { WayangConfig } from '@wayang-ai/protocol';

/**
 * 设置页挂载/切组回归：进入设置页与在五个分组间切换都不能自激更新
 * （"Maximum update depth exceeded" 曾由 useDraftSection 的对象字面量
 * committed 触发，见 parts/__tests__/draft-section.test.tsx）。
 *
 * radix 系原语与 lucide 由 vitest externalize 后可能解析到仓库根的 react 18
 * （双 React major 提升），这里按 session-menu 测试的惯例做 UI shim，测试
 * 只钉页面装配与分组切换。
 */

const hoisted = vi.hoisted(() => ({
  readConfig: vi.fn(),
  saveConfig: vi.fn(),
}));

vi.mock('@/renderer/shared/lib/wayang-api', () => ({
  wayang: {
    readConfig: hoisted.readConfig,
    saveConfig: hoisted.saveConfig,
    chooseDirectory: vi.fn(),
    restartServer: vi.fn(),
    onWindowState: () => () => undefined,
  },
}));

vi.mock('@/renderer/shared/components/shared/app-header', () => ({
  AppHeader: ({ left }: { left?: ReactNode }) => <header>{left}</header>,
}));

vi.mock('@/renderer/shared/components/ui/select', () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/renderer/shared/components/ui/label', () => ({
  Label: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@/renderer/shared/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock('@/renderer/shared/components/ui/badge', () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock('lucide-react', () => {
  const Icon = () => <span aria-hidden />;
  return {
    ArrowLeftIcon: Icon,
    BotIcon: Icon,
    CpuIcon: Icon,
    FolderIcon: Icon,
    ShieldIcon: Icon,
    SlidersHorizontalIcon: Icon,
    ChevronRightIcon: Icon,
    PlusIcon: Icon,
    LoaderIcon: Icon,
    RotateCcwIcon: Icon,
    FolderOpenIcon: Icon,
  };
});

import { SettingsPage } from '../settings-page';

const config: WayangConfig = {
  providers: { main: { type: 'openai-compatible', baseURL: 'https://api.example.com/v1', apiKey: 'k' } },
  models: { fast: { provider: 'main', name: 'gpt-fast' } },
  controller: { model: 'fast' },
  worker: { model: 'fast', maxConcurrency: 3, toolChoice: 'auto', maxTurns: 12 },
  workers: { 'claude-code': { type: 'claude-code', description: '第三方编码 agent' } },
  tavilyApiKey: 'tvly',
  skillsDirs: ['/Users/me/skills'],
  idleTimeoutMs: 1800000,
  signalWindowSize: 2000,
  permission: { allowedDirs: ['/Users/me/projects'], sensitiveMode: 'ask', approvalMemory: 'task' },
  logging: { maxFileSizeBytes: 10485760, maxFiles: 3 },
};

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  hoisted.readConfig.mockResolvedValue({ config, desktop: { defaultWorkerWorkspace: '/Users/me/work' } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const navButton = (label: string): HTMLButtonElement => {
  const button = Array.from(container!.querySelectorAll('button')).find((el) => el.textContent?.trim() === label);
  if (!button) throw new Error(`nav button not found: ${label}`);
  return button;
};

describe('SettingsPage', () => {
  it('mounts and switches through every group without an update loop', async () => {
    await act(async () => {
      root!.render(<SettingsPage onClose={() => undefined} />);
    });
    // 首屏：模型分组（默认）。
    expect(container!.textContent).toContain('模型绑定');
    expect(container!.textContent).toContain('Providers');

    for (const label of ['Worker', '权限', '工作区', '高级', '模型']) {
      act(() => navButton(label).click());
    }

    expect(container!.textContent).toContain('模型绑定');
    expect(hoisted.saveConfig).not.toHaveBeenCalled();
  });

  it('renders the loaded config values, not placeholders', async () => {
    await act(async () => {
      root!.render(<SettingsPage onClose={() => undefined} />);
    });
    act(() => navButton('Worker').click());
    const concurrency = container!.querySelector('input[inputmode="numeric"]') as HTMLInputElement | null;
    expect(concurrency?.value).toBe('3');
  });

  it('groups models under a collapsible provider card, with bindings last', async () => {
    await act(async () => {
      root!.render(<SettingsPage onClose={() => undefined} />);
    });
    const text = container!.textContent ?? '';
    // provider 在前、模型绑定在后。
    expect(text.indexOf('Providers')).toBeLessThan(text.indexOf('模型绑定'));
    // provider 卡片内直接列出其模型。
    expect(text).toContain('gpt-fast');

    const toggle = Array.from(container!.querySelectorAll('button[aria-expanded]')).find((el) => el.textContent?.includes('main'));
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    act(() => (toggle as HTMLButtonElement).click());
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  });

  it('lets a third-party worker be edited, not only toggled', async () => {
    await act(async () => {
      root!.render(<SettingsPage onClose={() => undefined} />);
    });
    act(() => navButton('Worker').click());
    const description = Array.from(container!.querySelectorAll('input')).find(
      (el) => (el as HTMLInputElement).value === '第三方编码 agent',
    ) as HTMLInputElement | undefined;
    expect(description).toBeDefined();
    expect(container!.querySelector('button[role="switch"]')).not.toBeNull();
    expect(container!.textContent).toContain('新增 worker');
  });
});
