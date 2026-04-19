import { useRef } from 'react';
import { useMemoizedFn } from './hooks/use-memoized-fn';
import { Box, useApp, useInput } from 'ink';
import { SupervisorProvider, useSupervisor } from './providers/supervisor-provider';
import { RouteProvider, useRouter } from './providers/route-provider';
import { ControllerPage } from './pages/controller-page';
import { WorkerDetailPage } from './pages/worker-detail-page';
import { useWayangState } from './hooks/use-wayang-state';
import type { Supervisor } from '@/services/supervisor';

export function App({ supervisor }: { supervisor: Supervisor }) {
  return (
    <SupervisorProvider supervisor={supervisor}>
      <RouteProvider>
        <AppContent />
      </RouteProvider>
    </SupervisorProvider>
  );
}

function AppContent() {
  const { exit } = useApp();
  const supervisor = useSupervisor();
  const { route, navigate } = useRouter();
  const busy = useWayangState<boolean>(supervisor.controllerAgent, 'dynamicState.busy') ?? false;
  const lastCtrlC = useRef<number>(0);

  const handleExit = useMemoizedFn(() => {
    exit();
  });

  // Global keybindings
  useInput((_ch, key) => {
    if (key.escape && route.page === 'worker') {
      navigate({ page: 'controller' });
    }

    // Ctrl+C handling
    if (key.ctrl && _ch === 'c') {
      if (busy) {
        // Abort current LLM response
        supervisor.controllerAgent.abort();
        return;
      }

      const now = Date.now();
      if (lastCtrlC.current && now - lastCtrlC.current < 1000) {
        // Double Ctrl+C → exit
        supervisor.shutdown().then(() => exit());
      } else {
        lastCtrlC.current = now;
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Box display={route.page === 'controller' ? 'flex' : 'none'} flexDirection="column">
        <ControllerPage onExit={handleExit} />
      </Box>
      {route.page === 'worker' && (
        <WorkerDetailPage workerId={route.workerId} onBack={() => navigate({ page: 'controller' })} />
      )}
    </Box>
  );
}
