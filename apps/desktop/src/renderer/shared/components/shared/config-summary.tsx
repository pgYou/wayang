import type { WayangConfig } from '@wayang-ai/protocol';

/**
 * 配置全量展示——onboard 最终确认页与设置页
 * 共用的跨页面组件，因此放 components/shared（不属于任何单一页面）。
 */
export function ConfigSummary({ config }: { config: WayangConfig }) {
  const providers = Object.entries(config.providers ?? {});
  const models = Object.entries(config.models ?? {});
  const binding = (ref: unknown): string =>
    typeof ref === 'string' ? ref : ref === undefined ? '（未绑定）' : JSON.stringify(ref);
  return (
    <div className="flex flex-col gap-3 text-sm">
      <section className="flex flex-col gap-1">
        <h3 className="font-medium">Providers（{providers.length}）</h3>
        {providers.length === 0 && <p className="text-xs text-destructive">无 provider</p>}
        {providers.map(([key, p]) => (
          <div key={key} className="rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs">
            {key}: {p.baseURL ?? p.endpoint ?? '?'} · apiKey {p.apiKey ? '已设置' : '缺失'}
          </div>
        ))}
      </section>
      <section className="flex flex-col gap-1">
        <h3 className="font-medium">Models（{models.length}）</h3>
        {models.map(([key, m]) => (
          <div key={key} className="rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs">
            {key}: {m.provider} / {m.name}
            {m.contextWindowTokens ? ` · ${m.contextWindowTokens} tokens` : ''}
          </div>
        ))}
      </section>
      <section className="flex flex-col gap-1">
        <h3 className="font-medium">绑定</h3>
        <div className="rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs">
          controller: {binding(config.controller?.model)}
          {config.controller?.provider ? `（legacy provider ${config.controller.provider}）` : ''}
        </div>
        <div className="rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs">
          worker: {binding(config.worker?.model)} · maxConcurrency {config.worker?.maxConcurrency ?? 3}
        </div>
      </section>
    </div>
  );
}
