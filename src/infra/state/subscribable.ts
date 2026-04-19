import type { StateEvent } from './base-state';

/**
 * Public subscription interface exposed by domain objects.
 * UI layer subscribes via this interface — never touches internal state directly.
 */
export interface Subscribable {
  /** Subscribe to changes at a state path. Returns unsubscribe function. */
  subscribe(path: string, callback: (event: StateEvent) => void): () => void;
  /** Read the current value at a state path. */
  getSnapshot<T>(path: string): T;
}
