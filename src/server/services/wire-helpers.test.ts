import { describe, it, expect } from 'vitest';
import { WireOnce, ServiceWireError } from './wire-helpers.js';

describe('WireOnce', () => {
  it('require() throws ServiceWireError before set()', () => {
    const slot = new WireOnce<{ x: number }>('TestService');
    expect(() => slot.require()).toThrow(ServiceWireError);
    expect(() => slot.require()).toThrow(/TestService used before wire/);
  });

  it('require() returns the wired value after set()', () => {
    const slot = new WireOnce<{ x: number }>('TestService');
    slot.set({ x: 42 });
    expect(slot.require()).toEqual({ x: 42 });
  });

  it('set() called twice throws ServiceWireError', () => {
    const slot = new WireOnce<{ x: number }>('TestService');
    slot.set({ x: 1 });
    expect(() => slot.set({ x: 2 })).toThrow(ServiceWireError);
    expect(() => slot.set({ x: 2 })).toThrow(/TestService\.wire\(\) called more than once/);
  });

  it('isWired() reports the wired state', () => {
    const slot = new WireOnce<{ x: number }>('TestService');
    expect(slot.isWired()).toBe(false);
    slot.set({ x: 1 });
    expect(slot.isWired()).toBe(true);
  });

  it('serviceName is included in error messages', () => {
    const slot = new WireOnce<{ x: number }>('MyOrchestrator');
    expect(() => slot.require()).toThrow(/MyOrchestrator/);
    slot.set({ x: 1 });
    expect(() => slot.set({ x: 2 })).toThrow(/MyOrchestrator/);
  });
});
