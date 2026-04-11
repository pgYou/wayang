import { useState, useEffect } from 'react';
import { Text } from 'ink';
import { theme } from '@/tui/theme';

/** Animated spinner prefix for streaming assistant messages. */
export function StreamingSpinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % theme.spinner.frames.length);
    }, theme.spinner.interval);
    return () => clearInterval(timer);
  }, []);

  return <Text color={theme.assistant.prefixColor} bold>{theme.spinner.frames[frame]}{' '}</Text>;
}
