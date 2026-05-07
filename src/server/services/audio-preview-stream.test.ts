import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseRangeHeader,
  getAudioMimeType,
  resolvePreviewAudioFile,
} from './audio-preview-stream.js';

describe('parseRangeHeader', () => {
  it('returns invalid sentinel for "bytes=-" (NaN regression)', () => {
    expect(parseRangeHeader('bytes=-', 1000)).toEqual({ start: -1, end: -1 });
  });

  it('returns invalid sentinel for "bytes=invalid"', () => {
    expect(parseRangeHeader('bytes=invalid', 1000)).toEqual({ start: -1, end: -1 });
  });

  it('returns invalid sentinel for "bytes=abc-" (non-finite start)', () => {
    expect(parseRangeHeader('bytes=abc-', 1000)).toEqual({ start: -1, end: -1 });
  });

  it('parses valid range bytes=0-99', () => {
    expect(parseRangeHeader('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
  });

  it('parses suffix range bytes=-500', () => {
    expect(parseRangeHeader('bytes=-500', 1000)).toEqual({ start: 500, end: 999 });
  });

  it('parses open-ended range bytes=0-', () => {
    expect(parseRangeHeader('bytes=0-', 1000)).toEqual({ start: 0, end: 999 });
  });

  it('returns invalid sentinel for end < start', () => {
    expect(parseRangeHeader('bytes=500-200', 1000)).toEqual({ start: -1, end: -1 });
  });

  it('returns invalid sentinel for start >= file size', () => {
    expect(parseRangeHeader('bytes=2000-', 1000)).toEqual({ start: -1, end: -1 });
  });

  it('clamps end to file size - 1', () => {
    expect(parseRangeHeader('bytes=0-99999', 1000)).toEqual({ start: 0, end: 999 });
  });
});

describe('getAudioMimeType', () => {
  it('returns audio/wav for .wav (added in #1017)', () => {
    expect(getAudioMimeType('.wav')).toBe('audio/wav');
  });

  it('returns audio/mpeg for .mp3', () => {
    expect(getAudioMimeType('.mp3')).toBe('audio/mpeg');
  });

  it('returns audio/mp4 for .m4b', () => {
    expect(getAudioMimeType('.m4b')).toBe('audio/mp4');
  });

  it('returns audio/flac for .flac', () => {
    expect(getAudioMimeType('.flac')).toBe('audio/flac');
  });

  it('returns application/octet-stream for unknown extension', () => {
    expect(getAudioMimeType('.xyz')).toBe('application/octet-stream');
  });
});

describe('resolvePreviewAudioFile', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'audio-preview-test-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('returns the path directly when target is an audio file', async () => {
    const file = join(workDir, 'track.mp3');
    await writeFile(file, 'data');
    expect(await resolvePreviewAudioFile(file)).toBe(file);
  });

  it('returns null when target is a non-audio file', async () => {
    const file = join(workDir, 'notes.txt');
    await writeFile(file, 'data');
    expect(await resolvePreviewAudioFile(file)).toBeNull();
  });

  it('returns null on a non-existent path', async () => {
    expect(await resolvePreviewAudioFile(join(workDir, 'nope'))).toBeNull();
  });

  it('returns null for a directory with no audio files', async () => {
    await writeFile(join(workDir, 'cover.jpg'), 'img');
    expect(await resolvePreviewAudioFile(workDir)).toBeNull();
  });

  it('orders Disc 1 < Disc 2 < Disc 10 deterministically (path-aware locale-numeric sort)', async () => {
    await mkdir(join(workDir, 'Disc 1'));
    await mkdir(join(workDir, 'Disc 2'));
    await mkdir(join(workDir, 'Disc 10'));
    await writeFile(join(workDir, 'Disc 1', 'track1.mp3'), 'data');
    await writeFile(join(workDir, 'Disc 2', 'track1.mp3'), 'data');
    await writeFile(join(workDir, 'Disc 10', 'track1.mp3'), 'data');

    const result = await resolvePreviewAudioFile(workDir);
    expect(result).toBe(join(workDir, 'Disc 1', 'track1.mp3'));
  });

  it('handles a flat directory with numerically-ordered tracks (02 before 10)', async () => {
    await writeFile(join(workDir, '10-chapter.mp3'), 'data');
    await writeFile(join(workDir, '02-chapter.mp3'), 'data');

    const result = await resolvePreviewAudioFile(workDir);
    expect(result).toBe(join(workDir, '02-chapter.mp3'));
  });
});
