import { useState, useEffect } from 'react';
import { useMemoizedFn } from './use-memoized-fn';
import type { Subscribable } from '@/infra/state/subscribable';

/**
 * Subscribe to state changes on a Subscribable source.
 * Re-renders when the subscribed path changes.
 */
export function useWayangState<T>(source: Subscribable, path: string): T {
  const [value, setValue] = useState<T>(() => source.getSnapshot<T>(path));

  useEffect(() => {
    const unSub = source.subscribe(path, () => {
      setValue(source.getSnapshot<T>(path));
    });
    // Sync initial value
    setValue(source.getSnapshot<T>(path));
    return unSub;
  }, [source, path]);

  return value;
}

/**
 * Returns a stable callback to read the latest state value.
 */
export function useWayangGetter<T>(source: Subscribable, path: string): () => T {
  return useMemoizedFn(() => source.getSnapshot<T>(path));
}
