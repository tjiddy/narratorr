import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

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

/** Normalize backslashes to forward slashes for cross-platform test assertions. */
const norm = (s: string) => s.split('\\').join('/');

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

  describe('with naming options', () => {
    it('forwards separator option to renderTemplate — periods in token values', () => {
      const result = buildTargetPath('/audiobooks', '{author}/{title}', { title: 'The Way of Kings' }, 'Brandon Sanderson', { separator: 'period' });
      expect(result).toContain('Brandon.Sanderson');
      expect(result).toContain('The.Way.of.Kings');
    });

    it('forwards case option to renderTemplate — uppercase token values', () => {
      const result = buildTargetPath('/audiobooks', '{author}/{title}', { title: 'The Way of Kings' }, 'Brandon Sanderson', { case: 'upper' });
      expect(result).toContain('BRANDON SANDERSON');
      expect(result).toContain('THE WAY OF KINGS');
    });

    it('omitting options preserves existing behavior', () => {
      const result = buildTargetPath('/audiobooks', '{author}/{title}', { title: 'The Way of Kings' }, 'Brandon Sanderson');
      expect(result).toContain('Brandon Sanderson');
      expect(result).toContain('The Way of Kings');
    });
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

  it('flattens single subfolder — audio files copied directly to target, not nested', async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce([makeDirent('subdir', false, true)] as never)
      .mockResolvedValueOnce([makeDirent('audio.m4b', true, false)] as never);

    await copyAudioFiles('/src', '/dest');

    expect(norm((mkdir as Mock).mock.calls[0][0] as string)).toBe('/dest');
    expect(cp).toHaveBeenCalledTimes(1);
    const [src, dest] = (cp as Mock).mock.calls[0].map((a: unknown) => typeof a === 'string' ? norm(a) : a);
    expect(src).toBe('/src/subdir/audio.m4b');
    expect(dest).toBe('/dest/audio.m4b');
  });

  it('flattens deeply nested single-path structure (A/B/C/audio.mp3) to target root', async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce([makeDirent('A', false, true)] as never)
      .mockResolvedValueOnce([makeDirent('B', false, true)] as never)
      .mockResolvedValueOnce([makeDirent('C', false, true)] as never)
      .mockResolvedValueOnce([makeDirent('deep.mp3', true, false)] as never);

    await copyAudioFiles('/src', '/dest');

    expect(cp).toHaveBeenCalledTimes(1);
    const [src, dest] = (cp as Mock).mock.calls[0].map((a: unknown) => typeof a === 'string' ? norm(a) : a);
    expect(src).toBe('/src/A/B/C/deep.mp3');
    expect(dest).toBe('/dest/deep.mp3');
  });

  it('flattens multiple subfolders with uniquely-named audio files into target', async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce([
        makeDirent('Disc 1', false, true),
        makeDirent('Disc 2', false, true),
      ] as never)
      .mockResolvedValueOnce([makeDirent('chapter1.mp3', true, false)] as never)
      .mockResolvedValueOnce([makeDirent('chapter2.mp3', true, false)] as never);

    await copyAudioFiles('/src', '/dest');

    expect(cp).toHaveBeenCalledTimes(2);
    const calls = (cp as Mock).mock.calls.map((c: unknown[]) => c.map((a: unknown) => typeof a === 'string' ? norm(a) : a));
    expect(calls[0][0]).toBe('/src/Disc 1/chapter1.mp3');
    expect(calls[0][1]).toBe('/dest/chapter1.mp3');
    expect(calls[1][0]).toBe('/src/Disc 2/chapter2.mp3');
    expect(calls[1][1]).toBe('/dest/chapter2.mp3');
  });

  it('copies audio files at root level without change (no subfolder)', async () => {
    vi.mocked(readdir).mockResolvedValue([
      makeDirent('track1.mp3', true, false),
      makeDirent('track2.mp3', true, false),
    ] as never);

    await copyAudioFiles('/src', '/dest');

    expect(cp).toHaveBeenCalledTimes(2);
    const calls = (cp as Mock).mock.calls.map((c: unknown[]) => c.map((a: unknown) => typeof a === 'string' ? norm(a) : a));
    expect(calls[0][0]).toBe('/src/track1.mp3');
    expect(calls[0][1]).toBe('/dest/track1.mp3');
    expect(calls[1][0]).toBe('/src/track2.mp3');
    expect(calls[1][1]).toBe('/dest/track2.mp3');
  });

  it('flattens mixed content — audio at root AND in subfolders — all end up at target root', async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce([
        makeDirent('root.mp3', true, false),
        makeDirent('sub', false, true),
      ] as never)
      .mockResolvedValueOnce([makeDirent('nested.m4b', true, false)] as never);

    await copyAudioFiles('/src', '/dest');

    expect(cp).toHaveBeenCalledTimes(2);
    const calls = (cp as Mock).mock.calls.map((c: unknown[]) => c.map((a: unknown) => typeof a === 'string' ? norm(a) : a));
    expect(calls[0][0]).toBe('/src/root.mp3');
    expect(calls[0][1]).toBe('/dest/root.mp3');
    expect(calls[1][0]).toBe('/src/sub/nested.m4b');
    expect(calls[1][1]).toBe('/dest/nested.m4b');
  });

  it('skips non-audio files in subfolders during flattening', async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce([makeDirent('sub', false, true)] as never)
      .mockResolvedValueOnce([
        makeDirent('audio.mp3', true, false),
        makeDirent('notes.txt', true, false),
        makeDirent('cover.jpg', true, false),
      ] as never);

    await copyAudioFiles('/src', '/dest');

    expect(cp).toHaveBeenCalledTimes(1);
    const [src, dest] = (cp as Mock).mock.calls[0].map((a: unknown) => typeof a === 'string' ? norm(a) : a);
    expect(src).toBe('/src/sub/audio.mp3');
    expect(dest).toBe('/dest/audio.mp3');
  });

  it('skips non-audio files at root level', async () => {
    vi.mocked(readdir).mockResolvedValue([
      makeDirent('notes.txt', true, false),
      makeDirent('image.png', true, false),
    ] as never);

    await copyAudioFiles('/src', '/dest');

    expect(cp).not.toHaveBeenCalled();
  });

  it('fails with error identifying conflicting filenames when flattening produces duplicate basenames', async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce([
        makeDirent('Disc 1', false, true),
        makeDirent('Disc 2', false, true),
      ] as never)
      .mockResolvedValueOnce([makeDirent('01.mp3', true, false)] as never)
      .mockResolvedValueOnce([makeDirent('01.mp3', true, false)] as never);

    await expect(copyAudioFiles('/src', '/dest')).rejects.toThrow('01.mp3');
  });

  it('collision detection runs before any files are copied — no partial state on cp mock', async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce([
        makeDirent('Disc 1', false, true),
        makeDirent('Disc 2', false, true),
      ] as never)
      .mockResolvedValueOnce([makeDirent('track.mp3', true, false)] as never)
      .mockResolvedValueOnce([makeDirent('track.mp3', true, false)] as never);

    await expect(copyAudioFiles('/src', '/dest')).rejects.toThrow();

    expect(cp).not.toHaveBeenCalled();
  });

  it('propagates cp error (fail-fast) — does not continue copying remaining files', async () => {
    vi.mocked(readdir).mockResolvedValue([
      makeDirent('a.mp3', true, false),
      makeDirent('b.mp3', true, false),
    ] as never);
    vi.mocked(cp)
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(undefined);

    await expect(copyAudioFiles('/src', '/dest')).rejects.toThrow('disk full');

    expect(cp).toHaveBeenCalledTimes(1);
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

describe('buildTargetPath — first-by-position author/narrator tokens (#71)', () => {
  it('two authors → {author} token resolves to authors[0].name (position=0)', () => {
    // Callers pass authors[0].name as authorName — buildTargetPath receives the resolved string
    const result = buildTargetPath('/library', '{author}/{title}', { title: 'The Way of Kings', narrators: null }, 'Brandon Sanderson');
    expect(result).toBe('/library/Brandon Sanderson/The Way of Kings');
  });

  it('two narrators → {narrator} token resolves to narrators[0].name (position=0)', () => {
    const result = buildTargetPath('/library', '{narrator}/{title}', {
      title: 'The Way of Kings',
      narrators: [{ name: 'Michael Kramer' }, { name: 'Kate Reading' }],
    }, 'Brandon Sanderson');
    expect(result).toBe('/library/Michael Kramer/The Way of Kings');
  });

  it('empty narrators array → {narrator} token is omitted (undefined)', () => {
    // renderTemplate skips tokens with undefined value — the segment is dropped
    const result = buildTargetPath('/library', '{narrator}/{title}', {
      title: 'The Way of Kings',
      narrators: [],
    }, 'Brandon Sanderson');
    expect(result).toBe('/library/The Way of Kings');
  });

  it('{authorLastFirst} formats passed authorName; {narratorLastFirst} uses position-0 narrator only (not all narrators joined)', () => {
    const result = buildTargetPath(
      '/library',
      '{authorLastFirst}/{narratorLastFirst}/{title}',
      {
        title: 'The Way of Kings',
        narrators: [{ name: 'Michael Kramer' }, { name: 'Kate Reading' }],
      },
      'Brandon Sanderson',
    );
    expect(result).toBe('/library/Sanderson, Brandon/Kramer, Michael/The Way of Kings');
  });
});

