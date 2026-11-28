// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { byTestId, queryByTestId } from '@/renderer/shared/lib/__tests__/anchors';
import { createRoot, type Root } from 'react-dom/client';
import { act, type ButtonHTMLAttributes, type LabelHTMLAttributes, type ReactNode } from 'react';
import type { WayangConfig, WorkerConfig } from '@wayang-ai/protocol';

/**
 * 原子设置组件的钉子：表单值 ⇄ 配置的转换与校验（纯函数），以及受控组件的
 * 行为——渲染出哪些字段、输入/选择如何经 onChange 报出去、密钥眼睛开关。
 *
 * radix 系原语与 lucide 由 vitest externalize 后可能解析到仓库根的 react 18
 * （双 React major），这里按 settings-page 测试的惯例做 UI shim；Label /
 * Select 的 shim 是「能用」的（真 label 的 htmlFor、原生 select 的 change），
 * 这样「按标签找控件 → 改值」的断言才测得到组件本身。
 */

vi.mock('@/renderer/shared/components/ui/label', () => ({
  Label: ({ children, ...rest }: LabelHTMLAttributes<HTMLLabelElement>) => <label {...rest}>{children}</label>,
}));

vi.mock('@/renderer/shared/components/ui/button', () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock('@/renderer/shared/components/ui/select', async () => {
  const React = await import('react');
  // 结构化 shim：从 children 里读出 SelectTrigger 的 id 与 SelectItem 的选项，
  // 渲染成一个带真 option 的原生 select（控件本身带 id，label 才关联得上）。
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

vi.mock('lucide-react', () => ({
  XIcon: () => <span data-icon="x" />,
  EyeIcon: () => <span data-icon="eye" />,
  EyeOffIcon: () => <span data-icon="eye-off" />,
}));

import {
  FormField,
  ModelBindingSelect,
  ModelForm,
  ProviderForm,
  PuppetDefaultsForm,
  ReadonlyField,
  ReadonlySecretField,
  WorkerForm,
  applyPuppetDefaultsForm,
  applyWorkerForm,
  emptyModelForm,
  modelForm,
  modelFromForm,
  modelFormProblem,
  parseDecimal,
  parsePositiveInt,
  puppetDefaultsForm,
  puppetDefaultsFormProblem,
  providerForm,
  providerFromForm,
  providerFormProblem,
  workerForm,
  workerFormProblem,
} from '../index';

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

const render = (node: ReactNode): void => {
  act(() => root!.render(node));
};

/** 按标签文字找控件：label 的 htmlFor 指向控件 id（FormField 自动关联）。 */
const controlFor = (label: string): HTMLElement => {
  const htmlFor = Array.from(container!.querySelectorAll('label')).find((el) => el.textContent === label)?.getAttribute('for');
  const control = htmlFor ? document.getElementById(htmlFor) : null;
  if (!control) throw new Error(`control not found for label: ${label}`);
  return control;
};

const inputFor = (label: string): HTMLInputElement => {
  const control = controlFor(label);
  if (!(control instanceof HTMLInputElement)) throw new Error(`control for "${label}" is not an input`);
  return control;
};

const textareaFor = (label: string): HTMLTextAreaElement => {
  const control = controlFor(label);
  if (!(control instanceof HTMLTextAreaElement)) throw new Error(`control for "${label}" is not a textarea`);
  return control;
};

const selectFor = (label: string): HTMLSelectElement => {
  const control = controlFor(label);
  if (!(control instanceof HTMLSelectElement)) throw new Error(`control for "${label}" is not a select`);
  return control;
};

const typeInto = (input: HTMLInputElement, value: string): void => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const typeIntoTextarea = (textarea: HTMLTextAreaElement, value: string): void => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const choose = (select: HTMLSelectElement, value: string): void => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

const click = (el: Element): void => {
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};
const labels = (): string[] => Array.from(container!.querySelectorAll('label')).map((el) => el.textContent ?? '');

/* ------------------------------ 纯函数 ------------------------------ */

describe('number parsing', () => {
  it('separates empty from invalid from valid', () => {
    expect(parsePositiveInt('')).toEqual({ empty: true, invalid: false });
    expect(parsePositiveInt(' 128000 ')).toEqual({ empty: false, invalid: false, value: 128000 });
    expect(parsePositiveInt('0')).toEqual({ empty: false, invalid: true });
    expect(parsePositiveInt('1.5')).toEqual({ empty: false, invalid: true });
    expect(parsePositiveInt('abc')).toEqual({ empty: false, invalid: true });
    expect(parseDecimal('0.7')).toEqual({ empty: false, invalid: false, value: 0.7 });
    expect(parseDecimal('x')).toEqual({ empty: false, invalid: true });
  });
});

describe('provider form values', () => {
  it('round-trips a provider and trims on the way back', () => {
    const values = providerForm('hub', { type: 'openai-compatible', baseURL: 'https://hub.example/v1', apiKey: 'sk-1' });
    expect(values).toEqual({ key: 'hub', baseURL: 'https://hub.example/v1', apiKey: 'sk-1' });
    expect(providerFromForm({ ...values, baseURL: ' https://hub.example/v1 ', apiKey: ' sk-1 ' })).toEqual({
      type: 'openai-compatible',
      baseURL: 'https://hub.example/v1',
      apiKey: 'sk-1',
    });
  });

  it('validates: key (when required), a real http(s) URL, a non-empty key', () => {
    const ok = { key: 'hub', baseURL: 'https://hub.example/v1', apiKey: 'sk-1' };
    expect(providerFormProblem(ok, { requireKey: true })).toBeNull();
    expect(providerFormProblem({ ...ok, key: ' ' }, { requireKey: true })).toMatch(/名称/);
    expect(providerFormProblem(ok, { requireKey: true, takenKeys: ['hub'] })).toMatch(/已存在/);
    // Editing an existing provider never re-checks the key.
    expect(providerFormProblem({ ...ok, key: '' })).toBeNull();
    expect(providerFormProblem({ ...ok, baseURL: '' })).toMatch(/Base URL/);
    expect(providerFormProblem({ ...ok, baseURL: 'hub.example/v1' })).toMatch(/http/);
    expect(providerFormProblem({ ...ok, apiKey: ' ' })).toMatch(/API Key/);
  });
});

describe('model form values', () => {
  const ok = { key: 'fast', provider: 'hub', name: 'gpt-x', contextWindowTokens: '128000', maxOutputTokens: '', temperature: '' };

  it('round-trips a models entry; optional request params stay absent when empty', () => {
    expect(modelFromForm(ok)).toEqual({ provider: 'hub', name: 'gpt-x', contextWindowTokens: 128000 });
    const full = { ...ok, maxOutputTokens: '8192', temperature: '0.3' };
    expect(modelFromForm(full)).toEqual({ provider: 'hub', name: 'gpt-x', contextWindowTokens: 128000, maxOutputTokens: 8192, temperature: 0.3 });
    expect(modelForm('fast', modelFromForm(full))).toEqual({ ...full, key: 'fast' });
    expect(emptyModelForm('hub')).toMatchObject({ provider: 'hub', contextWindowTokens: String(128 * 1024), maxOutputTokens: '', temperature: '' });
  });

  it('validates key, provider, name, and the three numeric fields', () => {
    expect(modelFormProblem(ok, { requireKey: true })).toBeNull();
    expect(modelFormProblem({ ...ok, key: '' }, { requireKey: true })).toMatch(/请填写名称/);
    expect(modelFormProblem(ok, { requireKey: true, takenKeys: ['fast'] })).toMatch(/名称「fast」已存在/);
    expect(modelFormProblem(ok, { requireKey: true, takenKeys: ['fast'] })).toMatch(/已存在/);
    expect(modelFormProblem({ ...ok, provider: '' })).toMatch(/provider/);
    expect(modelFormProblem({ ...ok, name: ' ' })).toMatch(/模型名/);
    expect(modelFormProblem({ ...ok, contextWindowTokens: '' }, { requireWindow: true })).toMatch(/上下文窗口/);
    expect(modelFormProblem({ ...ok, contextWindowTokens: '' })).toBeNull();
    expect(modelFormProblem({ ...ok, contextWindowTokens: '1.5' })).toMatch(/上下文窗口/);
    expect(modelFormProblem({ ...ok, maxOutputTokens: '0' })).toMatch(/最大输出/);
    expect(modelFormProblem({ ...ok, temperature: '2.5' })).toMatch(/温度/);
    expect(modelFormProblem({ ...ok, temperature: 'abc' })).toMatch(/温度/);
    expect(modelFormProblem({ ...ok, temperature: '2' })).toBeNull();
  });
});

describe('worker form values', () => {
  const claude: WorkerConfig = { type: 'claude-code', description: '编码', model: 'fast', maxTurns: 12, emoji: '🤖', capabilities: ['code', 'review'] };
  /** 落盘后的样子（值为 undefined 的键 JSON 会丢掉）。 */
  const persisted = (worker: WorkerConfig): unknown => JSON.parse(JSON.stringify(worker));

  it('round-trips a claude-code row over the fields its form shows; a model already on the row is left alone', () => {
    const values = workerForm(claude);
    expect(values).toMatchObject({ type: 'claude-code', description: '编码', maxTurns: '12', emoji: '🤖', capabilities: 'code, review' });
    // 表单不提供「指定模型」：行上已有的 model（比如来自 CLI 配置）保存时原样保留。
    expect(applyWorkerForm(claude, values)).toEqual(claude);
  });

  it('round-trips an acp row: args one per line, env KEY=VALUE one per line', () => {
    const acp: WorkerConfig = {
      type: 'acp',
      description: 'agent',
      command: 'my-agent',
      args: ['--acp', 'flag with space'],
      env: { A: '1', B: 'a=b' },
      permissionMode: 'agent',
      // 表单不展示的几项（一律用默认值）：读进表单的值里没有它们，保存时原样留着。
      trustUpdatesAfterCancel: true,
      mcp: { enabled: false, fallbackMs: 60_000 },
      protocol: { gatePermissions: false },
    };
    const values = workerForm(acp);
    expect(Object.keys(values).sort()).toEqual(
      ['args', 'capabilities', 'cliPath', 'command', 'description', 'emoji', 'env', 'maxTurns', 'permissionMode', 'type'],
    );
    expect(values).toMatchObject({ type: 'acp', command: 'my-agent', args: '--acp\nflag with space', env: 'A=1\nB=a=b', permissionMode: 'agent' });
    expect(applyWorkerForm(acp, values)).toEqual(acp);
  });

  it('writes only what the form shows; keys it does not show are left alone, and a new row gets no extra keys', () => {
    const opencode: WorkerConfig = { type: 'opencode', description: 'd', protocol: { handshakeMs: 20_000, gatePermissions: false }, mcp: { enabled: false } };
    // 协议超时、权限闸、MCP 注入表单都不展示：保存时原样保留（这几项一律用默认值，
    // 除非配置行上本来就写着别的）。
    expect(persisted(applyWorkerForm(opencode, workerForm(opencode)))).toEqual(opencode);
    // 新建一行：只写表单里填了的——MCP、回退、权限闸这些键不出现，走默认值。
    const fresh = applyWorkerForm({ type: 'codebuddy', description: '' }, { ...workerForm({ type: 'codebuddy', description: '' }), description: 'd' });
    expect(persisted(fresh)).toEqual({ type: 'codebuddy', description: 'd' });
    // 环境变量 / 启动参数：换行文本 → 数组 / 记录，空行丢掉，同名以最后一行为准。
    const typed = applyWorkerForm(
      { type: 'acp', description: 'd' },
      { ...workerForm({ type: 'acp', description: 'd' }), command: 'x', args: ' --acp \n\n--verbose ', env: 'A=1\nB=x=y\nA=2' },
    );
    expect(persisted(typed)).toEqual({ type: 'acp', description: 'd', command: 'x', args: ['--acp', '--verbose'], env: { A: '2', B: 'x=y' } });
  });

  it('switching type clears the fields the new type does not read', () => {
    const acp: WorkerConfig = {
      type: 'acp',
      description: 'agent',
      command: 'my-agent',
      args: ['--acp'],
      env: { A: '1' },
      permissionMode: 'agent',
      mcp: { enabled: false },
      trustUpdatesAfterCancel: true,
    };
    // acp → claude-code：command / args / env / permissionMode / mcp / trustUpdatesAfterCancel 清掉
    // （写在 claude-code 行上会被启动校验拒绝）。
    const toClaude = applyWorkerForm(acp, { ...workerForm(acp), type: 'claude-code', cliPath: '/bin/claude' });
    expect(persisted(toClaude)).toEqual({ type: 'claude-code', description: 'agent', cliPath: '/bin/claude' });
    // claude-code → codebuddy：cliPath / maxTurns / 模型引用 清掉；命令留空 = 用内置默认。
    const claudeRow: WorkerConfig = { type: 'claude-code', description: 'agent', model: 'fast', maxTurns: 5, cliPath: '/bin/claude' };
    const toCodebuddy = applyWorkerForm(claudeRow, { ...workerForm(claudeRow), type: 'codebuddy' });
    expect(persisted(toCodebuddy)).toEqual({ type: 'codebuddy', description: 'agent' });
  });

  it('refuses an invalid form instead of writing half a row', () => {
    const noDescription = { ...workerForm(claude), description: ' ' };
    expect(workerFormProblem(noDescription)).toMatch(/描述/);
    expect(() => applyWorkerForm(claude, noDescription)).toThrow(/描述/);
    const acpNoCommand = { ...workerForm({ type: 'acp', description: 'd' }), command: '' };
    expect(workerFormProblem(acpNoCommand)).toMatch(/可执行命令/);
    expect(workerFormProblem({ ...workerForm(claude), maxTurns: 'x' })).toMatch(/Max turns/);
    const acp = workerForm({ type: 'acp', description: 'd', command: 'x' });
    expect(workerFormProblem({ ...acp, env: 'FOO' })).toMatch(/KEY=VALUE/);
    expect(() => applyWorkerForm({ type: 'acp', description: 'd', command: 'x' }, { ...acp, env: 'A=1\nbroken' })).toThrow(/「broken」/);
  });

  it('validates only the current type’s fields', () => {
    // 另一类字段的残留草稿（比如切过类型又切回来）不参与校验。
    expect(workerFormProblem({ ...workerForm({ type: 'claude-code', description: 'd' }), command: '', env: 'broken' })).toBeNull();
    expect(workerFormProblem({ ...workerForm({ type: 'codebuddy', description: 'd' }), maxTurns: 'x' })).toBeNull();
  });
});

describe('puppet defaults form values', () => {
  const config: WayangConfig = {
    providers: {},
    models: {},
    controller: {},
    worker: { maxConcurrency: 3, maxTurns: 12, toolChoice: 'auto' },
  };

  it('round-trips worker defaults; empty maxTurns / unset toolChoice are removed', () => {
    expect(puppetDefaultsForm(config.worker)).toEqual({ maxConcurrency: '3', maxTurns: '12', toolChoice: 'auto' });
    const next = applyPuppetDefaultsForm(config, { maxConcurrency: '5', maxTurns: '', toolChoice: '__unset__' });
    expect(next.worker).toEqual({ maxConcurrency: 5, maxTurns: undefined, toolChoice: undefined });
    expect(JSON.parse(JSON.stringify(next.worker))).toEqual({ maxConcurrency: 5 });
    expect(puppetDefaultsForm(undefined)).toEqual({ maxConcurrency: '', maxTurns: '', toolChoice: '__unset__' });
  });

  it('validates both numbers', () => {
    expect(puppetDefaultsFormProblem({ maxConcurrency: '3', maxTurns: '', toolChoice: 'auto' })).toBeNull();
    expect(puppetDefaultsFormProblem({ maxConcurrency: '', maxTurns: '', toolChoice: 'auto' })).toMatch(/最大并发/);
    expect(puppetDefaultsFormProblem({ maxConcurrency: '2.5', maxTurns: '', toolChoice: 'auto' })).toMatch(/最大并发/);
    expect(puppetDefaultsFormProblem({ maxConcurrency: '3', maxTurns: '0', toolChoice: 'auto' })).toMatch(/Max turns/);
    expect(() => applyPuppetDefaultsForm(config, { maxConcurrency: '', maxTurns: '', toolChoice: 'auto' })).toThrow(/最大并发/);
  });
});

/* ------------------------------ 组件 ------------------------------ */

describe('FormField', () => {
  it('associates the label with the control and shows the hint', () => {
    render(<FormField label="Base URL" hint="OpenAI 兼容接口地址">{(id) => <input id={id} />}</FormField>);
    expect(labels()).toEqual(['Base URL']);
    expect(controlFor('Base URL')).toBeInstanceOf(HTMLInputElement);
    expect(container!.textContent).toContain('OpenAI 兼容接口地址');
  });
});

describe('SecretInput / 只读密钥字段', () => {
  it('the input masks by default, the eye toggles plaintext, typing reports back', () => {
    const onChange = vi.fn();
    render(<ProviderForm value={{ key: '', baseURL: '', apiKey: 'sk-secret' }} onChange={onChange} />);
    const input = inputFor('API Key');
    expect(input.type).toBe('password');
    expect(container!.textContent).not.toContain('sk-secret');
    // 显隐开关的状态看 aria-pressed（不看按钮文案）。
    const eye = queryByTestId('secret-reveal', container!);
    expect(eye?.getAttribute('aria-pressed')).toBe('false');
    click(eye!);
    expect(input.type).toBe('text');
    expect(eye?.getAttribute('aria-pressed')).toBe('true');
    typeInto(input, 'sk-next');
    expect(onChange).toHaveBeenCalledWith({ key: '', baseURL: '', apiKey: 'sk-next' });
  });

  it('hides the eye while the value is empty (nothing to reveal)', () => {
    render(<ProviderForm value={{ key: '', baseURL: '', apiKey: '' }} onChange={() => undefined} />);
    expect(queryByTestId('secret-reveal', container!)).toBeNull();
  });

  it('the read-only secret masks by default; the eye sits in the label row so its position never moves', () => {
    render(<ReadonlySecretField label="API Key" value="sk-secret" />);
    expect(container!.textContent).toContain('••••••••');
    expect(container!.textContent).not.toContain('sk-secret');
    // 眼睛在标签行里（跟标签同一行），不跟在值后面——值长短不影响它的位置。
    const eye = byTestId('secret-reveal', container!);
    expect(eye.parentElement?.querySelector('label')).not.toBeNull();
    expect(eye.parentElement?.textContent).not.toContain('••••••••');
    click(eye);
    expect(container!.textContent).toContain('sk-secret');
    expect(eye.getAttribute('aria-pressed')).toBe('true');
  });

  it('the read-only secret shows a dash and no eye when empty', () => {
    render(<ReadonlySecretField label="API Key" value="" />);
    expect(container!.textContent).toBe('API Key—');
    expect(container!.querySelector('button')).toBeNull();
  });

  it('the read-only field gives the value an input-sized row and a larger font', () => {
    render(
      <ReadonlyField label="Base URL">
        <span className="break-all text-base">https://api.example.com/v1</span>
      </ReadonlyField>,
    );
    expect(labels()).toEqual(['Base URL']);
    // 标签行固定 24px、值一行至少 36px（与输入框等高）：只读态不挤成两行小字。
    expect(container!.querySelector('.h-6')?.textContent).toBe('Base URL');
    expect(container!.querySelector('.min-h-9')?.textContent).toBe('https://api.example.com/v1');
    expect(container!.querySelector('.text-base')?.textContent).toBe('https://api.example.com/v1');
  });
});

describe('ProviderForm', () => {
  it('stacks 名称 (only when editable) / Base URL / API Key, each on its own line', () => {
    render(<ProviderForm keyEditable value={{ key: 'hub', baseURL: 'https://h/v1', apiKey: 'k' }} onChange={() => undefined} />);
    expect(labels()).toEqual(['名称', 'Base URL', 'API Key']);
    expect(inputFor('Base URL').value).toBe('https://h/v1');
    act(() => root!.unmount());
    root = createRoot(container!);
    render(<ProviderForm value={{ key: 'hub', baseURL: 'https://h/v1', apiKey: 'k' }} onChange={() => undefined} />);
    expect(labels()).toEqual(['Base URL', 'API Key']);
  });
});

describe('ModelForm', () => {
  it('shows the provider select only when providers are given, and reports the choice', () => {
    const onChange = vi.fn();
    render(<ModelForm keyEditable providers={['hub', 'other']} value={emptyModelForm('hub')} onChange={onChange} />);
    expect(labels()).toEqual(['名称', 'Provider', '模型名', '上下文窗口（tokens）', '最大输出 tokens', '温度']);
    expect(selectFor('Provider').value).toBe('hub');
    choose(selectFor('Provider'), 'other');
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ provider: 'other' }));
    act(() => root!.unmount());
    root = createRoot(container!);
    render(<ModelForm value={emptyModelForm('hub')} onChange={() => undefined} />);
    expect(labels()).not.toContain('Provider');
  });
});

