import { describe, it, expect, vi } from 'vitest';
import { LifecycleHooks } from '@/services/lifecycle-hooks';

describe('LifecycleHooks', () => {
  it('should call listener when event is emitted', () => {
    const hooks = new LifecycleHooks();
    const fn = vi.fn();
    hooks.on('task:completed', fn);
    hooks.emit('task:completed', { taskId: 't1' });
    expect(fn).toHaveBeenCalledWith({ taskId: 't1' });
  });

  it('should support multiple listeners for same hook', () => {
    const hooks = new LifecycleHooks();
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    hooks.on('task:added', fn1);
    hooks.on('task:added', fn2);
    hooks.emit('task:added', { id: 't1' } as any);
    expect(fn1).toHaveBeenCalled();
    expect(fn2).toHaveBeenCalled();
  });

  it('should return unsubscribe function', () => {
    const hooks = new LifecycleHooks();
    const fn = vi.fn();
    const unsub = hooks.on('task:completed', fn);
    unsub();
    hooks.emit('task:completed', { taskId: 't1' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('should not call listeners for different hooks', () => {
    const hooks = new LifecycleHooks();
    const fn = vi.fn();
    hooks.on('task:completed', fn);
    hooks.emit('task:failed', { taskId: 't1', error: 'err' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('removeAll should clear all listeners', () => {
    const hooks = new LifecycleHooks();
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    hooks.on('task:completed', fn1);
    hooks.on('task:failed', fn2);
    hooks.removeAll();
    hooks.emit('task:completed', { taskId: 't1' });
    hooks.emit('task:failed', { taskId: 't1', error: 'err' });
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).not.toHaveBeenCalled();
  });

  it('should emit with no listeners without error', () => {
    const hooks = new LifecycleHooks();
    expect(() => hooks.emit('task:completed', { taskId: 't1' })).not.toThrow();
  });
});
