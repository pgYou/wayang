import { useEffect, useState } from 'react';
import { wayang } from '@/renderer/shared/lib/wayang-api';
import { wayangStore } from '@/renderer/shared/lib/store';
import { router, useRoute } from '@/renderer/shared/lib/router';
import { ChatPage } from './pages/chat/chat-page';
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
        if (!state.onboarded) router.replace('/onboard', { problem: state.problem });
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

  switch (route.path) {
    case '/onboard':
      return (
        <OnboardFlow
          problem={typeof route.params.problem === 'string' ? route.params.problem : undefined}
          onFinished={() => router.replace('/chat')}
        />
      );
    case '/settings':
      return <SettingsPage onClose={() => router.back()} />;
    default:
      return <ChatPage key={route.key} />;
  }
}
