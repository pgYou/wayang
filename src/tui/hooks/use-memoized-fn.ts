import { useRef, useCallback } from 'react';

/**
 * Returns a memoized version of the callback whose reference never changes.
 * Drop-in replacement for ahooks' useMemoizedFn — avoids pulling in react-dom peer dep.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useMemoizedFn<T extends (...args: any[]) => any>(fn: T): T {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const memoized = useCallback((...args: any[]) => fnRef.current(...args), []);
  return memoized as T;
}
