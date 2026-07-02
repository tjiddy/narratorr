import { describe, it, expect, vi, afterEach } from 'vitest';
import { HEARTBEAT_INTERVAL_MS, SSE_HEARTBEAT_FRAME, startHeartbeat, stopHeartbeat } from './sse-stream.js';

describe('sse-stream', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('exports the canonical heartbeat frame literal', () => {
    expect(SSE_HEARTBEAT_FRAME).toBe(':hb\n\n');
  });

  it('exports a heartbeat interval value', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(20_000);
  });

  it('startHeartbeat fires the write callback at the fixed interval', () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const timer = startHeartbeat(write);

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(write).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(write).toHaveBeenCalledTimes(2);

    stopHeartbeat(timer);
  });

  it('stopHeartbeat halts further ticks', () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const timer = startHeartbeat(write);

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    stopHeartbeat(timer);
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);

    expect(write).toHaveBeenCalledTimes(1);
  });

  it('unref()s the timer so it never holds the process open', () => {
    const unref = vi.fn();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
      .mockReturnValue({ unref } as unknown as ReturnType<typeof setInterval>);

    startHeartbeat(vi.fn());

    expect(setIntervalSpy).toHaveBeenCalled();
    expect(unref).toHaveBeenCalled();
  });

  it('stopHeartbeat is null-safe and idempotent (double-stop does not throw)', () => {
    vi.useFakeTimers();
    const timer = startHeartbeat(vi.fn());

    expect(() => stopHeartbeat(null)).not.toThrow();
    expect(() => stopHeartbeat(undefined)).not.toThrow();
    expect(() => {
      stopHeartbeat(timer);
      stopHeartbeat(timer);
    }).not.toThrow();
  });
});
