import { useEffect, useState, type ReactNode } from 'react';
import type { WayangConfig } from '@wayang-ai/protocol';
import { wayang } from '@/renderer/shared/lib/wayang-api';
import { wayangStore } from '@/renderer/shared/lib/store';
import { router, useRoute } from '@/renderer/shared/lib/router';
import { ChatPage } from './pages/chat/chat-page';
import { Toaster } from '@/renderer/shared/components/ui/sonner';
import { OnboardFlow } from './pages/onboard/onboard-flow';
import { SettingsPage } from './pages/settings/settings-page';

/**
 * App root — 全局初始化与路由表（不承载页面内部逻辑）：
 * - boot：onboard state 决定初始路由（首启 → /onboard，否则留在 /chat）；
 * - store boot 序列在进入主界面路由后启动一次；
 * - 路由表是全局唯一页面分发点，页面跳转经 lib/router 单例。
 */
export function App() {
  const route = useRoute();
  // 初始化门控：onboard state 拉取完成前显示启动态（属于全局初始化，不属于任何页面）。
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    void wayang
      .getOnboardState()
      .then((state) => {
        // 磁盘上有「结构合法但必要核心不完整」的配置时一并带过去，欢迎页
        // 据此提供「修改现有配置」。
        if (!state.onboarded) router.replace('/onboard', { problem: state.problem, config: state.config, hasCliConfig: state.hasCliConfig === true });
      })
      .catch((err: unknown) => {
        // The state channel itself failed (not the envelope): the main UI's
        // own boot retries and surfaces the real status.
        void wayang.rendererLog({
          level: 'warn',
          message: `onboard state check failed: ${err instanceof Error ? err.message : String(err)}`,
        }).catch(() => undefined);
      })
      .finally(() => setBooted(true));
  }, []);

  // Fixed boot sequence: snapshot first, then incremental subscription —
  // started once the main UI is reachable; after onboarding finishes, the save
  // already booted the server, so the retry loop converges on ready.
  useEffect(() => {
    if (route.path === '/onboard' || !booted) return;
    void wayangStore.boot().then(() => {
      void wayang.rendererLog({ level: 'info', message: 'renderer store hydrated' }).catch(() => undefined);
    });
  }, [route.path, booted]);

  if (!booted) {
    return (
      <div className="flex h-full items-center justify-center bg-background text-sm text-muted-foreground">
        启动中…
      </div>
    );
  }

  let page: ReactNode;
  switch (route.path) {
    case '/onboard': {
      // 路由 params 是 unknown：只认「看起来像配置对象」的值。
      const raw = route.params.config;
      const existingConfig = typeof raw === 'object' && raw !== null ? (raw as WayangConfig) : undefined;
      page = (
        <OnboardFlow
          problem={typeof route.params.problem === 'string' ? route.params.problem : undefined}
          existingConfig={existingConfig}
          hasCliConfig={route.params.hasCliConfig === true}
          onFinished={() => router.replace('/chat')}
        />
      );
      break;
    }
    case '/settings':
      page = <SettingsPage onClose={() => router.back()} />;
      break;
    default:
      page = <ChatPage key={route.key} />;
  }

  return (
    <>
      {page}
      {/* 全应用的 toast 宿主：挂在根上一次，各页面只管调 toast()。 */}
      <Toaster />
    </>
  );
}
