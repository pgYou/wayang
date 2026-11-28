// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { WayangConfig } from '@wayang-ai/protocol';
import { setControllerModel, setWorkerModel, upsertModel, upsertProvider } from '@/renderer/shared/lib/config-draft';
import { checkCoreCompleteness, NOT_CONFIGURED_PROBLEM } from '@/shared/onboard';

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

// 导入完成的反馈是 toast：这里只断言「调了什么」，不挂 Toaster。
const toast = vi.hoisted(() => {
  const base = vi.fn();
  return Object.assign(base, { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn(), getHistory: vi.fn() });
});
vi.mock('sonner', () => ({ toast }));

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

// 向导各步直接用设置页的卡片组件，这里把它们用到的图标一并替掉。
vi.mock('lucide-react', () => {
  const Icon = () => null;
  return {
    XIcon: Icon,
    UploadIcon: Icon,
    EyeIcon: Icon,
    EyeOffIcon: Icon,
    CheckIcon: Icon,
    ChevronRightIcon: Icon,
    PencilIcon: Icon,
    PlusIcon: Icon,
    Trash2Icon: Icon,
    LoaderIcon: Icon,
  };
});

// Dialog 的替身：开着才渲染，并且像真的一样 portal 到 body（第一步一进来弹窗就是开着的）。
vi.mock('@/renderer/shared/components/ui/dialog', async () => {
  const { createPortal } = await import('react-dom');
  const pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  return {
    Dialog: ({ open, children }: { open: boolean; children?: React.ReactNode }) =>
      open ? createPortal(<div role="dialog">{children}</div>, document.body) : null,
    DialogContent: ({ children, ...rest }: { children?: React.ReactNode }) => <div {...rest}>{children}</div>,
    DialogHeader: pass,
    DialogTitle: ({ children, ...rest }: { children?: React.ReactNode }) => <h2 {...rest}>{children}</h2>,
    DialogDescription: pass,
    DialogFooter: pass,
  };
});

