// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import { act } from 'react';
import type { WayangConfig } from '@wayang-ai/protocol';
import { renameModel, renameProvider } from '@/renderer/shared/lib/config-draft';

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
  restartServer: vi.fn(),
}));

vi.mock('@/renderer/shared/lib/wayang-api', () => ({
  wayang: {
    readConfig: hoisted.readConfig,
    saveConfig: hoisted.saveConfig,
    chooseDirectory: vi.fn(),
    restartServer: hoisted.restartServer,
    onWindowState: () => () => undefined,
  },
}));

// 保存反馈是 toast：这里只断言「调了什么」，不挂 Toaster。
const toast = vi.hoisted(() => {
  const base = vi.fn();
  return Object.assign(base, { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn(), getHistory: vi.fn() });
});
vi.mock('sonner', () => ({ toast }));

vi.mock('@/renderer/shared/components/shared/app-header', () => ({
  AppHeader: ({ left }: { left?: ReactNode }) => <header>{left}</header>,
}));

// Label / Select 的 shim 是「能用」的（真 htmlFor、带 option 的原生 select）：
// 新增的断言要按标签找控件、改值。
vi.mock('@/renderer/shared/components/ui/select', async () => {
  const React = await import('react');
  const SelectTrigger = (_props: { id?: string }): null => null;
  const SelectValue = (): null => null;
  const SelectContent = (_props: { children?: ReactNode }): null => null;
  const SelectItem = (_props: { value: string; children?: ReactNode }): null => null;
  const Select = ({ value, onValueChange, children }: { value?: string; onValueChange: (value: string) => void; children?: ReactNode }) => {
    const options: { value: string; label: ReactNode }[] = [];
    let id: string | undefined;
    const walk = (nodes: ReactNode): void => {
      React.Children.forEach(nodes, (child) => {
        if (!React.isValidElement<{ id?: string; value?: string; children?: ReactNode }>(child)) return;
        if (child.type === SelectItem) options.push({ value: child.props.value ?? '', label: child.props.children });
        else {
          if (child.type === SelectTrigger) id = child.props.id;
          walk(child.props.children);
        }
      });
    };
    walk(children);
    return (
      <select id={id} value={value ?? ''} onChange={(e) => onValueChange(e.target.value)}>
        <option value="" />
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  };
  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem };
});

// Dialog 的 shim：开着才渲染，并且像真的一样 portal 到 body——所以下面的
// 查找都从 document.body 出发（弹窗里的控件不在 container 里）。
vi.mock('@/renderer/shared/components/ui/dialog', async () => {
  const { createPortal } = await import('react-dom');
  const pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) => (open ? createPortal(<div role="dialog">{children}</div>, document.body) : null),
    DialogContent: pass,
    DialogHeader: pass,
    DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
    DialogDescription: pass,
    DialogFooter: pass,
  };
});

