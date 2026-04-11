import { useState, useEffect } from 'react';
import { useMemoizedFn } from './use-memoized-fn';
import type { BaseWayangState, StateEvent } from '@/infra/state/base-state';

/**
 * Subscribe to state changes on a BaseWayangState path.
 * Re-renders when the subscribed path changes.
 */
export function useWayangState<T>(state: BaseWayangState, path: string): T {
  const [value, setValue] = useState<T>(() => state.get<T>(path));

  useEffect(() => {
    const unSub = state.on(path, (_event: StateEvent) => {
      setValue(state.get<T>(path));
    });
    // Sync initial value
    setValue(state.get<T>(path));
    return unSub;
  }, [state, path]);

  return value;
}

/**
 * Returns a stable callback to read the latest state value.
 */
export function useWayangGetter<T>(state: BaseWayangState, path: string): () => T {
  return useMemoizedFn(() => state.get<T>(path));
}
