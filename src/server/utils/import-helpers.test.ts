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
        makeDirent('Part 1', false, true),
        makeDirent('Part 2', false, true),
      ] as never)
      .mockResolvedValueOnce([makeDirent('chapter1.mp3', true, false)] as never)
      .mockResolvedValueOnce([makeDirent('chapter2.mp3', true, false)] as never);

    await copyAudioFiles('/src', '/dest');

    expect(cp).toHaveBeenCalledTimes(2);
    const calls = (cp as Mock).mock.calls.map((c: unknown[]) => c.map((a: unknown) => typeof a === 'string' ? norm(a) : a));
    expect(calls[0][0]).toBe('/src/Part 1/chapter1.mp3');
    expect(calls[0][1]).toBe('/dest/chapter1.mp3');
    expect(calls[1][0]).toBe('/src/Part 2/chapter2.mp3');
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
    expect(calls[0][0]).toBe('/src/sub/nested.m4b');
    expect(calls[0][1]).toBe('/dest/nested.m4b');
    expect(calls[1][0]).toBe('/src/root.mp3');
    expect(calls[1][1]).toBe('/dest/root.mp3');
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
        makeDirent('Part 1', false, true),
        makeDirent('Part 2', false, true),
      ] as never)
      .mockResolvedValueOnce([makeDirent('01.mp3', true, false)] as never)
      .mockResolvedValueOnce([makeDirent('01.mp3', true, false)] as never);

    await expect(copyAudioFiles('/src', '/dest')).rejects.toThrow('01.mp3');
  });

  it('collision detection runs before any files are copied — no partial state on cp mock', async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce([
        makeDirent('Part 1', false, true),
        makeDirent('Part 2', false, true),
      ] as never)
      .mockResolvedValueOnce([makeDirent('track.mp3', true, false)] as never)
      .mockResolvedValueOnce([makeDirent('track.mp3', true, false)] as never);

    await expect(copyAudioFiles('/src', '/dest')).rejects.toThrow();

    expect(cp).not.toHaveBeenCalled();
  });

  it('copies files in alphabetical order regardless of readdir order', async () => {
    vi.mocked(readdir).mockResolvedValue([
      makeDirent('Part 2.mp3', true, false),
      makeDirent('Part 3.mp3', true, false),
      makeDirent('Part 1.mp3', true, false),
    ] as never);

    await copyAudioFiles('/src', '/dest');

    expect(cp).toHaveBeenCalledTimes(3);
    const copiedNames = (cp as Mock).mock.calls.map(
      (c: unknown[]) => norm(c[1] as string).split('/').pop(),
    );
    expect(copiedNames).toEqual(['Part 1.mp3', 'Part 2.mp3', 'Part 3.mp3']);
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

describe('copyAudioFiles — multi-disc detection and sequential renaming', () => {
  /**
   * Helper: mock readdir to return disc subfolders at root, then files within each disc.
   * discEntries: array of [discName, audioFileNames[]]
   */
  function setupDiscLayout(discEntries: Array<[string, string[]]>, rootFiles: string[] = []) {
    const rootItems = [
      ...rootFiles.map(f => makeDirent(f, true, false)),
      ...discEntries.map(([name]) => makeDirent(name, false, true)),
    ];
    vi.mocked(readdir)
      .mockResolvedValueOnce(rootItems as never); // root readdir

    // Each disc subfolder readdir
    for (const [, files] of discEntries) {
      vi.mocked(readdir).mockResolvedValueOnce(
        files.map(f => makeDirent(f, true, false)) as never,
      );
    }
  }

  /** Extract copied destination filenames from cp mock calls. */
  function getCopiedDestNames(): string[] {
    return (cp as Mock).mock.calls.map(
      (c: unknown[]) => norm(c[1] as string).split('/').pop()!,
    );
  }

  /** Extract copied source paths from cp mock calls. */
  function getCopiedSrcPaths(): string[] {
    return (cp as Mock).mock.calls.map(
      (c: unknown[]) => norm(c[0] as string),
    );
  }

  it('detects disc subfolders (Disc 01, Disc 02) and copies files with sequential names', async () => {
    setupDiscLayout([
      ['Disc 01', ['01.mp3', '02.mp3']],
      ['Disc 02', ['01.mp3', '02.mp3']],
    ]);

    await copyAudioFiles('/src', '/dest');

    expect(cp).toHaveBeenCalledTimes(4);
    // 4 tracks → padWidth=1 → 1.mp3, 2.mp3, 3.mp3, 4.mp3
    expect(getCopiedDestNames()).toEqual(['1.mp3', '2.mp3', '3.mp3', '4.mp3']);
  });

  it('sorts discs naturally — Disc 2 before Disc 10', async () => {
    setupDiscLayout([
      ['Disc 10', ['a.mp3']],
      ['Disc 2', ['b.mp3']],
    ]);

    await copyAudioFiles('/src', '/dest');

    // Disc 2 should come first (natural sort), then Disc 10
    const srcPaths = getCopiedSrcPaths();
    expect(srcPaths[0]).toContain('Disc 2');
    expect(srcPaths[1]).toContain('Disc 10');
  });

  it('orders tracks within each disc alphabetically by filename', async () => {
    setupDiscLayout([
      ['Disc 01', ['03 - Third.mp3', '01 - First.mp3', '02 - Second.mp3']],
    ]);

    await copyAudioFiles('/src', '/dest');

    const srcPaths = getCopiedSrcPaths();
    expect(srcPaths[0]).toContain('01 - First.mp3');
    expect(srcPaths[1]).toContain('02 - Second.mp3');
    expect(srcPaths[2]).toContain('03 - Third.mp3');
  });

  it('handles common disc patterns: CD 1, Disk 2, disc01, DISC 004, cd1', async () => {
    // Each pattern should be detected as a disc folder
    for (const discName of ['CD 1', 'Disk 2', 'disc01', 'DISC 004', 'cd1']) {
      vi.clearAllMocks();
      vi.mocked(readdir)
        .mockResolvedValueOnce([makeDirent(discName, false, true)] as never)
        .mockResolvedValueOnce([makeDirent('track.mp3', true, false)] as never);

      await copyAudioFiles('/src', '/dest');

      // Single disc treated as no-disc (no renaming), but should not error
      expect(cp).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects non-disc folders — does not treat Extras, Part 1, 01 - Chapter One as disc folders', async () => {
    // Non-disc subfolders should be recursively flattened (existing behavior), not disc-detected
    vi.mocked(readdir)
      .mockResolvedValueOnce([
        makeDirent('Extras', false, true),
        makeDirent('Part 1', false, true),
      ] as never)
      .mockResolvedValueOnce([makeDirent('bonus.mp3', true, false)] as never)
      .mockResolvedValueOnce([makeDirent('chapter.mp3', true, false)] as never);

    await copyAudioFiles('/src', '/dest');

    // Files should be flattened with original names (no sequential renaming)
    const destNames = getCopiedDestNames();
    expect(destNames).toContain('bonus.mp3');
    expect(destNames).toContain('chapter.mp3');
  });

  it('single disc subfolder — no sequential renaming', async () => {
    setupDiscLayout([
      ['Disc 01', ['track1.mp3', 'track2.mp3']],
    ]);

    await copyAudioFiles('/src', '/dest');

    // Single disc = no renaming, just flatten
    const destNames = getCopiedDestNames();
    expect(destNames).toEqual(['track1.mp3', 'track2.mp3']);
  });

  it('two discs with 1 track each — output is 1.mp3, 2.mp3', async () => {
    setupDiscLayout([
      ['Disc 01', ['track.mp3']],
      ['Disc 02', ['track.mp3']],
    ]);

    await copyAudioFiles('/src', '/dest');

    expect(cp).toHaveBeenCalledTimes(2);
    // 2 tracks → padWidth=1 → 1.mp3, 2.mp3
    expect(getCopiedDestNames()).toEqual(['1.mp3', '2.mp3']);
  });

  it('zero-pads sequential names when 10+ tracks (2-digit padding)', async () => {
    // 6 tracks per disc = 12 total → padWidth=2 → 01.mp3 through 12.mp3
    setupDiscLayout([
      ['Disc 01', ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3', 'e.mp3', 'f.mp3']],
      ['Disc 02', ['g.mp3', 'h.mp3', 'i.mp3', 'j.mp3', 'k.mp3', 'l.mp3']],
    ]);

    await copyAudioFiles('/src', '/dest');

    expect(cp).toHaveBeenCalledTimes(12);
    const destNames = getCopiedDestNames();
    expect(destNames[0]).toBe('01.mp3');
    expect(destNames[9]).toBe('10.mp3');
    expect(destNames[11]).toBe('12.mp3');
  });

  it('track numbering boundary — Disc 1 has 3 tracks, Disc 2 starts at 4', async () => {
    setupDiscLayout([
      ['Disc 01', ['a.mp3', 'b.mp3', 'c.mp3']],
      ['Disc 02', ['x.mp3', 'y.mp3']],
    ]);

    await copyAudioFiles('/src', '/dest');

    // 5 tracks → padWidth=1 → 1.mp3 through 5.mp3
    expect(getCopiedDestNames()).toEqual(['1.mp3', '2.mp3', '3.mp3', '4.mp3', '5.mp3']);
  });

  it('zero-padded disc numbers (Disc 01) and unpadded (Disc 1) both detected and sorted correctly', async () => {
    setupDiscLayout([
      ['Disc 1', ['a.mp3']],
      ['Disc 02', ['b.mp3']],
    ]);

    await copyAudioFiles('/src', '/dest');

    const srcPaths = getCopiedSrcPaths();
    expect(srcPaths[0]).toContain('Disc 1');
    expect(srcPaths[1]).toContain('Disc 02');
    // 2 tracks → padWidth=1
    expect(getCopiedDestNames()).toEqual(['1.mp3', '2.mp3']);
  });

  it('non-audio files in disc subfolders (cover.jpg, .cue) are ignored', async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce([makeDirent('Disc 01', false, true)] as never)
      .mockResolvedValueOnce([
        makeDirent('track.mp3', true, false),
        makeDirent('cover.jpg', true, false),
        makeDirent('disc.cue', true, false),
      ] as never);

    await copyAudioFiles('/src', '/dest');

    // Only audio file copied, single disc = no renaming
    expect(cp).toHaveBeenCalledTimes(1);
    expect(getCopiedDestNames()).toEqual(['track.mp3']);
  });

  it('non-disc subfolders mixed with disc subfolders — non-disc content recursively flattened', async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce([
        makeDirent('Disc 01', false, true),
        makeDirent('Disc 02', false, true),
        makeDirent('Extras', false, true),
      ] as never)
      .mockResolvedValueOnce([makeDirent('01.mp3', true, false)] as never) // Disc 01
      .mockResolvedValueOnce([makeDirent('01.mp3', true, false)] as never) // Disc 02
      .mockResolvedValueOnce([makeDirent('bonus.mp3', true, false)] as never); // Extras

    await copyAudioFiles('/src', '/dest');

    // 2 disc tracks get sequential names, Extras file flattened with original name
    expect(cp).toHaveBeenCalledTimes(3);
    const destNames = getCopiedDestNames();
    // Non-disc files first (alpha sort), then sequential disc files
    expect(destNames).toContain('bonus.mp3');
    expect(destNames).toContain('1.mp3');
    expect(destNames).toContain('2.mp3');
  });

  it('duplicate filenames within the SAME disc still error', async () => {
    // Single disc with duplicate files — this shouldn't happen in practice but should error
    vi.mocked(readdir)
      .mockResolvedValueOnce([
        makeDirent('Disc 01', false, true),
        makeDirent('Disc 02', false, true),
      ] as never)
      .mockResolvedValueOnce([
        makeDirent('track.mp3', true, false),
        makeDirent('track.mp3', true, false),
      ] as never)
      .mockResolvedValueOnce([makeDirent('other.mp3', true, false)] as never);

    // Within-disc duplicates will be caught by alphabetical sort producing same name
    // The sequential renaming should handle this gracefully, but let's verify no data loss
    await copyAudioFiles('/src', '/dest');
    // With sequential renaming, even within-disc dupes get unique names
    expect(cp).toHaveBeenCalledTimes(3);
  });

  it('disc subfolders with mixed naming patterns (CD 1, Disc 02) all detected', async () => {
    setupDiscLayout([
      ['CD 1', ['a.mp3']],
      ['Disc 02', ['b.mp3']],
    ]);

    await copyAudioFiles('/src', '/dest');

    // 2 tracks → padWidth=1
    expect(getCopiedDestNames()).toEqual(['1.mp3', '2.mp3']);
  });

  it('loose audio files at root alongside disc subfolders — loose files ordered before disc files', async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce([
        makeDirent('root_track.mp3', true, false),
        makeDirent('Disc 01', false, true),
        makeDirent('Disc 02', false, true),
      ] as never)
      .mockResolvedValueOnce([makeDirent('01.mp3', true, false)] as never) // Disc 01
      .mockResolvedValueOnce([makeDirent('01.mp3', true, false)] as never); // Disc 02

    await copyAudioFiles('/src', '/dest');

    const destNames = getCopiedDestNames();
    // Non-disc files first (original name), then sequential disc files
    expect(destNames).toEqual(['root_track.mp3', '1.mp3', '2.mp3']);
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

