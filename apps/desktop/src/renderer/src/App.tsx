import { useCallback, useEffect, useState } from 'react';
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
import { InputArea } from './components/input-area';
import { InquiryCard } from './components/inquiry-card';
import { StatusBar } from './components/status-bar';
import { OnboardFlow } from './components/onboard/onboard-flow';

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
        <InputArea
          busy={busy}
          onSubmit={(text) => void wayang.sendInput(text)}
          onAbort={() => void wayang.abort()}
        />
      )}

      <StatusBar
        busy={busy}
        activeWorkers={activeWorkers}
        tasks={tasks}
        contextUsage={contextUsage}
        connection={connection}
      />
    </div>
  );
}
