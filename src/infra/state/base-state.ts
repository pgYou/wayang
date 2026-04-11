import { get, set, cloneDeep } from 'lodash-es';
import type { StateEvent } from '@/types/index';
import type { IPersistenceHelper } from './persistence/types';

export type { StateEvent };

// --- Persistence Mapping ---

export interface PersistMapping {
  /** Top-level key in data */
  path: string;
  helper: IPersistenceHelper;
}

// --- BaseWayangState ---

export abstract class BaseWayangState {
  protected data: Record<string, any>;
  private persistMappings: PersistMapping[];
  private subscriptions = new Map<string, Set<(event: StateEvent) => void>>();

  constructor(
    initialData: Record<string, any>,
    persistMappings: PersistMapping[] = [],
  ) {
    this.data = initialData;
    this.persistMappings = persistMappings;
  }

  // --- Read ---

  get<T = any>(path: string): T {
    return get(this.data, path);
  }

  // --- Write operations ---

  set(path: string, value: unknown): void {
    const prev = get(this.data, path);
    set(this.data, path, value);
    this.persist(path);
    this.notify(path, 'set', prev);
  }

  update(path: string, partial: Record<string, any>): void {
    const prev = cloneDeep(get(this.data, path));
    const target = get(this.data, path);
    if (target && typeof target === 'object') {
      Object.assign(target, partial);
    } else {
      set(this.data, path, partial);
    }
    this.persist(path);
    this.notify(path, 'update', prev);
  }

  append(path: string, entry: unknown): void {
    const arr = get(this.data, path);
    if (!Array.isArray(arr)) {
      throw new Error(`State.append: path "${path}" is not an array`);
    }
    arr.push(entry);
    // Replace with new array reference so React detects the change
    set(this.data, path, [...arr]);
    this.persist(path);
    this.notify(path, 'append', undefined);
  }

  remove(path: string, idx?: number): void {
    const arr = get(this.data, path);
    if (!Array.isArray(arr)) {
      throw new Error(`State.remove: path "${path}" is not an array`);
    }
    const prev = idx !== undefined ? arr[idx] : arr[arr.length - 1];
    if (idx === undefined) {
      arr.pop();
    } else {
      arr.splice(idx, 1);
    }
    this.persist(path);
    this.notify(path, 'remove', prev);
  }

  // --- Subscription ---

  on(path: string, callback: (event: StateEvent) => void): () => void {
    if (!this.subscriptions.has(path)) {
      this.subscriptions.set(path, new Set());
    }
    this.subscriptions.get(path)!.add(callback);
    return () => this.subscriptions.get(path)?.delete(callback);
  }

  // --- Restore (abstract) ---

  abstract restore(): Promise<void>;

  // --- Persistence ---

  private persist(path: string): void {
    const topKey = path.split('.')[0];
    for (const mapping of this.persistMappings) {
      if (mapping.path !== topKey) continue;

      if (mapping.helper.mode === 'save') {
        // JSON: full overwrite for this top-level key
        mapping.helper.write(this.data[topKey]);
      } else if (mapping.helper.mode === 'append') {
        // JSONL: only written on append operations
        // set/remove only update memory; callers should use append for JSONL data
      }
    }
  }

  /** Append-mode persistence for subclasses to call directly. */
  protected persistAppend(path: string, entry: unknown): void {
    const topKey = path.split('.')[0];
    for (const mapping of this.persistMappings) {
      if (mapping.path === topKey && mapping.helper.mode === 'append') {
        mapping.helper.write(entry);
      }
    }
  }

  // --- Notification ---

  private notify(changePath: string, type: StateEvent['type'], prev: unknown): void {
    const event: StateEvent = { type, path: changePath, data: get(this.data, changePath), prev };

    for (const [subPath, callbacks] of this.subscriptions) {
      // Exact match
      if (changePath === subPath) {
        for (const cb of callbacks) cb(event);
        continue;
      }

      // Subscription is ancestor of change (subPath is shorter)
      if (changePath.startsWith(subPath + '.')) {
        for (const cb of callbacks) {
          cb({ ...event, data: get(this.data, subPath) });
        }
        continue;
      }

      // Subscription is descendant of change (subPath is longer)
      if (subPath.startsWith(changePath + '.')) {
        const newVal = get(this.data, subPath);
        // Phase A: always notify descendants (skip change detection for now)
        for (const cb of callbacks) {
          cb({ ...event, data: newVal });
        }
      }
    }
  }
}
