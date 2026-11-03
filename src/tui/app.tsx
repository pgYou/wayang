import { useEffect, useRef, useState } from 'react';
import { useMemoizedFn } from './hooks/use-memoized-fn';
import { Box, Text, useApp, useInput } from 'ink';
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
  // Visible feedback for the armed (first) Ctrl+C — without it the swallowed
  // keypress is indistinguishable from an ignored one.
  const [ctrlCNotice, setCtrlCNotice] = useState(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hideCtrlCNotice = useMemoizedFn(() => {
    if (noticeTimer.current !== null) {
      clearTimeout(noticeTimer.current);
      noticeTimer.current = null;
    }
    setCtrlCNotice(false);
  });

  // Drop a pending notice timer when the app goes away (double-press exit, …).
  useEffect(() => () => {
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
  }, []);

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
        hideCtrlCNotice();
        supervisor.shutdown().then(() => exit());
      } else {
        lastCtrlC.current = now;
        // Show the notice for exactly as long as the double-press window is
        // armed; it disappears when the window expires.
        setCtrlCNotice(true);
        if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
        noticeTimer.current = setTimeout(hideCtrlCNotice, 1000);
      }
      return;
    }

    // Any other key dismisses the notice. Display-only: it does NOT reset the
    // double-press window — only Ctrl+C writes the timestamp.
    if (ctrlCNotice) hideCtrlCNotice();
  });

  return (
    <Box flexDirection="column">
      <ControllerPage onExit={handleExit} />
      {ctrlCNotice && (
        <Text color="yellow">Press Ctrl+C again to quit</Text>
      )}
    </Box>
  );
}
