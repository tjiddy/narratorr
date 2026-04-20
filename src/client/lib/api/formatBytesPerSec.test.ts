import { describe, it, expect } from 'vitest';
import { formatBytesPerSec } from './formatBytesPerSec.js';

describe('formatBytesPerSec', () => {
  it('renders 0 as "0 KB/s" (stalled signal)', () => {
    expect(formatBytesPerSec(0)).toBe('0 KB/s');
  });

  it('renders sub-KB values as KB/s (minimum resolution for UI)', () => {
    // 512 bytes → 0.5 KB/s — anything below 1 KB/s rounds for display.
    expect(formatBytesPerSec(512)).toBe('0.5 KB/s');
  });

  it('renders KB/s range with one decimal', () => {
    expect(formatBytesPerSec(1024)).toBe('1.0 KB/s');
    expect(formatBytesPerSec(1536)).toBe('1.5 KB/s');
  });

  it('renders MB/s range with one decimal', () => {
    expect(formatBytesPerSec(1_048_576)).toBe('1.0 MB/s');
    expect(formatBytesPerSec(2_621_440)).toBe('2.5 MB/s');
  });

  it('renders GB/s range with one decimal', () => {
    expect(formatBytesPerSec(1_073_741_824)).toBe('1.0 GB/s');
  });

  it('renders negative input as "0 KB/s" (defensive — rates should never be negative)', () => {
    expect(formatBytesPerSec(-100)).toBe('0 KB/s');
  });

  it('handles the KB/MB boundary cleanly (1023 KB stays KB/s)', () => {
    // 1023 * 1024 = 1047552 bytes → still below MB threshold
    expect(formatBytesPerSec(1023 * 1024)).toBe('1023.0 KB/s');
  });
});
