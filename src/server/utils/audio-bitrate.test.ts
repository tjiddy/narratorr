import { describe, expect, it, vi } from 'vitest';
import { toSourceBitrateKbps, logBitrateCapping } from './audio-bitrate.js';
import type { FastifyBaseLogger } from 'fastify';

function createMockLogger(): FastifyBaseLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    silent: vi.fn(),
    level: 'debug',
  } as unknown as FastifyBaseLogger;
}

describe('toSourceBitrateKbps()', () => {
  it('returns undefined when input is null', () => {
    expect(toSourceBitrateKbps(null)).toBeUndefined();
  });

  it('returns undefined when input is undefined', () => {
    expect(toSourceBitrateKbps(undefined)).toBeUndefined();
  });

  it('returns undefined when input is 0 (falsy guard)', () => {
    expect(toSourceBitrateKbps(0)).toBeUndefined();
  });

  it('returns Math.floor(bps / 1000) for valid positive input', () => {
    expect(toSourceBitrateKbps(128000)).toBe(128);
  });

  it('floors fractional kbps values (e.g., 128500 bps → 128 kbps)', () => {
    expect(toSourceBitrateKbps(128500)).toBe(128);
  });
});

describe('logBitrateCapping()', () => {
  it('logs debug when sourceBitrateKbps < targetBitrateKbps', () => {
    const log = createMockLogger();
    logBitrateCapping(64, 128, log);
    expect(log.debug).toHaveBeenCalledWith(
      { sourceBitrateKbps: 64, targetBitrateKbps: 128, effectiveBitrateKbps: 64 },
      'Capping target bitrate to source bitrate to prevent upsampling',
    );
  });

  it('does not log when sourceBitrateKbps >= targetBitrateKbps', () => {
    const log = createMockLogger();
    logBitrateCapping(128, 64, log);
    expect(log.debug).not.toHaveBeenCalled();
  });

  it('does not log when sourceBitrateKbps is undefined', () => {
    const log = createMockLogger();
    logBitrateCapping(undefined, 128, log);
    expect(log.debug).not.toHaveBeenCalled();
  });

  it('does not log when targetBitrateKbps is undefined', () => {
    const log = createMockLogger();
    logBitrateCapping(64, undefined, log);
    expect(log.debug).not.toHaveBeenCalled();
  });

  it('does not log when both are undefined', () => {
    const log = createMockLogger();
    logBitrateCapping(undefined, undefined, log);
    expect(log.debug).not.toHaveBeenCalled();
  });

  it('returns sourceBitrateKbps and targetBitrateKbps unchanged', () => {
    const log = createMockLogger();
    const result = logBitrateCapping(64, 128, log);
    expect(result).toEqual({ sourceBitrateKbps: 64, targetBitrateKbps: 128 });
  });
});