vi.mock('@/renderer/shared/components/ui/select', () => ({
  Select: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

import { byTestId, queryByTestId } from '@/renderer/shared/lib/__tests__/anchors';
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
  toast.mockReset();
  toast.success.mockReset();
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

// 页面内的元素从 container 里找（弹窗 portal 到 body，不在这里）。找元素一律用
// data-testid（见 lib/__tests__/anchors），不按可见文案找——文案是给用户看的。
const inPage = (id: string): HTMLElement => byTestId(id, container!);
const maybeInPage = (id: string): HTMLElement | null => queryByTestId(id, container!);

const click = (el: Element): void => {
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};

describe('OnboardFlow — welcome page entries', () => {
  it('no existing config: 开始配置 opens the wizard from an empty draft, add form ready', () => {
    act(() => root!.render(<OnboardFlow problem={NOT_CONFIGURED_PROBLEM} onFinished={() => undefined} />));
    // 初始页：logo + 标题直接摆在页面上（不套卡片）；真正的首次启动不带原因
    // ——副标题已经把话说完了。
    expect(inPage('onboard-title').tagName).toBe('H1');
    expect(container!.querySelector('[data-slot="wayang-mark"] svg')).not.toBeNull();
    expect(container!.querySelector('[data-slot="card"]')).toBeNull();
    expect(maybeInPage('onboard-note')).toBeNull();
    expect(maybeInPage('onboard-edit-existing')).toBeNull();
    // 磁盘上没有 CLI 配置：不摆「导入 CLI 配置」入口。
    expect(maybeInPage('onboard-import')).toBeNull();
    click(inPage('onboard-start'));
    // 向导页：不套最外层的卡片，顶部是两步的步骤条。空草稿的第一步没有原地展开的
    // 表单（那套已经换成设置页的卡片 + 弹窗），只有一张「新增 provider」的入口卡。
    expect(container!.querySelector('[data-slot="card"]')).toBeNull();
    expect(container!.querySelectorAll('[data-slot="timeline-item"]').length).toBe(2);
    expect(maybeInPage('provider-add')).not.toBeNull();
    expect(container!.querySelectorAll('label')).toHaveLength(0);
    // 新增 provider 的弹窗一进来就开着（portal 到 body）。
    expect(byTestId('provider-add-dialog')).toBeTruthy();
    click(inPage('wizard-back'));
    expect(maybeInPage('onboard-welcome')).not.toBeNull();
  });

  it('the import entry shows only when a CLI config is on disk', () => {
    act(() => root!.render(<OnboardFlow hasCliConfig onFinished={() => undefined} />));
    expect(inPage('onboard-import')).toBeTruthy();
    act(() => root!.render(<OnboardFlow hasCliConfig={false} existingConfig={incomplete} onFinished={() => undefined} />));
    expect(inPage('onboard-edit-existing')).toBeTruthy();
    expect(maybeInPage('onboard-import')).toBeNull();
    act(() => root!.render(<OnboardFlow hasCliConfig existingConfig={incomplete} onFinished={() => undefined} />));
    expect(inPage('onboard-import')).toBeTruthy();
  });

  it('any reason other than a first run stays visible: a broken config file explains why the welcome page is back', () => {
    act(() => root!.render(<OnboardFlow problem="config file is not valid JSON: Unexpected token" onFinished={() => undefined} />));
    // 原因原样写出来——这句提示本身就是被测的行为。
    expect(inPage('onboard-note').textContent).toBe('config file is not valid JSON: Unexpected token');
    expect(inPage('onboard-welcome')).toBeTruthy();
    expect(maybeInPage('onboard-edit-existing')).toBeNull();
  });

  it('an existing incomplete config: 修改现有配置 opens the wizard pre-filled at the first incomplete step', () => {
    act(() => root!.render(<OnboardFlow problem={checkCoreCompleteness(incomplete) ?? undefined} existingConfig={incomplete} onFinished={() => undefined} />));
    // 初始页上就写明现有配置缺什么。
    expect(inPage('onboard-note').textContent).toContain('controller 未绑定模型');
    expect(inPage('onboard-edit-existing')).toBeTruthy();
    expect(inPage('onboard-restart')).toBeTruthy();
    click(inPage('onboard-edit-existing'));
    // provider 与模型都齐，直接停在「Agent」这一步：只摆 Agent 的分组，不摆模型的。
    expect(maybeInPage('models-group')).toBeNull();
    expect(inPage('agent-bindings')).toBeTruthy();
    expect(container!.querySelectorAll('[data-slot="timeline-item"]')[1]?.getAttribute('aria-current')).toBe('step');
    expect(inPage('step-problem').textContent).toContain('controller 未绑定模型');
  });

  it('重新配置 starts over from an empty draft (the existing config is replaced only on confirm)', () => {
    act(() => root!.render(<OnboardFlow existingConfig={incomplete} onFinished={() => undefined} />));
    click(inPage('onboard-restart'));
    // 从空草稿开始：第一步只有「新增 provider」入口，现有配置的条目都不在。
    expect(maybeInPage('provider-add')).not.toBeNull();
    expect(container!.querySelectorAll('[data-testid="provider-edit"]')).toHaveLength(0);
    expect(container!.querySelectorAll('label')).toHaveLength(0);
  });

  it('an import lands on the confirm page — nothing is written until 进入应用', async () => {
    hoisted.importCliConfig.mockResolvedValue({ config: complete, disabledWorkers: [] });
    hoisted.saveConfig.mockResolvedValue({ applied: [], restartRequired: [], booted: true });
    const onFinished = vi.fn();
    act(() => root!.render(<OnboardFlow hasCliConfig onFinished={onFinished} />));
    await act(async () => {
      click(inPage('onboard-import'));
    });
    // 不走向导：直接是两步的卡片一起摆出的确认页，导入的配置都在。
    expect(hoisted.saveConfig).not.toHaveBeenCalled();
    expect(container!.querySelector('[data-slot="timeline"]')).toBeNull();
    expect(inPage('confirm-title').tagName).toBe('H1');
    expect(container!.querySelector('[data-testid="provider-edit"][data-id="hub"]')).not.toBeNull();
    expect(inPage('agent-bindings')).toBeTruthy();
    expect(inPage('agent-puppet-defaults')).toBeTruthy();
    expect((inPage('confirm-apply') as HTMLButtonElement).disabled).toBe(false);
    // 点「进入应用」才写入并进入主界面。
    await act(async () => {
      click(inPage('confirm-apply'));
    });
    expect(hoisted.saveConfig).toHaveBeenCalledTimes(1);
    expect(hoisted.saveConfig.mock.calls[0]?.[0]).toEqual(complete);
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(maybeInPage('onboard-welcome')).toBeNull();
  });

  it('an import that came with invalid third-party workers disabled says which ones', async () => {
    const problem = 'workers.codex.command is required for type "acp"';
    hoisted.importCliConfig.mockResolvedValue({ config: complete, disabledWorkers: [{ id: 'codex', problem }] });
    act(() => root!.render(<OnboardFlow hasCliConfig onFinished={() => undefined} />));
    await act(async () => {
      click(inPage('onboard-import'));
    });
    // 哪一行、为什么：写在 toast 的说明里，常驻到用户点掉；停用的行本身不影响「进入应用」。
    expect(toast).toHaveBeenCalledWith(
      '导入的配置里有 worker 已置为停用',
      expect.objectContaining({ description: expect.stringContaining(`codex（${problem}）`), duration: Infinity }),
    );
    expect((inPage('confirm-apply') as HTMLButtonElement).disabled).toBe(false);
  });

  it('an incomplete import lands on the same page with 进入应用 closed and the gap spelled out', async () => {
    // provider 与模型都有、只差绑定的配置。
    hoisted.importCliConfig.mockResolvedValue({ config: incomplete, disabledWorkers: [] });
    act(() => root!.render(<OnboardFlow hasCliConfig onFinished={() => undefined} />));
    await act(async () => {
      click(inPage('onboard-import'));
    });
    expect(container!.querySelector('[data-slot="timeline"]')).toBeNull();
    expect(inPage('confirm-problem').textContent).toContain('controller 未绑定模型');
    expect((inPage('confirm-apply') as HTMLButtonElement).disabled).toBe(true);
    expect(hoisted.saveConfig).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it('a failed 进入应用 stays on the page with the error', async () => {
    hoisted.importCliConfig.mockResolvedValue({ config: complete, disabledWorkers: [] });
    hoisted.saveConfig.mockRejectedValueOnce(new Error('server 正在自愈（phase: degraded），请稍候再保存'));
    const onFinished = vi.fn();
    act(() => root!.render(<OnboardFlow hasCliConfig onFinished={onFinished} />));
    await act(async () => {
      click(inPage('onboard-import'));
    });
    await act(async () => {
      click(inPage('confirm-apply'));
    });
    expect(onFinished).not.toHaveBeenCalled();
    expect(inPage('confirm-error').textContent).toContain('server 正在自愈');
    // 改完还能再点。
    expect((inPage('confirm-apply') as HTMLButtonElement).disabled).toBe(false);
  });

  it('confirming writes the draft once and hands over; a failed write stays on the page with the error', async () => {
    // 一份完整的现有配置：向导从第一步开始，过一步「下一步」到 Agent 步才收尾。
    const toConfirm = (): void => {
      click(inPage('onboard-edit-existing'));
      click(inPage('wizard-next'));
      click(inPage('wizard-next'));
    };
    hoisted.saveConfig.mockRejectedValueOnce(new Error('providers.hub.baseURL is required'));
    act(() => root!.render(<OnboardFlow existingConfig={complete} onFinished={() => undefined} />));
    toConfirm();
    await act(async () => {
      click(inPage('confirm-apply'));
    });
    expect(hoisted.saveConfig).toHaveBeenCalledTimes(1);
    expect(hoisted.saveConfig.mock.calls[0]?.[0]).toEqual(complete);
    expect(inPage('confirm-error').textContent).toContain('providers.hub.baseURL is required');

    hoisted.saveConfig.mockResolvedValueOnce({ applied: [], restartRequired: [], booted: true });
    const onFinished = vi.fn();
    act(() => root!.unmount());
    root = createRoot(container!);
    act(() => root!.render(<OnboardFlow existingConfig={complete} onFinished={onFinished} />));
    toConfirm();
    await act(async () => {
      click(inPage('confirm-apply'));
    });
    expect(onFinished).toHaveBeenCalledTimes(1);
  });
});
