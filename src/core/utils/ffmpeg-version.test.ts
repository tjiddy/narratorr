import { describe, it, expect } from 'vitest';
import { extractFfmpegMajor, ffmpegMajorAtLeast } from './ffmpeg-version.js';

describe('extractFfmpegMajor', () => {
  it('parses the canonical X.Y.Z shape (probeFfmpeg regex hit)', () => {
    // probeFfmpeg returns the `(\S+)` token after "ffmpeg version ", e.g. `8.0.1`
    expect(extractFfmpegMajor('8.0.1')).toBe(8);
  });

  it('parses a two-segment X.Y shape', () => {
    expect(extractFfmpegMajor('7.1')).toBe(7);
  });

  it('treats a 7.x value as major 7 (proves < 8 comparison)', () => {
    expect(extractFfmpegMajor('7.1.2')).toBe(7);
  });

  it('strips an alphabetic build prefix some distros emit (n8.0, v8.0)', () => {
    expect(extractFfmpegMajor('n8.0')).toBe(8);
    expect(extractFfmpegMajor('v8.0')).toBe(8);
  });

  it('ignores a trailing distro suffix on the patch segment', () => {
    expect(extractFfmpegMajor('6.1.1-3ubuntu5')).toBe(6);
  });

  it('returns null for a custom build whose first line has no parseable major', () => {
    // The probeFfmpeg fallback returns the trimmed first line verbatim for a
    // custom build (no "ffmpeg version X" match); a major can't be derived.
    expect(extractFfmpegMajor('ffmpeg version N-109060-gabcdef custom build')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(extractFfmpegMajor('')).toBeNull();
  });
});

describe('ffmpegMajorAtLeast', () => {
  it('passes for ffmpeg 8', () => {
    expect(ffmpegMajorAtLeast('8.0.1', 8)).toBe(true);
  });

  it('fails for ffmpeg 7 against a minimum of 8', () => {
    expect(ffmpegMajorAtLeast('7.1', 8)).toBe(false);
  });

  it('fails when the major cannot be parsed', () => {
    expect(ffmpegMajorAtLeast('custom build', 8)).toBe(false);
  });
});