describe('ModelBindingSelect', () => {
  const config: WayangConfig = {
    providers: { hub: { apiKey: 'k' } },
    models: { fast: { provider: 'hub', name: 'a' }, smart: { provider: 'hub', name: 'b' } },
    controller: {},
    worker: { maxConcurrency: 1 },
  };

  it('lists the models entries and reports the chosen key', () => {
    const onChange = vi.fn();
    // 用法同设置页 / 向导：放在 FormField 的渲染函数里，把字段 id 传给下拉。
    render(
      <FormField label="Controller 模型">
        {(id) => <ModelBindingSelect id={id} config={config} value="fast" onChange={onChange} />}
      </FormField>,
    );
    const select = selectFor('Controller 模型');
    // provider 做成胶囊标签在前、模型名称在后（胶囊与名称之间留一个空格，读屏不会连读成一个词）。
    expect(Array.from(select.querySelectorAll('option')).map((o) => o.textContent)).toEqual(['', 'hub fast', 'hub smart']);
    expect(select.value).toBe('fast');
    choose(select, 'smart');
    expect(onChange).toHaveBeenCalledWith('smart');
  });

  it('an「不指定」option reports undefined; without it an unbound value is just the placeholder', () => {
    const onChange = vi.fn();
    render(<ModelBindingSelect config={config} value={undefined} allowUnset onChange={onChange} />);
    choose(container!.querySelector('select')!, '__unset__');
    expect(onChange).toHaveBeenCalledWith(undefined);
    act(() => root!.unmount());
    root = createRoot(container!);
    render(<ModelBindingSelect config={config} value={undefined} onChange={onChange} />);
    expect(container!.querySelector('select')!.value).toBe('');
    expect(container!.textContent).not.toContain('不指定');
  });

  it('keeps a non-entry reference (composite / inline) selectable as「现状」instead of dropping it', () => {
    const onChange = vi.fn();
    render(<ModelBindingSelect config={config} value="hub/composite-x" onChange={onChange} />);
    const select = container!.querySelector('select')!;
    expect(select.value).toBe('__current__');
    expect(container!.textContent).toContain('组合引用');
    expect(select.textContent).toContain('hub composite-x');
    choose(select, '__current__');
    expect(onChange).toHaveBeenCalledWith('hub/composite-x');
    expect(onChange).not.toHaveBeenCalledWith(undefined);
  });
});

