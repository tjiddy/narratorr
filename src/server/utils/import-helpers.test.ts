import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node:fs/promises before importing the module under test
vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
  readdir: vi.fn(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  cp: vi.fn().mockResolvedValue(undefined),
}));

import { stat, readdir, mkdir, cp } from 'node:fs/promises';
import type { Stats } from 'node:fs';

import {
  extractYear,
  buildTargetPath,
  getPathSize,
  containsAudioFiles,
  copyAudioFiles,
  countAudioFiles,
  COPY_VERIFICATION_THRESHOLD,
} from './import-helpers.js';

function makeDirent(name: string, isFile: boolean, isDirectory: boolean) {
  return { name, isFile: () => isFile, isDirectory: () => isDirectory };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('extractYear', () => {
  it('returns 4-digit year from date string like "2010-11-02"', () => {
    expect(extractYear('2010-11-02')).toBe('2010');
  });

  it('returns 4-digit year from year-only string like "2010"', () => {
    expect(extractYear('2010')).toBe('2010');
  });

  it('returns undefined for null/undefined input', () => {
    expect(extractYear(null)).toBeUndefined();
    expect(extractYear(undefined)).toBeUndefined();
  });

  it('returns undefined for string with no 4-digit year', () => {
    expect(extractYear('no year here')).toBeUndefined();
    expect(extractYear('12')).toBeUndefined();
  });
});

describe('COPY_VERIFICATION_THRESHOLD', () => {
  it('is 0.99', () => {
    expect(COPY_VERIFICATION_THRESHOLD).toBe(0.99);
  });
});

describe('buildTargetPath', () => {
  it('renders folder format with author and title tokens', () => {
    const result = buildTargetPath('/audiobooks', '{author}/{title}', { title: 'The Way of Kings' }, 'Brandon Sanderson');
    expect(result).toMatch(/Brandon Sanderson/);
    expect(result).toMatch(/The Way of Kings/);
  });

  it('uses "Unknown Author" when authorName is null', () => {
    const result = buildTargetPath('/audiobooks', '{author}/{title}', { title: 'Test' }, null);
    expect(result).toMatch(/Unknown Author/);
  });

  it('renders series tokens when seriesName is present', () => {
    const result = buildTargetPath('/audiobooks', '{author}/{series}/{title}', {
      title: 'Book 1',
      seriesName: 'My Series',
      seriesPosition: 1,
    }, 'Author');
    expect(result).toMatch(/My Series/);
  });

  it('omits optional tokens (narrator, year) when not provided', () => {
    const result = buildTargetPath('/audiobooks', '{author}/{title}', { title: 'Test' }, 'Author');
    // Should not contain literal {narrator} or {year} placeholders
    expect(result).not.toMatch(/\{narrator\}/);
    expect(result).not.toMatch(/\{year\}/);
  });

  it('joins rendered path segments with library path', () => {
    const result = buildTargetPath('/audiobooks', '{author}/{title}', { title: 'Book' }, 'Author');
    // Result should include the library path (join normalizes separators per platform)
    expect(result).toContain('audiobooks');
    expect(result).toContain('Author');
    expect(result).toContain('Book');
  });
});

describe('getPathSize', () => {
  it('returns file size for a single file', async () => {
    vi.mocked(stat).mockResolvedValue({ isFile: () => true, size: 1024 } as Stats);
    const size = await getPathSize('/some/file.mp3');
    expect(size).toBe(1024);
  });

  it('returns total size for a directory with files', async () => {
    vi.mocked(stat)
      .mockResolvedValueOnce({ isFile: () => false, isDirectory: () => true } as unknown as Stats) // dir itself
      .mockResolvedValueOnce({ size: 100 } as Stats) // file1
      .mockResolvedValueOnce({ size: 200 } as Stats); // file2
    vi.mocked(readdir).mockResolvedValue([
      makeDirent('file1.mp3', true, false),
      makeDirent('file2.mp3', true, false),
    ] as never);

    const size = await getPathSize('/some/dir');
    expect(size).toBe(300);
  });

  it('recursively sums nested directory sizes', async () => {
    // Root dir
    vi.mocked(stat)
      .mockResolvedValueOnce({ isFile: () => false, isDirectory: () => true } as unknown as Stats)
      .mockResolvedValueOnce({ isFile: () => false, isDirectory: () => true } as unknown as Stats) // subdir
      .mockResolvedValueOnce({ size: 500 } as Stats); // nested file

    vi.mocked(readdir)
      .mockResolvedValueOnce([makeDirent('subdir', false, true)] as never)
      .mockResolvedValueOnce([makeDirent('nested.mp3', true, false)] as never);

    const size = await getPathSize('/root');
    expect(size).toBe(500);
  });
});

describe('containsAudioFiles', () => {
  it('returns true when directory contains audio files', async () => {
    vi.mocked(readdir).mockResolvedValue([
      makeDirent('track.mp3', true, false),
    ] as never);

    expect(await containsAudioFiles('/dir')).toBe(true);
  });

  it('returns false when directory has no audio files', async () => {
    vi.mocked(readdir).mockResolvedValue([
      makeDirent('readme.txt', true, false),
    ] as never);

    expect(await containsAudioFiles('/dir')).toBe(false);
  });

  it('finds audio files in nested subdirectories', async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce([makeDirent('subdir', false, true)] as never)
      .mockResolvedValueOnce([makeDirent('track.m4b', true, false)] as never);

    expect(await containsAudioFiles('/dir')).toBe(true);
  });
});

