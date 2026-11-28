// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { WayangConfig } from '@wayang-ai/protocol';
import { setControllerModel, setWorkerModel, upsertModel, upsertProvider } from '@/renderer/shared/lib/config-draft';
import { checkCoreCompleteness } from '@/shared/onboard';

/**
 * 欢迎页三个入口的钉子：没有现成配置 → 「开始配置」从空草稿进向导；磁盘上
 * 有「结构合法但必要核心不完整」的配置 → 多一个「修改现有配置」，以它为
 * 草稿、停在第一个没填好的步骤；「导入 CLI 配置」直接进确认页，返回修改
 * 才进向导。
 */

const hoisted = vi.hoisted(() => ({
  importCliConfig: vi.fn(),
  saveConfig: vi.fn(),
}));

vi.mock('@/renderer/shared/lib/wayang-api', () => ({
  wayang: { importCliConfig: hoisted.importCliConfig, saveConfig: hoisted.saveConfig },
}));

vi.mock('@/renderer/shared/components/shared/app-header', () => ({
  AppHeader: () => <header />,
}));

vi.mock('@/renderer/shared/components/ui/label', () => ({
  Label: ({ children, htmlFor }: { children?: React.ReactNode; htmlFor?: string }) => <label htmlFor={htmlFor}>{children}</label>,
}));

vi.mock('@/renderer/shared/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock('@/renderer/shared/components/ui/badge', () => ({
  Badge: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock('lucide-react', () => ({
  XIcon: () => null,
  UploadIcon: () => null,
  EyeIcon: () => null,
  EyeOffIcon: () => null,
}));

vi.mock('@/renderer/shared/components/ui/select', () => ({
  Select: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

import { OnboardFlow } from '../onboard-flow';

/** provider、模型都有，只差绑定——典型「改到一半」的现有配置。 */
const incomplete: WayangConfig = upsertModel(
  upsertProvider({ providers: {}, models: {}, controller: {}, worker: { maxConcurrency: 3 } }, 'hub', {
    type: 'openai-compatible',
    baseURL: 'https://hub.example/v1',
    apiKey: 'sk-1',
  }),
  'main',
  { provider: 'hub', name: 'gpt-x', contextWindowTokens: 128000 },
);
const complete = setWorkerModel(setControllerModel(incomplete, 'main'), 'main');

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  hoisted.importCliConfig.mockReset();
  hoisted.saveConfig.mockReset();
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

const text = (): string => container!.textContent ?? '';
const labels = (): string[] => Array.from(container!.querySelectorAll('label')).map((el) => el.textContent ?? '');

const buttonNamed = (name: string): HTMLButtonElement => {
  const button = Array.from(container!.querySelectorAll('button')).find((el) => el.textContent?.trim() === name);
  if (!button) throw new Error(`button not found: ${name}`);
  return button as HTMLButtonElement;
};

const click = (el: Element): void => {
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};

describe('OnboardFlow — welcome page entries', () => {
  it('no existing config: 开始配置 opens the wizard from an empty draft, add form ready', () => {
    act(() => root!.render(<OnboardFlow problem="尚未配置：config.json 不存在" onFinished={() => undefined} />));
    expect(text()).toContain('尚未配置');
    expect(text()).not.toContain('修改现有配置');
    click(buttonNamed('开始配置'));
    expect(text()).toContain('初始配置向导');
    expect(labels()).toEqual(['名称', 'Base URL', 'API Key']);
  });

  it('an existing incomplete config: 修改现有配置 opens the wizard pre-filled at the first incomplete step', () => {
    act(() => root!.render(<OnboardFlow problem={checkCoreCompleteness(incomplete) ?? undefined} existingConfig={incomplete} onFinished={() => undefined} />));
    expect(text()).toContain('修改现有配置');
    expect(text()).toContain('重新配置');
    click(buttonNamed('修改现有配置'));
    // provider 与模型都齐，直接停在「模型绑定」这一步。
    expect(labels()).toEqual(['Controller 模型', 'Worker 模型']);
    expect(text()).toContain('controller 未绑定模型');
  });

  it('重新配置 starts over from an empty draft (the existing config is replaced only on confirm)', () => {
    act(() => root!.render(<OnboardFlow existingConfig={incomplete} onFinished={() => undefined} />));
    click(buttonNamed('重新配置（确认后覆盖现有配置）'));
    expect(labels()).toEqual(['名称', 'Base URL', 'API Key']);
    expect(text()).not.toContain('https://hub.example/v1');
  });

  it('import goes straight to the confirm page; 返回修改 enters the wizard with the imported config', async () => {
    hoisted.importCliConfig.mockResolvedValue({ config: complete });
    act(() => root!.render(<OnboardFlow onFinished={() => undefined} />));
    await act(async () => {
      click(buttonNamed('导入 CLI 配置（~/.wayang.config.json，只读）'));
    });
    expect(text()).toContain('确认配置');
    expect(buttonNamed('确认写入并进入主界面').disabled).toBe(false);
    click(buttonNamed('返回修改'));
    expect(text()).toContain('初始配置向导');
    expect(text()).toContain('https://hub.example/v1');
  });

  it('confirming writes the draft once and hands over; a failed write stays on the page with the error', async () => {
    // 一份完整的现有配置：向导从第一步开始，一路「下一步」到 Worker 步才收尾。
    const toConfirm = (): void => {
      click(buttonNamed('修改现有配置'));
      for (let step = 0; step < 3; step += 1) click(buttonNamed('下一步'));
      click(buttonNamed('完成，去确认'));
    };
    hoisted.saveConfig.mockRejectedValueOnce(new Error('providers.hub.baseURL is required'));
    act(() => root!.render(<OnboardFlow existingConfig={complete} onFinished={() => undefined} />));
    toConfirm();
    await act(async () => {
      click(buttonNamed('确认写入并进入主界面'));
    });
    expect(hoisted.saveConfig).toHaveBeenCalledTimes(1);
    expect(hoisted.saveConfig.mock.calls[0]?.[0]).toEqual(complete);
    expect(text()).toContain('providers.hub.baseURL is required');

    hoisted.saveConfig.mockResolvedValueOnce({ applied: [], restartRequired: [], booted: true });
    const onFinished = vi.fn();
    act(() => root!.unmount());
    root = createRoot(container!);
    act(() => root!.render(<OnboardFlow existingConfig={complete} onFinished={onFinished} />));
    toConfirm();
    await act(async () => {
      click(buttonNamed('确认写入并进入主界面'));
    });
    expect(onFinished).toHaveBeenCalledTimes(1);
  });
});
