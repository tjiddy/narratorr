import { describe, expect, it } from 'vitest';
import { toSourceBitrateKbps } from './audio-bitrate.js';

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

  it('returns undefined for the documented 827 bps header lie rather than 0', () => {
    expect(toSourceBitrateKbps(827)).toBeUndefined();
  });

  it('returns undefined for any value that floors below 1 kbps', () => {
    expect(toSourceBitrateKbps(999)).toBeUndefined();
  });

  it('returns 1 at the 1 kbps boundary', () => {
    expect(toSourceBitrateKbps(1000)).toBe(1);
  });
});
