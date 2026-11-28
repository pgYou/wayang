import type { WayangConfig } from '@wayang-ai/protocol';

const SUMMARY_ROW = 'rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs';

/**
 * 配置全量展示——onboard 最终确认页用：确认写入前把草稿里的每一项都摆出来。
 * 密钥只显示「已设置 / 缺失」，不显示值；第三方 worker 的环境变量同理不展开。
 */
export function ConfigSummary({ config }: { config: WayangConfig }) {
  const providers = Object.entries(config.providers ?? {});
  const models = Object.entries(config.models ?? {});
  const workers = Object.entries(config.workers ?? {});
  const binding = (ref: unknown): string =>
    typeof ref === 'string' ? ref : ref === undefined ? '（未绑定）' : JSON.stringify(ref);
  // worker 这一行带上 puppet 默认参数：并发数一定显示，轮数上限与工具模式设了才显示。
  const workerDefaults = [`maxConcurrency ${config.worker?.maxConcurrency ?? 3}`];
  if (config.worker?.maxTurns !== undefined) workerDefaults.push(`maxTurns ${config.worker.maxTurns}`);
  if (config.worker?.toolChoice !== undefined) workerDefaults.push(`toolChoice ${config.worker.toolChoice}`);
  return (
    <div className="flex flex-col gap-3 text-sm">
      <section className="flex flex-col gap-1">
        <h3 className="font-medium">Providers（{providers.length}）</h3>
        {providers.length === 0 && <p className="text-xs text-destructive">无 provider</p>}
        {providers.map(([key, p]) => (
          <div key={key} className={SUMMARY_ROW}>
            {key}: {p.baseURL ?? '?'} · apiKey {p.apiKey ? '已设置' : '缺失'}
          </div>
        ))}
      </section>
      <section className="flex flex-col gap-1">
        <h3 className="font-medium">Models（{models.length}）</h3>
        {models.map(([key, m]) => (
          <div key={key} className={SUMMARY_ROW}>
            {key}: {m.provider} / {m.name}
            {m.contextWindowTokens ? ` · ${m.contextWindowTokens} tokens` : ''}
          </div>
        ))}
      </section>
      <section className="flex flex-col gap-1">
        <h3 className="font-medium">绑定</h3>
        <div className={SUMMARY_ROW}>controller: {binding(config.controller?.model)}</div>
        <div className={SUMMARY_ROW}>
          worker: {binding(config.worker?.model)} · {workerDefaults.join(' · ')}
        </div>
      </section>
      {workers.length > 0 && (
        <section className="flex flex-col gap-1">
          <h3 className="font-medium">第三方 Worker（{workers.length}）</h3>
          {workers.map(([key, w]) => (
            <div key={key} className={SUMMARY_ROW}>
              {key}: {w.type}
              {w.enable === false ? '（已停用）' : ''}
              {w.description ? ` · ${w.description}` : ''}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
