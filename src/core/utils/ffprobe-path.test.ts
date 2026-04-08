import { describe, it, expect } from 'vitest';
import { deriveFfprobePath } from './ffprobe-path.js';

describe('deriveFfprobePath', () => {
  it('replaces ffmpeg with ffprobe in a Unix path', () => {
    expect(deriveFfprobePath('/usr/bin/ffmpeg')).toBe('/usr/bin/ffprobe');
  });

  it('replaces ffmpeg.exe with ffprobe.exe (Windows)', () => {
    expect(deriveFfprobePath('C:\\tools\\ffmpeg.exe')).toBe('C:\\tools\\ffprobe.exe');
  });

  it('handles case-insensitive match', () => {
    expect(deriveFfprobePath('/usr/bin/FFmpeg')).toBe('/usr/bin/ffprobe');
  });

  it('only replaces the trailing ffmpeg segment', () => {
    expect(deriveFfprobePath('/opt/ffmpeg-build/bin/ffmpeg')).toBe('/opt/ffmpeg-build/bin/ffprobe');
  });
});
