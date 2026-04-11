import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { BaseWayangState } from '@/infra/state/base-state';
import type { PersistMapping } from '@/infra/state/base-state';
import { JSONFileHelper } from '@/infra/state/persistence/json-file';
import { JSONLFileHelper } from '@/infra/state/persistence/jsonl-file';
import type { StateEvent } from '@/types/index';

// Minimal concrete subclass for testing
class TestState extends BaseWayangState {
  constructor(
    initialData: Record<string, any>,
    persistMappings: PersistMapping[] = [],
  ) {
    super(initialData, persistMappings);
  }

  async restore(): Promise<void> {
    // no-op for base tests
  }
}

describe('BaseWayangState', () => {
  let state: TestState;

  beforeEach(() => {
    state = new TestState({
      name: 'test',
      count: 0,
      nested: { a: 1, b: { c: 2 } },
      items: [10, 20, 30],
    });
  });

  // --- get ---

  describe('get', () => {
    it('should get top-level value', () => {
      expect(state.get('name')).toBe('test');
    });

    it('should get nested value', () => {
      expect(state.get('nested.a')).toBe(1);
      expect(state.get('nested.b.c')).toBe(2);
    });

    it('should get array', () => {
      expect(state.get('items')).toEqual([10, 20, 30]);
    });

    it('should return undefined for missing path', () => {
      expect(state.get('nonexistent')).toBeUndefined();
      expect(state.get('nested.x')).toBeUndefined();
    });
  });

  // --- set ---

  describe('set', () => {
    it('should set top-level value', () => {
      state.set('count', 5);
      expect(state.get('count')).toBe(5);
    });

    it('should set nested value', () => {
      state.set('nested.b.c', 99);
      expect(state.get('nested.b.c')).toBe(99);
    });

    it('should create intermediate objects', () => {
      state.set('new.path.value', 'hello');
      expect(state.get('new.path.value')).toBe('hello');
    });

    it('should replace entire object', () => {
      state.set('nested', { x: 1 });
      expect(state.get('nested')).toEqual({ x: 1 });
    });
  });

  // --- update ---

  describe('update', () => {
    it('should merge partial object', () => {
      state.update('nested', { d: 3 });
      expect(state.get('nested')).toEqual({ a: 1, b: { c: 2 }, d: 3 });
    });

    it('should overwrite existing keys', () => {
      state.update('nested', { a: 100 });
      expect(state.get('nested.a')).toBe(100);
    });

    it('should set value if target is undefined', () => {
      state.update('missing', { x: 1 });
      expect(state.get('missing')).toEqual({ x: 1 });
    });
  });

  // --- append ---

  describe('append', () => {
    it('should append to array', () => {
      state.append('items', 40);
      expect(state.get('items')).toEqual([10, 20, 30, 40]);
    });

    it('should throw if target is not array', () => {
      expect(() => state.append('name', 'x')).toThrow('not an array');
    });
  });

  // --- remove ---

  describe('remove', () => {
    it('should remove last element by default', () => {
      state.remove('items');
      expect(state.get('items')).toEqual([10, 20]);
    });

    it('should remove at index', () => {
      state.remove('items', 1);
      expect(state.get('items')).toEqual([10, 30]);
    });

    it('should throw if target is not array', () => {
      expect(() => state.remove('name')).toThrow('not an array');
    });
  });

  // --- Subscription ---

  describe('on (subscription)', () => {
    it('should notify on exact match', () => {
      const events: StateEvent[] = [];
      state.on('count', (e) => events.push(e));

      state.set('count', 5);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('set');
      expect(events[0].data).toBe(5);
    });

    it('should notify ancestor subscribers', () => {
      const events: StateEvent[] = [];
      state.on('nested', (e) => events.push(e));

      state.set('nested.b.c', 99);
      expect(events).toHaveLength(1);
      expect(events[0].data).toEqual({ a: 1, b: { c: 99 } });
    });

    it('should notify descendant subscribers', () => {
      const events: StateEvent[] = [];
      state.on('nested.b.c', (e) => events.push(e));

      state.set('nested', { a: 1, b: { c: 99 } });
      expect(events).toHaveLength(1);
      expect(events[0].data).toBe(99);
    });

    it('should not notify unrelated subscribers', () => {
      const events: StateEvent[] = [];
      state.on('name', (e) => events.push(e));

      state.set('count', 5);
      expect(events).toHaveLength(0);
    });

    it('should support unsubscribe', () => {
      const events: StateEvent[] = [];
      const unsub = state.on('count', (e) => events.push(e));

      state.set('count', 1);
      unsub();
      state.set('count', 2);

      expect(events).toHaveLength(1);
    });

    it('should notify on append', () => {
      const events: StateEvent[] = [];
      state.on('items', (e) => events.push(e));

      state.append('items', 40);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('append');
    });

    it('should notify on remove', () => {
      const events: StateEvent[] = [];
      state.on('items', (e) => events.push(e));

      state.remove('items', 0);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('remove');
    });
  });

  // --- Auto Persistence ---

  describe('auto persistence', () => {
    let tempDir: string;
    let jsonFile: JSONFileHelper;
    let jsonlFile: JSONLFileHelper;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'wayang-test-'));
      jsonFile = new JSONFileHelper(join(tempDir, 'state.json'));
      jsonlFile = new JSONLFileHelper(join(tempDir, 'log.jsonl'));

      state = new TestState(
        {
          config: { name: 'test' },
          entries: [],
        },
        [
          { path: 'config', helper: jsonFile },
          { path: 'entries', helper: jsonlFile },
        ],
      );
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('should auto-persist to JSON on set', () => {
      state.set('config', { name: 'updated' });
      expect(jsonFile.read()).toEqual({ name: 'updated' });
    });

    it('should auto-persist to JSON on update', () => {
      state.update('config', { extra: true });
      expect(jsonFile.read()).toEqual({ name: 'test', extra: true });
    });

    it('should auto-persist to JSON on deep set', () => {
      state.set('config.name', 'new');
      expect(jsonFile.read()).toEqual({ name: 'new' });
    });
  });
});
