import { describe, it, expect, vi, afterEach } from 'vitest';
import { HEARTBEAT_INTERVAL_MS, SSE_HEARTBEAT_FRAME, sseFrame, startHeartbeat, stopHeartbeat } from './sse-stream.js';

describe('sse-stream', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('exports the canonical heartbeat frame literal (named `hb` event, #1798)', () => {
    expect(SSE_HEARTBEAT_FRAME).toBe('event: hb\ndata: {}\n\n');
  });

  describe('sseFrame — the one owner of the event/data wire format (#2584)', () => {
    it('frames a named event as `event:`/`data:` lines terminated by a blank line', () => {
      expect(sseFrame('download_progress', { download_id: 1, percentage: 0.5 }))
        .toBe('event: download_progress\ndata: {"download_id":1,"percentage":0.5}\n\n');
    });

    it('JSON-encodes the payload, so a newline in a string value cannot split the data line', () => {
      // A raw newline would terminate the frame early and the client would parse a truncated event.
      const frame = sseFrame('indexer-error', { error: 'line one\nline two' });

      expect(frame).toBe('event: indexer-error\ndata: {"error":"line one\\nline two"}\n\n');
      expect(frame.split('\n')).toHaveLength(4);
    });

    it.each([
      ['an empty object', {}, 'event: hb\ndata: {}\n\n'],
      ['an empty array', [], 'event: hb\ndata: []\n\n'],
      ['null', null, 'event: hb\ndata: null\n\n'],
    ])('frames %s without collapsing the data line', (_name, data, expected) => {
      expect(sseFrame('hb', data)).toBe(expected);
    });

    it('is the source of SSE_HEARTBEAT_FRAME, so the heartbeat cannot drift from named events', () => {
      expect(SSE_HEARTBEAT_FRAME).toBe(sseFrame('hb', {}));
    });
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
