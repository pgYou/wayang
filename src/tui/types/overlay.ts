import type { ReactNode } from 'react';

/**
 * Overlay model — unifies text output and interactive components
 * displayed between ChatArea and InputArea.
 */
export type Overlay =
  | { kind: 'text'; content: string; hint?: string }
  | { kind: 'component'; render: () => ReactNode; hint?: string };