describe('WorkerForm', () => {
  const BASE_LABELS = ['类型', '能力标签', '描述'];
  // 三种 ACP 类型的字段完全一样：MCP 注入、空闲回退、取消后保留迟到的结果、接管权限审批不再让配。
  const ACP_LABELS = [...BASE_LABELS, '可执行命令', '权限模式', '启动参数', '环境变量'];

  it('every type shares 类型 / 能力标签 / 描述; 描述 is a textarea and typing reports back', () => {
    const onChange = vi.fn();
    render(<WorkerForm value={workerForm({ type: 'claude-code', description: '写代码' })} onChange={onChange} />);
    expect(labels().slice(0, 3)).toEqual(BASE_LABELS);
    const description = textareaFor('描述');
    expect(description.value).toBe('写代码');
    typeIntoTextarea(description, '写代码\n也能 review');
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ description: '写代码\n也能 review' }));
  });

  it('claude-code shows only Max turns / CLI 路径 — there is no way to pick a model', () => {
    render(<WorkerForm value={workerForm({ type: 'claude-code', description: 'd' })} onChange={() => undefined} />);
    expect(labels()).toEqual([...BASE_LABELS, 'Max turns', 'CLI 路径']);
  });

  it('switching 类型 reports the new type; acp swaps in its launch / permission / MCP fields', () => {
    const onChange = vi.fn();
    render(<WorkerForm value={workerForm({ type: 'claude-code', description: 'd' })} onChange={onChange} />);
    choose(selectFor('类型'), 'acp');
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ type: 'acp' }));
    act(() => root!.unmount());
    root = createRoot(container!);
    render(<WorkerForm value={workerForm({ type: 'acp', description: 'd', command: 'x', env: { A: '1' } })} onChange={() => undefined} />);
    expect(labels()).toEqual(ACP_LABELS);
    expect(textareaFor('环境变量').value).toBe('A=1');
  });

  it('codebuddy and opencode show exactly the same fields as the generic acp — no type-only switches', () => {
    for (const type of ['codebuddy', 'opencode'] as const) {
      act(() => root!.unmount());
      root = createRoot(container!);
      render(<WorkerForm value={workerForm({ type, description: 'd' })} onChange={() => undefined} />);
      expect(labels()).toEqual(ACP_LABELS);
    }
  });
});

describe('PuppetDefaultsForm', () => {
  it('renders the three defaults and reports edits', () => {
    const onChange = vi.fn();
    render(<PuppetDefaultsForm value={{ maxConcurrency: '3', maxTurns: '', toolChoice: '__unset__' }} onChange={onChange} />);
    expect(labels()).toEqual(['最大并发', 'Max turns', 'Tool choice']);
    expect(inputFor('最大并发').value).toBe('3');
    typeInto(inputFor('最大并发'), '6');
    expect(onChange).toHaveBeenCalledWith({ maxConcurrency: '6', maxTurns: '', toolChoice: '__unset__' });
    choose(selectFor('Tool choice'), 'required');
    expect(onChange).toHaveBeenCalledWith({ maxConcurrency: '3', maxTurns: '', toolChoice: 'required' });
  });
});
