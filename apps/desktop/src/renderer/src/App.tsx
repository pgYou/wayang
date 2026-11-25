import { useCallback, useEffect, useState } from 'react';
import { Settings2Icon } from 'lucide-react';
import {
  useConnectionStatus,
  useBusy,
  usePendingInquiry,
  useContextUsage,
  useActiveWorkers,
  useTasks,
  wayangStore,
} from './lib/store';
import { wayang } from './lib/wayang-api';
import { ChatArea } from './components/chat/chat-area';
import { Composer } from './components/chat/composer';
import { InquiryCard } from './components/inquiry-card';
import { OnboardFlow } from './components/onboard/onboard-flow';
import { SettingsPage } from './components/settings/settings-page';
import { SessionMenu } from './components/session-menu';
import { Button } from './components/ui/button';

/**
 * App root. Boot routing (§2.11 决策九, cold-start detection): the envelope
 * state decides between the welcome/onboarding flow and the main UI. The
 * store boot sequence (§2.7: snapshot first, then subscription) starts only
 * once the main UI is reachable — in onboard mode there is no server to pull.
 */
type AppPhase = 'checking' | 'onboard' | 'app';

export function App() {
  const [phase, setPhase] = useState<AppPhase>('checking');
  const [onboardProblem, setOnboardProblem] = useState<string | undefined>(undefined);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    void wayang
      .getOnboardState()
      .then((state) => {
        setOnboardProblem(state.problem);
        setPhase(state.onboarded ? 'app' : 'onboard');
      })
      .catch((err: unknown) => {
        setOnboardProblem(err instanceof Error ? err.message : String(err));
        // The state channel itself failed (not the envelope): the main UI's
        // own boot retries and surfaces the real status.
        setPhase('app');
      });
  }, []);

  // Fixed boot sequence (§2.7): snapshot first, then incremental
  // subscription — the first-paint race (a4) dissolves here. Started only in
  // the main-UI phase; after onboarding finishes, the save already booted the
  // server, so the retry loop converges on ready.
  useEffect(() => {
    if (phase !== 'app') return;
    void wayangStore.boot().then(() => {
      void wayang.rendererLog({ level: 'info', message: 'renderer store hydrated' }).catch(() => undefined);
    });
  }, [phase]);

  const onOnboardFinished = useCallback(() => setPhase('app'), []);

  // Per-slice subscriptions: a streaming update re-renders only the
  // streaming section inside ChatArea, never this tree.
  const busy = useBusy();
  const pendingInquiry = usePendingInquiry();
  const contextUsage = useContextUsage();
  const activeWorkers = useActiveWorkers();
  const tasks = useTasks();
  const connection = useConnectionStatus();

  if (phase === 'checking') {
    return <div className="flex h-full items-center justify-center bg-background text-sm text-muted-foreground">启动中…</div>;
  }

  if (phase === 'onboard') {
    return <OnboardFlow problem={onboardProblem} onFinished={onOnboardFinished} />;
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-border bg-card/80 px-4 py-2">
        <span className="flex size-6 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
          W
        </span>
        <span className="text-sm font-semibold">Wayang</span>
        <span className="text-xs text-muted-foreground">多智能体编排工作台</span>
        {/* Header 右上角：设置入口（settings-2）+ 会话切换【…】（§4.3 工作项②⑥） */}
        <span className="ml-auto flex items-center gap-1">
          <Button size="icon-sm" variant="ghost" aria-label="打开设置" onClick={() => setSettingsOpen(true)}>
            <Settings2Icon />
          </Button>
          <SessionMenu disabled={busy} />
        </span>
      </header>

      {connection.phase === 'crashed' && (
        <div className="border-b border-destructive/30 bg-destructive-soft px-4 py-2 text-xs text-destructive">
          {connection.detail ?? 'server 已退出'}
        </div>
      )}

      <ChatArea busy={busy} />

      {pendingInquiry ? (
        <InquiryCard inquiry={pendingInquiry} onAnswer={(answer) => void wayang.answerInquiry(answer)} />
      ) : (
        <Composer
          busy={busy}
          connection={connection}
          activeWorkers={activeWorkers}
          tasks={tasks}
          contextUsage={contextUsage}
          onSubmit={(text) => void wayang.sendInput(text)}
          onAbort={() => void wayang.abort()}
        />
      )}
      {settingsOpen && <SettingsPage onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
