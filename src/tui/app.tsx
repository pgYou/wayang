import { useRef } from 'react';
import { useMemoizedFn } from './hooks/use-memoized-fn';
import { Box, useApp, useInput } from 'ink';
import { SupervisorProvider, useSupervisor } from './providers/supervisor-provider';
import { ControllerPage } from './pages/controller-page';
import { useWayangState } from './hooks/use-wayang-state';

export function App({ supervisor }: { supervisor: import('@/client/remote-supervisor').RemoteSupervisor }) {
  return (
    <SupervisorProvider supervisor={supervisor}>
      <AppContent />
    </SupervisorProvider>
  );
}

function AppContent() {
  const { exit } = useApp();
  const supervisor = useSupervisor();
  const busy = useWayangState<boolean>(supervisor.controllerAgent, 'dynamicState.busy') ?? false;
  const lastCtrlC = useRef<number>(0);

  const handleExit = useMemoizedFn(() => {
    exit();
  });

  // Global keybindings
  useInput((_ch, key) => {
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
      <ControllerPage onExit={handleExit} />
    </Box>
  );
}
