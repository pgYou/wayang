import { describe, it, expect } from 'vitest';
import { EventBus } from '@/infra/event-bus';

describe('EventBus', () => {
  it('should emit events to subscribers', () => {
    const bus = new EventBus();
    const received: string[] = [];
    bus.on('test', (msg: string) => received.push(msg));

    bus.emit('test', 'hello');
    expect(received).toEqual(['hello']);
  });

  it('should support multiple subscribers', () => {
    const bus = new EventBus();
    const results: number[] = [];
    bus.on('evt', () => results.push(1));
    bus.on('evt', () => results.push(2));

    bus.emit('evt');
    expect(results).toEqual([1, 2]);
  });

  it('should not notify subscribers of other events', () => {
    const bus = new EventBus();
    const received: string[] = [];
    bus.on('a', () => received.push('a'));
    bus.on('b', () => received.push('b'));

    bus.emit('a');
    expect(received).toEqual(['a']);
  });

  it('should unsubscribe via returned function', () => {
    const bus = new EventBus();
    const received: string[] = [];
    const unsub = bus.on('test', (msg: string) => received.push(msg));

    bus.emit('test', 'first');
    unsub();
    bus.emit('test', 'second');

    expect(received).toEqual(['first']);
  });

  it('should support emitting with multiple args', () => {
    const bus = new EventBus();
    let captured: any[] = [];
    bus.on('multi', (...args: any[]) => captured = args);

    bus.emit('multi', 1, 'two', { three: 3 });
    expect(captured).toEqual([1, 'two', { three: 3 }]);
  });

  it('should handle emit with no subscribers', () => {
    const bus = new EventBus();
    expect(() => bus.emit('nonexistent')).not.toThrow();
  });

  it('should support removeAll', () => {
    const bus = new EventBus();
    const received: string[] = [];
    bus.on('a', () => received.push('a'));
    bus.on('b', () => received.push('b'));

    bus.removeAll();
    bus.emit('a');
    bus.emit('b');
    expect(received).toEqual([]);
  });
});