vi.mock('@/renderer/shared/components/ui/label', () => ({
  Label: ({ children, ...rest }: React.LabelHTMLAttributes<HTMLLabelElement>) => <label {...rest}>{children}</label>,
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
    XIcon: Icon,
    EyeIcon: Icon,
    EyeOffIcon: Icon,
    PencilIcon: Icon,
    Trash2Icon: Icon,
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
  // 每个用例从干净的调用记录开始（「没保存过」的断言不能被上一个用例污染）。
  hoisted.readConfig.mockReset().mockResolvedValue({ config, desktop: { defaultWorkerWorkspace: '/Users/me/work' } });
  hoisted.saveConfig.mockReset().mockResolvedValue({ applied: [], restartRequired: [], booted: false });
  hoisted.restartServer.mockReset().mockResolvedValue({ sessionId: 'preview' });
  toast.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  toast.loading.mockReset();
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

const buttonNamed = (label: string): HTMLButtonElement => {
  const button = Array.from(document.body.querySelectorAll('button')).find((el) => el.textContent?.trim() === label);
  if (!button) throw new Error(`button not found: ${label}`);
  return button;
};
const navButton = buttonNamed;

/** 图标按钮（编辑 / 删除）没有可见文字，靠 aria-label 找。 */
const iconButton = (label: string): HTMLButtonElement => {
  const button = document.body.querySelector(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`icon button not found: ${label}`);
  return button as HTMLButtonElement};

/** 按标签文字找输入框。只认带 for 的表单标签——卡片里的只读字段也有同名标签，但没有关联控件。 */
const inputFor = (label: string): HTMLInputElement => {
  const htmlFor = Array.from(document.body.querySelectorAll('label')).find((el) => el.textContent === label && el.hasAttribute('for'))?.getAttribute('for');
  const control = htmlFor ? document.getElementById(htmlFor) : null;
  if (!(control instanceof HTMLInputElement)) throw new Error(`input not found for label: ${label}`);
  return control;
};
const maybeInputFor = (label: string): HTMLInputElement | undefined => {
  try {
    return inputFor(label);
  } catch {
    return undefined;
  }
};

const typeInto = (input: HTMLInputElement, value: string): void => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const click = (el: Element): void => {
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};

/** 当前打开的弹窗（没有则 null）。 */
const openDialog = (): HTMLElement | null => document.body.querySelector('[role="dialog"]') as HTMLElement | null;

/** 弹窗的标题文字。 */
const dialogTitle = (): string | null => openDialog()?.querySelector('h2')?.textContent ?? null;

/** 提交弹窗里的表单（回车 / 点主按钮走的是同一条路）。 */
const submitDialog = (): void => {
  const form = openDialog()?.querySelector('form');
  if (!form) throw new Error('no form in the open dialog');
  act(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
};

/** 等异步的保存 / 报错落定（useAutoSaveAction 的 catch/finally 在 promise 之后）。 */
const settle = (): Promise<void> => act(async () => undefined);

/** 最近一次提交给后端的配置。 */
const lastSaved = async (): Promise<WayangConfig> => {
  await settle();
  const call = hoisted.saveConfig.mock.calls.at(-1);
  if (!call) throw new Error('saveConfig was not called');
  return call[0] as WayangConfig;
};

describe('SettingsPage', () => {
  it('mounts and switches through every group without an update loop', async () => {
    await act(async () => {
      root!.render(<SettingsPage onClose={() => undefined} />);
    });
    // 首屏：模型分组（默认）——只有 provider 与模型，模型绑定在 Agent 分组。
    expect(container!.textContent).not.toContain('模型绑定');
    expect(container!.textContent).toContain('Providers');

    for (const label of ['Agent', '权限', '工作区', '高级', '模型']) {
      act(() => navButton(label).click());
    }
    expect(container!.textContent).not.toContain('模型绑定');

    act(() => navButton('Agent').click());
    expect(container!.textContent).toContain('模型绑定');
    expect(hoisted.saveConfig).not.toHaveBeenCalled();
  });

  it('renders the loaded config values, not placeholders', async () => {
    await act(async () => {
      root!.render(<SettingsPage onClose={() => undefined} />);
    });
    act(() => navButton('Agent').click());
    // Puppet 默认参数是只读的三行（不是输入框）。
    const text = container!.textContent ?? '';
    expect(text).toMatch(/最大并发\s*3/);
    expect(text).toMatch(/Max turns\s*重启生效\s*12/);
    expect(text).toMatch(/Tool choice\s*auto/);
  });

  it('puppet defaults are read-only on the page; editing happens in a dialog', async () => {
    await act(async () => {
      root!.render(<SettingsPage onClose={() => undefined} />);
    });
    act(() => navButton('Agent').click());
    // 这三项在页面里没有输入框（第三方 worker 卡片里的输入框是另一回事）。
    // 「最大并发」在页面里是只读标签：没有关联的输入框。
    const concurrencyLabel = Array.from(document.body.querySelectorAll('label')).find((el) => el.textContent === '最大并发');
    expect(concurrencyLabel?.hasAttribute('for')).toBe(false);
    expect(maybeInputFor('最大并发')).toBeUndefined();

    click(iconButton('编辑 Puppet 默认参数'));
    expect(dialogTitle()).toBe('编辑 Puppet 默认参数');
    expect(inputFor('最大并发').value).toBe('3');
    expect((buttonNamed('保存') as HTMLButtonElement).disabled).toBe(true);
    // 清空并发数不合法：原因就近显示，保存不点亮。
    typeInto(inputFor('最大并发'), '');
    expect(openDialog()!.textContent).toContain('最大并发需为正整数');
    expect((buttonNamed('保存') as HTMLButtonElement).disabled).toBe(true);

    typeInto(inputFor('最大并发'), '5');
    submitDialog();
    expect(await lastSaved()).toEqual({ ...config, worker: { ...config.worker, maxConcurrency: 5 } });
    expect(openDialog()).toBeNull();
  });

  it('groups models under a collapsible provider card; the bindings live on the Agent page, above the worker settings', async () => {
    await act(async () => {
      root!.render(<SettingsPage onClose={() => undefined} />);
    });
    // provider 卡片内直接列出其模型；模型绑定不在这页。
    expect(container!.textContent).toContain('gpt-fast');
    expect(container!.textContent).not.toContain('模型绑定');
    const toggle = Array.from(container!.querySelectorAll('button[aria-expanded]')).find((el) => el.textContent?.includes('main')) as HTMLButtonElement;
    // 卡片默认展开：点一下收起，再点开。
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    // 模型绑定在 Agent 分组，排在 Puppet 默认参数与第三方 worker 之前。
    act(() => navButton('Agent').click());
    const text = container!.textContent ?? '';
    expect(text.indexOf('模型绑定')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('模型绑定')).toBeLessThan(text.indexOf('Puppet 默认参数'));
    expect(text.indexOf('Puppet 默认参数')).toBeLessThan(text.indexOf('第三方 Worker'));
  });

  it('renaming a bound model carries the bindings over to the new name', async () => {
    await act(async () => {
      root!.render(<SettingsPage onClose={() => undefined} />);
    });
    click(iconButton('编辑模型 fast'));
    expect(dialogTitle()).toBe('编辑模型');
    expect(inputFor('名称').value).toBe('fast');
    // 改条目名 = 重命名。编辑已有模型不强制填上下文窗口（留空按 256K）：
    // 只改名称就能保存，controller / worker 的绑定跟着指向新名字。
    typeInto(inputFor('名称'), 'sonnet');
    expect((buttonNamed('保存') as HTMLButtonElement).disabled).toBe(false);
    submitDialog();
    expect(await lastSaved()).toEqual(renameModel(config, 'fast', 'sonnet'));
    // 保存成功后弹窗自己关上。
    expect(openDialog()).toBeNull();
  });

  it('refuses to delete a model or a provider that is still in use, with a plain message', async () => {
    await act(async () => {
      root!.render(<SettingsPage onClose={() => undefined} />);
    });
    click(iconButton('删除模型 fast'));
    await settle();
    expect(hoisted.saveConfig).not.toHaveBeenCalled();
    expect(container!.textContent).toContain('该模型正被 controller、worker 使用，先改绑再删除');

    click(iconButton('删除 provider main'));
    await settle();
    expect(container!.textContent).toContain('该 provider 下还有模型（fast）');
    expect(hoisted.saveConfig).not.toHaveBeenCalled();
  });

  it('editing a provider opens a dialog — the card itself stays read-only', async () => {
    await act(async () => {
      root!.render(<SettingsPage onClose={() => undefined} />);
    });
    expect(container!.querySelector('input')).toBeNull();
    click(iconButton('编辑 provider main'));
    expect(dialogTitle()).toBe('编辑 provider');
    // 卡片里没有冒出输入框：表单只在弹窗里。
    expect(container!.querySelector('input')).toBeNull();
    // 名称、Base URL、API Key——名称也能改（改名即重命名，引用它的地方一起改）。
    expect(openDialog()!.querySelectorAll('input')).toHaveLength(3);
    const key = inputFor('API Key');
    expect(key.type).toBe('password');
    click(openDialog()!.querySelector('button[aria-label="显示 API Key"]') as Element);
    expect(key.type).toBe('text');
    // 没改动时保存不点亮。
    expect((buttonNamed('保存') as HTMLButtonElement).disabled).toBe(true);

    typeInto(inputFor('API Key'), 'k-rotated');
    submitDialog();
    expect(await lastSaved()).toEqual({ ...config, providers: { main: { ...config.providers.main, apiKey: 'k-rotated' } } });
    expect(openDialog()).toBeNull();
  });

  it('renaming a provider carries its models and every reference over to the new name', async () => {
    await act(async () => {
      root!.render(<SettingsPage onClose={() => undefined} />);
    });
    click(iconButton('编辑 provider main'));
    expect(inputFor('名称').value).toBe('main');
    typeInto(inputFor('名称'), 'hub');
    submitDialog();
    // 夹具里 controller 与 worker 都绑着 main 名下的 fast：改名后原样可用。
    const expected = renameProvider(config, 'main', 'hub');
    expect(expected.models?.fast.provider).toBe('hub');
    expect(expected.controller.model).toBe('fast');
    expect(await lastSaved()).toEqual(expected);
    expect(openDialog()).toBeNull();
  });

  it('adding a provider opens a dialog; cancel closes it without saving anything', async () => {
    await act(async () => {
      root!.render(<SettingsPage onClose={() => undefined} />);
    });
    click(buttonNamed('新增 provider'));
    expect(dialogTitle()).toBe('新增 provider');
    expect(openDialog()!.querySelectorAll('label')).toHaveLength(3);
    expect((buttonNamed('添加') as HTMLButtonElement).disabled).toBe(true);

    // 名称和已有的重复：原因就近显示，仍然不能提交。
    typeInto(inputFor('名称'), 'main');
    typeInto(inputFor('Base URL'), 'https://hub.example/v1');
    typeInto(inputFor('API Key'), 'sk-hub');
    expect(openDialog()!.textContent).toContain('provider 名称「main」已存在');
    expect((buttonNamed('添加') as HTMLButtonElement).disabled).toBe(true);
    click(buttonNamed('取消'));
    expect(openDialog()).toBeNull();
    expect(hoisted.saveConfig).not.toHaveBeenCalled();

    click(buttonNamed('新增 provider'));
    typeInto(inputFor('名称'), 'hub');
    typeInto(inputFor('Base URL'), 'https://hub.example/v1');
    typeInto(inputFor('API Key'), 'sk-hub');
    submitDialog();
    expect(await lastSaved()).toEqual({
      ...config,
      providers: { ...config.providers, hub: { type: 'openai-compatible', baseURL: 'https://hub.example/v1', apiKey: 'sk-hub' } },
    });
    expect(openDialog()).toBeNull();
  });

  it('the add-model dialog exposes the request params', async () => {
    await act(async () => {
      root!.render(<SettingsPage onClose={() => undefined} />);
    });
    click(buttonNamed('添加模型'));
    expect(dialogTitle()).toBe('添加模型');
    expect(Array.from(openDialog()!.querySelectorAll('label')).map((el) => el.textContent)).toEqual(
      expect.arrayContaining(['名称', '模型名', '上下文窗口（tokens）', '最大输出 tokens', '温度']),
    );
    click(buttonNamed('取消'));
    expect(openDialog()).toBeNull();
  });

  it('save feedback goes through toasts: a short one when it hot-applied, a sticky one with a restart button otherwise', async () => {
    await act(async () => {
      root!.render(<SettingsPage onClose={() => undefined} />);
    });
    // 热更生效（改绑定是即时提交；模型绑定在 Agent 分组）。
    act(() => navButton('Agent').click());
    hoisted.saveConfig.mockResolvedValueOnce({ applied: ['update_controller_model'], restartRequired: [], booted: false });
    const binding = document.body.querySelector('select') as HTMLSelectElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(binding, 'fast');
      binding.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(toast.success).toHaveBeenCalledWith('已保存并生效', expect.objectContaining({ id: 'config-applied' }));

    // 有需要重启才生效的项：常驻提示 + 「重启 server」按钮，点它去重启。
    hoisted.saveConfig.mockResolvedValueOnce({ applied: [], restartRequired: ['worker.maxTurns（需重启生效）'], booted: false });
    act(() => {
      binding.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(toast).toHaveBeenCalledWith(
      '已保存，需重启生效',
      expect.objectContaining({ id: 'config-restart-required', description: '以下设置重启后生效：worker.maxTurns（需重启生效）', duration: Infinity }),
    );
    const call = toast.mock.calls.at(-1) as unknown as [string, { action: { label: string; onClick: (event: { preventDefault: () => void }) => void } }];
    // 动作按钮只有两个字：标题不换行，按钮不能把标题挤掉。
    expect(call[1].action.label).toBe('重启');
    // 点「重启」：拦下 sonner「点完自动关闭」的默认行为——这条提示要原地变成
    // 「正在重启…」，再变成结果，不能跟着消失；重启期间按钮不再显示（防连点）。
    const event = { preventDefault: vi.fn() };
    call[1].action.onClick(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(hoisted.restartServer).toHaveBeenCalledTimes(1);
    expect(toast.loading).toHaveBeenCalledWith('正在重启…', expect.objectContaining({ id: 'config-restart-required', action: null }));
    await settle();
    expect(toast.success).toHaveBeenLastCalledWith('server 已重启', expect.objectContaining({ id: 'config-restart-required' }));
    // 页面里不再有手写的提示条。
    expect(container!.textContent).not.toContain('知道了');
  });

  it('a third-party worker is renamed by editing the name in its card; the save bar only shows once something changed', async () => {
    await act(async () => {
      root!.render(<SettingsPage onClose={() => undefined} />);
    });
    act(() => navButton('Agent').click());
    const saveButtons = (): HTMLButtonElement[] =>
      Array.from(document.body.querySelectorAll('button')).filter((el) => el.textContent?.trim() === '保存') as HTMLButtonElement[];
    // 卡片展开着，但没有改动：没有保存 / 取消。
    expect(saveButtons()).toHaveLength(0);
    // 头部只有 emoji + 名称（展开时不带类型徽标和描述）。
    const toggle = container!.querySelector('button[aria-expanded]') as HTMLElement;
    expect(toggle.textContent).toBe('claude-code');

    const name = inputFor('名称');
    expect(name.value).toBe('claude-code');
    typeInto(name, 'claude');
    expect(saveButtons()).toHaveLength(1);
    // 名称清空不合法：原因就近显示，保存不亮。
    typeInto(name, '');
    expect(document.body.textContent).toContain('请填写名称');
    expect((saveButtons()[0] as HTMLButtonElement).disabled).toBe(true);
    typeInto(name, 'claude');
    click(saveButtons()[0] as HTMLButtonElement);
    expect(await lastSaved()).toEqual({ ...config, workers: { claude: config.workers!['claude-code'] } });
  });

  it('lets a third-party worker be edited, not only toggled', async () => {
    await act(async () => {
      root!.render(<SettingsPage onClose={() => undefined} />);
    });
    act(() => navButton('Agent').click());
    // 描述是一段给 controller 看的自然语言：文本域，不是单行输入框。
    const description = container!.querySelector('textarea') as HTMLTextAreaElement | null;
    expect(description?.value).toBe('第三方编码 agent');
    expect(container!.querySelector('button[role="switch"]')).not.toBeNull();
    expect(container!.textContent).toContain('添加 worker');
  });
});