describe('copyAudioFiles', () => {
  it('copies only audio files from source to target', async () => {
    vi.mocked(readdir).mockResolvedValue([
      makeDirent('track.mp3', true, false),
      makeDirent('cover.jpg', true, false),
    ] as never);

    await copyAudioFiles('/src', '/dest');

    expect(mkdir).toHaveBeenCalledWith('/dest', { recursive: true });
    expect(cp).toHaveBeenCalledTimes(1);
    expect(cp).toHaveBeenCalledWith(
      expect.stringContaining('track.mp3'),
      expect.stringContaining('track.mp3'),
      { errorOnExist: false },
    );
  });

  it('preserves directory structure during copy', async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce([makeDirent('subdir', false, true)] as never)
      .mockResolvedValueOnce([makeDirent('audio.m4b', true, false)] as never);

    await copyAudioFiles('/src', '/dest');

    // Should have created the nested target dir and copied the file
    expect(mkdir).toHaveBeenCalled();
    expect(cp).toHaveBeenCalledTimes(1);
  });

  it('skips non-audio files', async () => {
    vi.mocked(readdir).mockResolvedValue([
      makeDirent('notes.txt', true, false),
      makeDirent('image.png', true, false),
    ] as never);

    await copyAudioFiles('/src', '/dest');

    expect(cp).not.toHaveBeenCalled();
  });
});

describe('countAudioFiles', () => {
  it('counts audio files in a flat directory', async () => {
    vi.mocked(readdir).mockResolvedValue([
      makeDirent('a.mp3', true, false),
      makeDirent('b.m4b', true, false),
      makeDirent('c.txt', true, false),
    ] as never);

    expect(await countAudioFiles('/dir')).toBe(2);
  });

  it('counts audio files recursively in nested directories', async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce([
        makeDirent('a.mp3', true, false),
        makeDirent('sub', false, true),
      ] as never)
      .mockResolvedValueOnce([
        makeDirent('b.flac', true, false),
      ] as never);

    expect(await countAudioFiles('/dir')).toBe(2);
  });

  it('returns 0 for directory with no audio files', async () => {
    vi.mocked(readdir).mockResolvedValue([
      makeDirent('readme.txt', true, false),
    ] as never);

    expect(await countAudioFiles('/dir')).toBe(0);
  });
});
