import { describe, it, expect, vi, beforeEach } from 'vitest';
import type path from 'node:path';

// Mock node:fs/promises before importing the module under test
vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
  stat: vi.fn(),
}));

// Mock node:path to use posix behavior so tests work on Windows too.
// The source code uses join() and extname() which produce backslash paths on Windows,
// breaking the rootPath replacement logic in makeFolderEntry. The actual deployment
// target is Linux (Docker), so posix behavior is correct.
vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof path>('node:path');
  return {
    ...actual,
    join: actual.posix.join,
    extname: actual.posix.extname,
    basename: actual.posix.basename,
    relative: actual.posix.relative,
  };
});

// Bonus-content detection (mixed-content branch, #1031) reads album tags via
// the audio-scanner helper. Mock at the module boundary so we don't drag
// music-metadata + node:fs into book-discovery's test universe.
vi.mock('./audio-scanner.js', () => ({
  readAlbumTag: vi.fn(),
}));

import {
  discoverBooks,
  parseTitledDiscFolder,
  normalizeAlbumForComparison,
  type DiscoveryLogger,
} from './book-discovery.js';
import { readdir, stat } from 'node:fs/promises';
import { readAlbumTag } from './audio-scanner.js';

const mockReaddir = vi.mocked(readdir);
const mockStat = vi.mocked(stat);
const mockReadAlbumTag = vi.mocked(readAlbumTag);

// --- Helpers ---

function makeDirent(name: string, isFile: boolean) {
  return {
    name,
    isFile: () => isFile,
    isDirectory: () => !isFile,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
    path: '/audiobooks',
    parentPath: '/audiobooks',
  };
}

/**
 * Build a virtual filesystem tree that mockReaddir and mockStat will serve.
 * Each key is an absolute path (forward slashes). Value is an array of entries.
 */
function setupFs(tree: Record<string, { name: string; isFile: boolean; size?: number }[]>) {
  mockReaddir.mockImplementation(async (dirPath: unknown) => {
    const key = String(dirPath);
    const entries = tree[key];
    if (!entries) {
      throw Object.assign(new Error(`ENOENT: no such directory '${key}'`), { code: 'ENOENT' });
    }
    return entries.map(e => makeDirent(e.name, e.isFile)) as never;
  });

  // Build a flat map of file path -> size for stat lookups
  const fileSizes: Record<string, number> = {};
  for (const [dirPath, entries] of Object.entries(tree)) {
    for (const entry of entries) {
      if (entry.isFile) {
        fileSizes[`${dirPath}/${entry.name}`] = entry.size ?? 1000;
      }
    }
  }

  mockStat.mockImplementation(async (filePath: unknown) => {
    const key = String(filePath);
    if (key in fileSizes) {
      return { size: fileSizes[key] } as never;
    }
    throw Object.assign(new Error(`ENOENT: '${key}'`), { code: 'ENOENT' });
  });
}

// --- Tests ---

describe('discoverBooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---- Empty / no audio ----

  it('returns empty array for empty directory', async () => {
    setupFs({ '/audiobooks': [] });
    const result = await discoverBooks('/audiobooks');
    expect(result).toEqual([]);
  });

  it('returns empty array for directory with only non-audio files', async () => {
    setupFs({
      '/audiobooks': [
        { name: 'readme.txt', isFile: true },
        { name: 'cover.jpg', isFile: true },
      ],
    });
    const result = await discoverBooks('/audiobooks');
    expect(result).toEqual([]);
  });

  it('returns empty array when readdir throws (unreadable root)', async () => {
    mockReaddir.mockRejectedValue(new Error('EACCES'));
    const result = await discoverBooks('/audiobooks');
    expect(result).toEqual([]);
  });

  // ---- Simple leaf folder with audio ----

  it('discovers a single book folder with audio files', async () => {
    setupFs({
      '/audiobooks': [{ name: 'My Book', isFile: false }],
      '/audiobooks/My Book': [
        { name: 'chapter1.mp3', isFile: true, size: 5_000_000 },
        { name: 'chapter2.mp3', isFile: true, size: 7_000_000 },
      ],
    });

    const result = await discoverBooks('/audiobooks');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      path: '/audiobooks/My Book',
      folderParts: ['My Book'],
      audioFileCount: 2,
      totalSize: 12_000_000,
    });
  });

  it('counts only audio extensions, ignores non-audio files in same folder', async () => {
    setupFs({
      '/audiobooks': [{ name: 'Book', isFile: false }],
      '/audiobooks/Book': [
        { name: 'chapter1.m4b', isFile: true, size: 100 },
        { name: 'cover.jpg', isFile: true, size: 50 },
        { name: 'metadata.json', isFile: true, size: 10 },
      ],
    });

    const result = await discoverBooks('/audiobooks');
    expect(result).toHaveLength(1);
    expect(result[0]!.audioFileCount).toBe(1);
    expect(result[0]!.totalSize).toBe(100);
  });

  // ---- All recognized audio extensions ----

  it.each(['.m4b', '.mp3', '.m4a', '.flac', '.ogg', '.opus', '.wma', '.aac'])(
    'recognizes %s as an audio extension',
    async (ext) => {
      setupFs({
        '/audiobooks': [{ name: 'Book', isFile: false }],
        '/audiobooks/Book': [{ name: `track${ext}`, isFile: true, size: 999 }],
      });

      const result = await discoverBooks('/audiobooks');
      expect(result).toHaveLength(1);
      expect(result[0]!.audioFileCount).toBe(1);
    },
  );

  // ---- Hidden files/dirs (dot-prefixed) ----

  it('skips hidden files and directories (dot-prefixed)', async () => {
    setupFs({
      '/audiobooks': [{ name: 'Book', isFile: false }],
      '/audiobooks/Book': [
        { name: '.DS_Store', isFile: true, size: 10 },
        { name: '.hidden_dir', isFile: false },
        { name: 'chapter1.mp3', isFile: true, size: 5000 },
      ],
      // Even if the hidden dir has audio, it should be skipped
      '/audiobooks/Book/.hidden_dir': [
        { name: 'secret.mp3', isFile: true, size: 1000 },
      ],
    });

    const result = await discoverBooks('/audiobooks');
    expect(result).toHaveLength(1);
    expect(result[0]!.audioFileCount).toBe(1);
    expect(result[0]!.totalSize).toBe(5000);
  });

  // ---- Folder structure parsing (folderParts) ----

  it('parses Author/Book structure into folderParts', async () => {
    setupFs({
      '/audiobooks': [{ name: 'Brandon Sanderson', isFile: false }],
      '/audiobooks/Brandon Sanderson': [{ name: 'Mistborn', isFile: false }],
      '/audiobooks/Brandon Sanderson/Mistborn': [
        { name: 'chapter1.mp3', isFile: true, size: 1000 },
      ],
    });

    const result = await discoverBooks('/audiobooks');
    expect(result).toHaveLength(1);
    expect(result[0]!.folderParts).toEqual(['Brandon Sanderson', 'Mistborn']);
  });

  it('parses Author/Series/Book structure into folderParts', async () => {
    setupFs({
      '/audiobooks': [{ name: 'Joe Abercrombie', isFile: false }],
      '/audiobooks/Joe Abercrombie': [{ name: 'First Law', isFile: false }],
      '/audiobooks/Joe Abercrombie/First Law': [{ name: 'The Blade Itself', isFile: false }],
      '/audiobooks/Joe Abercrombie/First Law/The Blade Itself': [
        { name: 'track.m4b', isFile: true, size: 500 },
      ],
    });

    const result = await discoverBooks('/audiobooks');
    expect(result).toHaveLength(1);
    expect(result[0]!.folderParts).toEqual(['Joe Abercrombie', 'First Law', 'The Blade Itself']);
  });

  it('uses root basename as folderParts when audio is in root directory itself', async () => {
    setupFs({
      '/audiobooks': [
        { name: 'track.mp3', isFile: true, size: 1000 },
      ],
    });

    const result = await discoverBooks('/audiobooks');
    expect(result).toHaveLength(1);
    expect(result[0]!.folderParts).toEqual(['audiobooks']);
  });

  // ---- Disc folder merging ----

  describe('disc folder merging', () => {
    it('merges CD1/CD2 subfolders into the parent book', async () => {
      setupFs({
        '/audiobooks': [{ name: 'Long Book', isFile: false }],
        '/audiobooks/Long Book': [
          { name: 'CD1', isFile: false },
          { name: 'CD2', isFile: false },
        ],
        '/audiobooks/Long Book/CD1': [
          { name: 'track01.mp3', isFile: true, size: 2000 },
          { name: 'track02.mp3', isFile: true, size: 3000 },
        ],
        '/audiobooks/Long Book/CD2': [
          { name: 'track01.mp3', isFile: true, size: 2500 },
          { name: 'track02.mp3', isFile: true, size: 3500 },
        ],
      });

      const result = await discoverBooks('/audiobooks');
      expect(result).toHaveLength(1);
      expect(result[0]!.path).toBe('/audiobooks/Long Book');
      expect(result[0]!.audioFileCount).toBe(4);
      expect(result[0]!.totalSize).toBe(11_000);
      expect(result[0]!.folderParts).toEqual(['Long Book']);
    });

    it('merges "Disc 1" / "Disc 2" (with space)', async () => {
      setupFs({
        '/audiobooks': [{ name: 'Book', isFile: false }],
        '/audiobooks/Book': [
          { name: 'Disc 1', isFile: false },
          { name: 'Disc 2', isFile: false },
        ],
        '/audiobooks/Book/Disc 1': [{ name: 'a.mp3', isFile: true, size: 100 }],
        '/audiobooks/Book/Disc 2': [{ name: 'b.mp3', isFile: true, size: 200 }],
      });

      const result = await discoverBooks('/audiobooks');
      expect(result).toHaveLength(1);
      expect(result[0]!.path).toBe('/audiobooks/Book');
      expect(result[0]!.audioFileCount).toBe(2);
    });

    it('merges "Disk 01" / "Disk 02" variant', async () => {
      setupFs({
        '/audiobooks': [{ name: 'Book', isFile: false }],
        '/audiobooks/Book': [
          { name: 'Disk 01', isFile: false },
          { name: 'Disk 02', isFile: false },
        ],
        '/audiobooks/Book/Disk 01': [{ name: 'a.mp3', isFile: true, size: 100 }],
        '/audiobooks/Book/Disk 02': [{ name: 'b.mp3', isFile: true, size: 100 }],
      });

      const result = await discoverBooks('/audiobooks');
      expect(result).toHaveLength(1);
      expect(result[0]!.path).toBe('/audiobooks/Book');
    });

    it('merges case-insensitive disc names (DISC 1, disc 2)', async () => {
      setupFs({
        '/audiobooks': [{ name: 'Book', isFile: false }],
        '/audiobooks/Book': [
          { name: 'DISC 1', isFile: false },
          { name: 'disc 2', isFile: false },
        ],
        '/audiobooks/Book/DISC 1': [{ name: 'a.mp3', isFile: true, size: 100 }],
        '/audiobooks/Book/disc 2': [{ name: 'b.mp3', isFile: true, size: 100 }],
      });

      const result = await discoverBooks('/audiobooks');
      expect(result).toHaveLength(1);
      expect(result[0]!.path).toBe('/audiobooks/Book');
    });

    it('merges "Disc1" / "Disc2" (no space)', async () => {
      setupFs({
        '/audiobooks': [{ name: 'Book', isFile: false }],
        '/audiobooks/Book': [
          { name: 'Disc1', isFile: false },
          { name: 'Disc2', isFile: false },
        ],
        '/audiobooks/Book/Disc1': [{ name: 'a.mp3', isFile: true, size: 100 }],
        '/audiobooks/Book/Disc2': [{ name: 'b.mp3', isFile: true, size: 100 }],
      });

      const result = await discoverBooks('/audiobooks');
      expect(result).toHaveLength(1);
      expect(result[0]!.path).toBe('/audiobooks/Book');
    });

    it('handles three-digit disc numbers (CD001, CD002)', async () => {
      setupFs({
        '/audiobooks': [{ name: 'Book', isFile: false }],
        '/audiobooks/Book': [
          { name: 'CD001', isFile: false },
          { name: 'CD002', isFile: false },
        ],
        '/audiobooks/Book/CD001': [{ name: 'a.mp3', isFile: true, size: 100 }],
        '/audiobooks/Book/CD002': [{ name: 'b.mp3', isFile: true, size: 100 }],
      });

      const result = await discoverBooks('/audiobooks');
      expect(result).toHaveLength(1);
      expect(result[0]!.path).toBe('/audiobooks/Book');
    });

    it('does NOT merge if only one disc folder', async () => {
      setupFs({
        '/audiobooks': [{ name: 'Book', isFile: false }],
        '/audiobooks/Book': [
          { name: 'CD1', isFile: false },
        ],
        '/audiobooks/Book/CD1': [{ name: 'a.mp3', isFile: true, size: 100 }],
      });

      const result = await discoverBooks('/audiobooks');
      // Should discover CD1 as a standalone book folder, not merge
      expect(result).toHaveLength(1);
      expect(result[0]!.path).toBe('/audiobooks/Book/CD1');
    });

    it('does NOT merge folders that do not match disc pattern', async () => {
      setupFs({
        '/audiobooks': [{ name: 'Author', isFile: false }],
        '/audiobooks/Author': [
          { name: 'Book One', isFile: false },
          { name: 'Book Two', isFile: false },
        ],
        '/audiobooks/Author/Book One': [{ name: 'a.mp3', isFile: true, size: 100 }],
        '/audiobooks/Author/Book Two': [{ name: 'b.mp3', isFile: true, size: 200 }],
      });

      const result = await discoverBooks('/audiobooks');
      expect(result).toHaveLength(2);
      const paths = result.map(r => r.path).sort();
      expect(paths).toEqual(['/audiobooks/Author/Book One', '/audiobooks/Author/Book Two']);
    });

    it('does NOT merge "Part 1" / "Part 2" folders (not disc pattern)', async () => {
      setupFs({
        '/audiobooks': [{ name: 'Book', isFile: false }],
        '/audiobooks/Book': [
          { name: 'Part 1', isFile: false },
          { name: 'Part 2', isFile: false },
        ],
        '/audiobooks/Book/Part 1': [{ name: 'a.mp3', isFile: true, size: 100 }],
        '/audiobooks/Book/Part 2': [{ name: 'b.mp3', isFile: true, size: 100 }],
      });

      const result = await discoverBooks('/audiobooks');
      expect(result).toHaveLength(2);
    });

    it('does NOT merge "01 - Title" numeric folders', async () => {
      setupFs({
        '/audiobooks': [{ name: 'Book', isFile: false }],
        '/audiobooks/Book': [
          { name: '01 - Chapter One', isFile: false },
          { name: '02 - Chapter Two', isFile: false },
        ],
        '/audiobooks/Book/01 - Chapter One': [{ name: 'a.mp3', isFile: true, size: 100 }],
        '/audiobooks/Book/02 - Chapter Two': [{ name: 'b.mp3', isFile: true, size: 100 }],
      });

      const result = await discoverBooks('/audiobooks');
      expect(result).toHaveLength(2);
    });

    it('does NOT merge if some children match disc pattern but others do not', async () => {
      // Mixed: CD1 + CD2 + "Bonus Material" all have audio
      setupFs({
        '/audiobooks': [{ name: 'Book', isFile: false }],
        '/audiobooks/Book': [
          { name: 'CD1', isFile: false },
          { name: 'CD2', isFile: false },
          { name: 'Bonus Material', isFile: false },
        ],
        '/audiobooks/Book/CD1': [{ name: 'a.mp3', isFile: true, size: 100 }],
        '/audiobooks/Book/CD2': [{ name: 'b.mp3', isFile: true, size: 100 }],
        '/audiobooks/Book/Bonus Material': [{ name: 'c.mp3', isFile: true, size: 100 }],
      });

      const result = await discoverBooks('/audiobooks');
      // "Bonus Material" is not a disc folder, so disc merge condition fails
      // (discChildren.length !== immediateAudioChildren.length)
      // All three are treated as individual books
      expect(result).toHaveLength(3);
    });
  });

  // ---- DISC_FOLDER_PATTERN regex edge cases ----

  describe('DISC_FOLDER_PATTERN edge cases', () => {
    // Helper: check if a folder name triggers disc merging when paired with another disc folder
    async function isDiscMerged(folderName: string): Promise<boolean> {
      vi.clearAllMocks();
      setupFs({
        '/audiobooks': [{ name: 'Book', isFile: false }],
        '/audiobooks/Book': [
          { name: folderName, isFile: false },
          { name: 'CD2', isFile: false }, // always a valid disc folder as pair
        ],
        [`/audiobooks/Book/${folderName}`]: [{ name: 'a.mp3', isFile: true, size: 100 }],
        '/audiobooks/Book/CD2': [{ name: 'b.mp3', isFile: true, size: 100 }],
      });

      const result = await discoverBooks('/audiobooks');
      // If merged, we get 1 result at parent. If not, we get 2 separate.
      return result.length === 1 && result[0]!.path === '/audiobooks/Book';
    }

    it.each(['CD1', 'CD 1', 'cd1', 'cd 1', 'CD 01', 'CD 001'])(
      'matches "%s" as disc folder',
      async (name) => {
        expect(await isDiscMerged(name)).toBe(true);
      },
    );

    it.each(['Disc1', 'Disc 1', 'disc1', 'DISC 1', 'Disc 01', 'DISC 003'])(
      'matches "%s" as disc folder',
      async (name) => {
        expect(await isDiscMerged(name)).toBe(true);
      },
    );

    it.each(['Disk1', 'Disk 1', 'disk1', 'DISK 1', 'Disk 03'])(
      'matches "%s" as disc folder',
      async (name) => {
        expect(await isDiscMerged(name)).toBe(true);
      },
    );

    it.each([
      'Part 1',
      'Volume 1',
      'Book 1',
      'Chapter 1',
      '01',
      '01 - Intro',
      'CD',          // no number
      'Disc',        // no number
      'CD 1234',     // 4 digits (pattern allows 1-3)
      'CD1 bonus',   // trailing text
      'my CD1',      // leading text
    ])(
      'does NOT match "%s" as disc folder',
      async (name) => {
        expect(await isDiscMerged(name)).toBe(false);
      },
    );
  });

  // ---- Parent has audio files (leaf folder behavior) ----

  it('treats parent as leaf when it has its own audio and NO audio-containing children', async () => {
    setupFs({
      '/audiobooks': [{ name: 'Book', isFile: false }],
      '/audiobooks/Book': [
        { name: 'main.mp3', isFile: true, size: 5000 },
        { name: 'extras', isFile: false },
      ],
      '/audiobooks/Book/extras': [
        { name: 'cover.jpg', isFile: true, size: 1000 },
      ],
    });

    const result = await discoverBooks('/audiobooks');
    // Parent has audio, subfolder has no audio -> leaf
    expect(result).toHaveLength(1);
    expect(result[0]!.path).toBe('/audiobooks/Book');
    expect(result[0]!.audioFileCount).toBe(1);
    expect(result[0]!.totalSize).toBe(5000);
  });

  // ---- Multiple books at same level ----

  it('discovers multiple books at the same level', async () => {
    setupFs({
      '/audiobooks': [
        { name: 'Book A', isFile: false },
        { name: 'Book B', isFile: false },
        { name: 'Book C', isFile: false },
      ],
      '/audiobooks/Book A': [{ name: 'a.mp3', isFile: true, size: 100 }],
      '/audiobooks/Book B': [{ name: 'b.m4b', isFile: true, size: 200 }],
      '/audiobooks/Book C': [{ name: 'c.flac', isFile: true, size: 300 }],
    });

    const result = await discoverBooks('/audiobooks');
    expect(result).toHaveLength(3);
    const titles = result.map(r => r.folderParts[0]).sort();
    expect(titles).toEqual(['Book A', 'Book B', 'Book C']);
  });

  // ---- Deeply nested structures ----

  it('discovers books in deeply nested Author/Series/Book structure', async () => {
    setupFs({
      '/audiobooks': [{ name: 'Author', isFile: false }],
      '/audiobooks/Author': [{ name: 'Series', isFile: false }],
      '/audiobooks/Author/Series': [
        { name: 'Book 1', isFile: false },
        { name: 'Book 2', isFile: false },
      ],
      '/audiobooks/Author/Series/Book 1': [{ name: 'a.mp3', isFile: true, size: 100 }],
      '/audiobooks/Author/Series/Book 2': [{ name: 'b.mp3', isFile: true, size: 200 }],
    });

    const result = await discoverBooks('/audiobooks');
    expect(result).toHaveLength(2);
    expect(result[0]!.folderParts).toEqual(['Author', 'Series', 'Book 1']);
    expect(result[1]!.folderParts).toEqual(['Author', 'Series', 'Book 2']);
  });

  // ---- Empty subdirectory (no audio anywhere) ----

  it('skips empty subdirectories', async () => {
    setupFs({
      '/audiobooks': [
        { name: 'empty', isFile: false },
        { name: 'has-audio', isFile: false },
      ],
      '/audiobooks/empty': [],
      '/audiobooks/has-audio': [{ name: 'track.mp3', isFile: true, size: 500 }],
    });

    const result = await discoverBooks('/audiobooks');
    expect(result).toHaveLength(1);
    expect(result[0]!.folderParts).toEqual(['has-audio']);
  });

  // ---- Stat failure on a file ----

  it('skips files that fail stat()', async () => {
    mockReaddir.mockImplementation(async (dirPath: unknown) => {
      const key = String(dirPath);
      if (key === '/audiobooks') {
        return [makeDirent('Book', false)] as never;
      }
      if (key === '/audiobooks/Book') {
        return [
          makeDirent('bad.mp3', true),
          makeDirent('good.mp3', true),
        ] as never;
      }
      throw new Error('ENOENT');
    });

    mockStat.mockImplementation(async (filePath: unknown) => {
      const key = String(filePath);
      if (key === '/audiobooks/Book/bad.mp3') {
        throw new Error('EACCES');
      }
      return { size: 2000 } as never;
    });

    const result = await discoverBooks('/audiobooks');
    expect(result).toHaveLength(1);
    expect(result[0]!.audioFileCount).toBe(1);
    expect(result[0]!.totalSize).toBe(2000);
  });

  // ---- Logger integration ----

  it('calls logger.debug when log option is provided', async () => {
    setupFs({
      '/audiobooks': [{ name: 'Book', isFile: false }],
      '/audiobooks/Book': [{ name: 'a.mp3', isFile: true, size: 100 }],
    });

    const log: DiscoveryLogger = { debug: vi.fn() };
    await discoverBooks('/audiobooks', { log });

    expect(log.debug).toHaveBeenCalledWith(
      { rootPath: '/audiobooks' },
      'Starting book discovery',
    );
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: '/audiobooks', discovered: 1 }),
      'Book discovery complete',
    );
    // Leaf folder classifier decision/reason
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ fileCount: 1, decision: 'merge', reason: 'single-file' }),
      'Leaf folder classified',
    );
  });

  it('does not throw when no logger is provided', async () => {
    setupFs({
      '/audiobooks': [{ name: 'Book', isFile: false }],
      '/audiobooks/Book': [{ name: 'a.mp3', isFile: true, size: 100 }],
    });

    // Just verifying no crash — no logger passed
    const result = await discoverBooks('/audiobooks');
    expect(result).toHaveLength(1);
  });

  it('logs disc folder merge event', async () => {
    setupFs({
      '/audiobooks': [{ name: 'Book', isFile: false }],
      '/audiobooks/Book': [
        { name: 'CD1', isFile: false },
        { name: 'CD2', isFile: false },
      ],
      '/audiobooks/Book/CD1': [{ name: 'a.mp3', isFile: true, size: 100 }],
      '/audiobooks/Book/CD2': [{ name: 'b.mp3', isFile: true, size: 100 }],
    });

    const log: DiscoveryLogger = { debug: vi.fn() };
    await discoverBooks('/audiobooks', { log });

    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ mergedAudioFiles: 2 }),
      'Disc folder merge',
    );
  });

  // ---- Disc merge with nested audio in disc subfolders ----

  it('collects audio files recursively from disc subfolders during merge', async () => {
    setupFs({
      '/audiobooks': [{ name: 'Book', isFile: false }],
      '/audiobooks/Book': [
        { name: 'CD1', isFile: false },
        { name: 'CD2', isFile: false },
      ],
      '/audiobooks/Book/CD1': [
        { name: 'track1.mp3', isFile: true, size: 100 },
        { name: 'sub', isFile: false },
      ],
      '/audiobooks/Book/CD1/sub': [
        { name: 'track2.mp3', isFile: true, size: 200 },
      ],
      '/audiobooks/Book/CD2': [
        { name: 'track3.mp3', isFile: true, size: 300 },
      ],
    });

    const result = await discoverBooks('/audiobooks');
    expect(result).toHaveLength(1);
    expect(result[0]!.path).toBe('/audiobooks/Book');
    expect(result[0]!.audioFileCount).toBe(3);
    expect(result[0]!.totalSize).toBe(600);
  });

  // ---- Non-disc children alongside disc merge ----

  it('recurses into non-disc children even when disc merge happens', async () => {
    setupFs({
      '/audiobooks': [{ name: 'Collection', isFile: false }],
      '/audiobooks/Collection': [
        { name: 'CD1', isFile: false },
        { name: 'CD2', isFile: false },
        { name: 'Extra', isFile: false }, // no audio directly, but has a deeper book
      ],
      '/audiobooks/Collection/CD1': [{ name: 'a.mp3', isFile: true, size: 100 }],
      '/audiobooks/Collection/CD2': [{ name: 'b.mp3', isFile: true, size: 100 }],
      '/audiobooks/Collection/Extra': [{ name: 'Bonus Book', isFile: false }],
      '/audiobooks/Collection/Extra/Bonus Book': [{ name: 'c.mp3', isFile: true, size: 100 }],
    });

    const result = await discoverBooks('/audiobooks');
    expect(result).toHaveLength(2);
    const paths = result.map(r => r.path).sort();
    expect(paths).toEqual(['/audiobooks/Collection', '/audiobooks/Collection/Extra/Bonus Book']);
  });

  // ---- Mixed: author with separate books, not disc pattern ----

  it('handles Author folder with two separate books (not disc folders)', async () => {
    setupFs({
      '/audiobooks': [{ name: 'Stephen King', isFile: false }],
      '/audiobooks/Stephen King': [
        { name: 'The Stand', isFile: false },
        { name: 'It', isFile: false },
      ],
      '/audiobooks/Stephen King/The Stand': [
        { name: 'ch1.mp3', isFile: true, size: 1000 },
      ],
      '/audiobooks/Stephen King/It': [
        { name: 'ch1.mp3', isFile: true, size: 2000 },
      ],
    });

    const result = await discoverBooks('/audiobooks');
    expect(result).toHaveLength(2);
    expect(result.find(r => r.folderParts.includes('The Stand'))?.totalSize).toBe(1000);
    expect(result.find(r => r.folderParts.includes('It'))?.totalSize).toBe(2000);
  });

  // ---- Case-insensitive extension matching ----

  it('handles uppercase audio extensions', async () => {
    setupFs({
      '/audiobooks': [{ name: 'Book', isFile: false }],
      '/audiobooks/Book': [
        { name: 'TRACK.MP3', isFile: true, size: 500 },
        { name: 'TRACK2.M4B', isFile: true, size: 600 },
      ],
    });

    const result = await discoverBooks('/audiobooks');
    expect(result).toHaveLength(1);
    expect(result[0]!.audioFileCount).toBe(2);
  });

  // ---- totalSize aggregation ----

  it('correctly sums totalSize across all audio files', async () => {
    setupFs({
      '/audiobooks': [{ name: 'Book', isFile: false }],
      '/audiobooks/Book': [
        { name: 'a.mp3', isFile: true, size: 1 },
        { name: 'b.mp3', isFile: true, size: 2 },
        { name: 'c.mp3', isFile: true, size: 3 },
        { name: 'd.mp3', isFile: true, size: 4 },
      ],
    });

    const result = await discoverBooks('/audiobooks');
    expect(result[0]!.totalSize).toBe(10);
  });

  it('handles rootPath that is a substring of deeper path segments', async () => {
    setupFs({
      '/ab': [{ name: 'ab', isFile: false }],
      '/ab/ab': [{ name: 'book', isFile: false }],
      '/ab/ab/book': [{ name: 'track.mp3', isFile: true, size: 100 }],
    });

    const result = await discoverBooks('/ab');
    expect(result).toHaveLength(1);
    // path.relative('/ab', '/ab/ab/book') = 'ab/book' — correct
    expect(result[0]!.folderParts).toEqual(['ab', 'book']);
  });

  // ---- Mixed-content folders (loose audio + audio subfolders) ----

  describe('mixed-content folders', () => {
    it('root with 2 loose audio files + audio subfolders → 3 rows (no weak-evidence absorption per #1048)', async () => {
      // Pre-#1048 the leaf classifier's size-guard merge bias drove mixed-content
      // absorption: 2 distinct-titled loose files (1KB, 2KB) below the 120MB
      // size threshold returned merge with reason `files-too-small-for-full-books`,
      // and the entire subtree was absorbed into one parent row.
      //
      // Post-#1048 the mixed-content branch requires `hasStrongChapterSetEvidence`
      // (strict marker-set / numeric-only / all-same-stem rules). Distinct stems
      // `loose1`/`loose2` carry no markers and don't normalize to a single
      // value, so absorption is rejected — loose files split per-file and the
      // child folder is recursed.
      setupFs({
        '/audiobooks': [
          { name: 'loose1.m4b', isFile: true, size: 1000 },
          { name: 'loose2.m4b', isFile: true, size: 2000 },
          { name: 'Author', isFile: false },
        ],
        '/audiobooks/Author': [{ name: 'Book1', isFile: false }],
        '/audiobooks/Author/Book1': [{ name: 'chapter.mp3', isFile: true, size: 5000 }],
      });

      const result = await discoverBooks('/audiobooks');
      expect(result).toHaveLength(3);
      const paths = result.map(r => r.path).sort();
      expect(paths).toEqual([
        '/audiobooks/Author/Book1',
        '/audiobooks/loose1.m4b',
        '/audiobooks/loose2.m4b',
      ]);
    });

    it('root with 3 distinct large named loose files + audio subfolder, classifier returns split → 3 per-file rows + 1 child row from recursion', async () => {
      // AC6: 3 distinct large files (340 MB each) with title-bearing stems
      // → classifier returns 'split'. Loose audio is per-file emitted, AND
      // the child folder is recursed into.
      const LARGE_BOOK = 340 * 1024 * 1024;
      setupFs({
        '/audiobooks': [
          { name: 'Mistborn 01 - The Final Empire.mp3', isFile: true, size: LARGE_BOOK },
          { name: 'Mistborn 02 - The Well of Ascension.mp3', isFile: true, size: LARGE_BOOK },
          { name: 'Mistborn 03 - The Hero of Ages.mp3', isFile: true, size: LARGE_BOOK },
          { name: 'Cover', isFile: false },
        ],
        '/audiobooks/Cover': [{ name: 'art.mp3', isFile: true, size: 5000 }],
      });

      const result = await discoverBooks('/audiobooks');
      const paths = result.map(r => r.path).sort();
      expect(paths).toEqual([
        '/audiobooks/Cover',
        '/audiobooks/Mistborn 01 - The Final Empire.mp3',
        '/audiobooks/Mistborn 02 - The Well of Ascension.mp3',
        '/audiobooks/Mistborn 03 - The Hero of Ages.mp3',
      ]);
    });

    it('nested folder with loose audio + book subfolders emits loose file as single-file book AND discovers folder books', async () => {
      setupFs({
        '/audiobooks': [{ name: 'Author', isFile: false }],
        '/audiobooks/Author': [
          { name: 'bonus.mp3', isFile: true, size: 500 },
          { name: 'Book1', isFile: false },
          { name: 'Book2', isFile: false },
        ],
        '/audiobooks/Author/Book1': [{ name: 'ch.mp3', isFile: true, size: 1000 }],
        '/audiobooks/Author/Book2': [{ name: 'ch.mp3', isFile: true, size: 2000 }],
      });

      const result = await discoverBooks('/audiobooks');
      expect(result).toHaveLength(3);
      const paths = result.map(r => r.path).sort();
      expect(paths).toEqual([
        '/audiobooks/Author/Book1',
        '/audiobooks/Author/Book2',
        '/audiobooks/Author/bonus.mp3',
      ]);
      const bonus = result.find(r => r.path === '/audiobooks/Author/bonus.mp3')!;
      expect(bonus.audioFileCount).toBe(1);
      expect(bonus.totalSize).toBe(500);
      expect(bonus.folderParts).toEqual(['Author', 'bonus.mp3']);
    });

    it('deep nesting: intermediate folder at depth 3+ with loose audio + audio children emits loose AND recurses', async () => {
      setupFs({
        '/audiobooks': [{ name: 'Author', isFile: false }],
        '/audiobooks/Author': [{ name: 'Series', isFile: false }],
        '/audiobooks/Author/Series': [
          { name: 'extra.flac', isFile: true, size: 300 },
          { name: 'Book1', isFile: false },
        ],
        '/audiobooks/Author/Series/Book1': [{ name: 'ch.mp3', isFile: true, size: 1000 }],
      });

      const result = await discoverBooks('/audiobooks');
      expect(result).toHaveLength(2);
      const paths = result.map(r => r.path).sort();
      expect(paths).toEqual([
        '/audiobooks/Author/Series/Book1',
        '/audiobooks/Author/Series/extra.flac',
      ]);
      const extra = result.find(r => r.path === '/audiobooks/Author/Series/extra.flac')!;
      expect(extra.folderParts).toEqual(['Author', 'Series', 'extra.flac']);
    });

    it('single loose audio file + audio subfolders emits the single file as its own book', async () => {
      setupFs({
        '/audiobooks': [
          { name: 'stray.mp3', isFile: true, size: 100 },
          { name: 'Book', isFile: false },
        ],
        '/audiobooks/Book': [{ name: 'ch.mp3', isFile: true, size: 5000 }],
      });

      const result = await discoverBooks('/audiobooks');
      expect(result).toHaveLength(2);
      const paths = result.map(r => r.path).sort();
      expect(paths).toEqual(['/audiobooks/Book', '/audiobooks/stray.mp3']);
    });

    it('loose audio files + exactly one audio subfolder emits the loose file as its own book', async () => {
      setupFs({
        '/audiobooks': [
          { name: 'loose.m4b', isFile: true, size: 100 },
          { name: 'OnlyBook', isFile: false },
        ],
        '/audiobooks/OnlyBook': [{ name: 'ch.mp3', isFile: true, size: 2000 }],
      });

      const result = await discoverBooks('/audiobooks');
      expect(result).toHaveLength(2);
      const paths = result.map(r => r.path).sort();
      expect(paths).toEqual(['/audiobooks/OnlyBook', '/audiobooks/loose.m4b']);
    });

    it('loose audio files + non-audio-only subfolders treated as single book (leaf)', async () => {
      setupFs({
        '/audiobooks': [
          { name: 'track.mp3', isFile: true, size: 1000 },
          { name: 'images', isFile: false },
        ],
        '/audiobooks/images': [{ name: 'cover.jpg', isFile: true, size: 500 }],
      });

      const result = await discoverBooks('/audiobooks');
      // No audio children, so hasOwnAudio + no audioChildren = leaf
      expect(result).toHaveLength(1);
      expect(result[0]!.path).toBe('/audiobooks');
      expect(result[0]!.audioFileCount).toBe(1);
    });

    describe('mixed-content classifier merge + bonus-content review flag (#1031, #1051)', () => {
      // The Heir fixture (`heirChapters()` below) uses real-world torrent
      // filenames `NN Heir to the Empire.mp3`, not synthetic `Chapter NN.mp3`.
      // The original #1031 fixture used the synthetic shape, which silently
      // matched MERGE_MARKER_RE and passed via the marker-set rule — masking
      // the fact that real-world torrents overwhelmingly use
      // `<digits><space><title>` (no "Chapter" keyword), which neither the
      // marker rule nor the normalizer's `[-_.]`-only separator strip catch.
      // When a NEW fixture is meant to REPLICATE the Heir bug shape (i.e.
      // exercise `hasStrongChapterSetEvidence` through the mixed-content
      // branch), it MUST mirror real-world filename conventions; synthetic
      // marker-keyword fixtures are only appropriate when the test
      // specifically targets the leaf-classifier marker path.
      const SMALL_CHAPTER = 30 * 1024 * 1024;
      const HEIR_PARENT = '/audiobooks/Heir to the Empire';

      function heirChapters() {
        return Array.from({ length: 28 }, (_, i) => ({
          name: `${String(i + 1).padStart(2, '0')} Heir to the Empire.mp3`,
          isFile: true as const,
          size: SMALL_CHAPTER,
        }));
      }

      function heirFixture() {
        return {
          '/audiobooks': [{ name: 'Heir to the Empire', isFile: false }],
          [HEIR_PARENT]: [
            ...heirChapters(),
            { name: 'Excerpt- Behind the Scenes', isFile: false },
          ],
          [`${HEIR_PARENT}/Excerpt- Behind the Scenes`]: [
            { name: 'track.mp3', isFile: true, size: 5_000_000 },
          ],
        };
      }

      beforeEach(() => {
        mockReadAlbumTag.mockReset();
        mockReadAlbumTag.mockResolvedValue(undefined);
      });

      it('AC5/AC9: Heir fixture (28 chapters + Excerpt subdir) emits ONE parent-path row with audioFileCount=29 and review reason set', async () => {
        setupFs(heirFixture());
        // Both signals would fire (subdir name AND album mismatch) — but
        // subdir-name fires first, so we don't even need the tag mock for
        // this AC. Configure it anyway for realism.
        mockReadAlbumTag.mockImplementation(async (filePath: string) => {
          if (filePath.includes('Excerpt')) return 'Behind the Scenes';
          return 'Heir to the Empire';
        });

        const result = await discoverBooks('/audiobooks');
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
          path: HEIR_PARENT,
          audioFileCount: 29,
          totalSize: 28 * SMALL_CHAPTER + 5_000_000,
          reviewReason: 'Additional non-book content possibly merged',
        });
      });

      it('AC4: classifier-merge mixed-content does NOT recurse into audioChildren (no duplicate row for the absorbed subdir)', async () => {
        setupFs(heirFixture());
        const result = await discoverBooks('/audiobooks');
        const excerptPaths = result
          .map(r => r.path)
          .filter(p => p.includes('Excerpt'));
        expect(excerptPaths).toEqual([]);
      });

      it('AC10: clean chapter-encoded fixture (no subdirs) → no review reason', async () => {
        const chapters = Array.from({ length: 12 }, (_, i) => ({
          name: `Chapter ${String(i + 1).padStart(2, '0')}.mp3`,
          isFile: true,
          size: SMALL_CHAPTER,
        }));
        setupFs({
          '/audiobooks': [{ name: 'Plain Book', isFile: false }],
          '/audiobooks/Plain Book': chapters,
        });

        const result = await discoverBooks('/audiobooks');
        expect(result).toHaveLength(1);
        expect(result[0]).not.toHaveProperty('reviewReason');
      });

      it('AC11: non-bonus subdir name + matching album → no review reason', async () => {
        // Subdir name "Author Notes" doesn't match the bonus regex; both
        // top-level and absorbed audio share the same album → no signal.
        const chapters = Array.from({ length: 6 }, (_, i) => ({
          name: `Chapter ${String(i + 1).padStart(2, '0')}.mp3`,
          isFile: true,
          size: SMALL_CHAPTER,
        }));
        setupFs({
          '/audiobooks': [{ name: 'Book', isFile: false }],
          '/audiobooks/Book': [
            ...chapters,
            { name: 'Author Notes', isFile: false },
          ],
          '/audiobooks/Book/Author Notes': [
            { name: 'note.mp3', isFile: true, size: 1_000_000 },
          ],
        });
        mockReadAlbumTag.mockResolvedValue('Same Book Album');

        const result = await discoverBooks('/audiobooks');
        expect(result).toHaveLength(1);
        expect(result[0]).not.toHaveProperty('reviewReason');
      });

      it('AC13: tag-probe failure during album comparison does not throw — falls back to subdir-name signal only', async () => {
        // Subdir name "Author Notes" — no name signal. All tag reads return
        // undefined (simulates parseFile rejection). Detection completes
        // gracefully with no review reason set.
        const chapters = Array.from({ length: 6 }, (_, i) => ({
          name: `Chapter ${String(i + 1).padStart(2, '0')}.mp3`,
          isFile: true,
          size: SMALL_CHAPTER,
        }));
        setupFs({
          '/audiobooks': [{ name: 'Book', isFile: false }],
          '/audiobooks/Book': [
            ...chapters,
            { name: 'Author Notes', isFile: false },
          ],
          '/audiobooks/Book/Author Notes': [
            { name: 'note.mp3', isFile: true, size: 1_000_000 },
          ],
        });
        mockReadAlbumTag.mockResolvedValue(undefined);

        const result = await discoverBooks('/audiobooks');
        expect(result).toHaveLength(1);
        expect(result[0]).not.toHaveProperty('reviewReason');
      });

      it('AC14: missing album on top-level audio → no album mismatch signal', async () => {
        // Subdir name "Notes" doesn't match bonus regex; top-level album
        // empty so we can't detect mismatch — no signal.
        const chapters = Array.from({ length: 6 }, (_, i) => ({
          name: `Chapter ${String(i + 1).padStart(2, '0')}.mp3`,
          isFile: true,
          size: SMALL_CHAPTER,
        }));
        setupFs({
          '/audiobooks': [{ name: 'Book', isFile: false }],
          '/audiobooks/Book': [
            ...chapters,
            { name: 'Notes', isFile: false },
          ],
          '/audiobooks/Book/Notes': [
            { name: 'note.mp3', isFile: true, size: 1_000_000 },
          ],
        });
        mockReadAlbumTag.mockImplementation(async (filePath: string) => {
          if (filePath.includes('Notes')) return 'Different Album';
          return undefined;
        });

        const result = await discoverBooks('/audiobooks');
        expect(result).toHaveLength(1);
        expect(result[0]).not.toHaveProperty('reviewReason');
      });

      it('AC14: missing album on absorbed-descendant audio → no album mismatch signal', async () => {
        const chapters = Array.from({ length: 6 }, (_, i) => ({
          name: `Chapter ${String(i + 1).padStart(2, '0')}.mp3`,
          isFile: true,
          size: SMALL_CHAPTER,
        }));
        setupFs({
          '/audiobooks': [{ name: 'Book', isFile: false }],
          '/audiobooks/Book': [
            ...chapters,
            { name: 'Notes', isFile: false },
          ],
          '/audiobooks/Book/Notes': [
            { name: 'note.mp3', isFile: true, size: 1_000_000 },
          ],
        });
        mockReadAlbumTag.mockImplementation(async (filePath: string) => {
          if (filePath.includes('Notes')) return undefined;
          return 'Real Book Album';
        });

        const result = await discoverBooks('/audiobooks');
        expect(result).toHaveLength(1);
        expect(result[0]).not.toHaveProperty('reviewReason');
      });

      it('AC8 (#1051): real-world Heir without bonus subdir → ONE row, no review reason', async () => {
        // Clean 28-chapter set with no subdir. Exercises the new
        // leading-numeric-prefix rule end-to-end through discovery.
        setupFs({
          '/audiobooks': [{ name: 'Heir to the Empire', isFile: false }],
          [HEIR_PARENT]: heirChapters(),
        });

        const result = await discoverBooks('/audiobooks');
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
          path: HEIR_PARENT,
          audioFileCount: 28,
        });
        expect(result[0]).not.toHaveProperty('reviewReason');
      });

      it('AC9 (#1051): trailing-digits "Heir to the Empire NN" → ONE merged row via existing distinct===1 rule', async () => {
        const chapters = Array.from({ length: 12 }, (_, i) => ({
          name: `Heir to the Empire ${String(i + 1).padStart(2, '0')}.mp3`,
          isFile: true as const,
          size: SMALL_CHAPTER,
        }));
        setupFs({
          '/audiobooks': [{ name: 'Heir to the Empire', isFile: false }],
          [HEIR_PARENT]: chapters,
        });

        const result = await discoverBooks('/audiobooks');
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
          path: HEIR_PARENT,
          audioFileCount: 12,
        });
      });

      it('AC10 (#1051) adversarial: "01 Book A"/"01 Book B"/"01 Book C" loose at root → 3 split rows, NOT one merged', async () => {
        // Each is "track 1" of a different book. Distinct title portions after
        // prefix strip → no merge. Discovery must emit per-file rows even
        // though every stem has the leading-numeric prefix.
        setupFs({
          '/audiobooks': [
            { name: '01 Book A.mp3', isFile: true, size: 200 * 1024 * 1024 },
            { name: '01 Book B.mp3', isFile: true, size: 200 * 1024 * 1024 },
            { name: '01 Book C.mp3', isFile: true, size: 200 * 1024 * 1024 },
            { name: 'Author A', isFile: false },
          ],
          '/audiobooks/Author A': [{ name: 'ch.mp3', isFile: true, size: 5_000_000 }],
        });

        const result = await discoverBooks('/audiobooks');
        // 3 distinct loose books at root + 1 child book in subdir.
        expect(result).toHaveLength(4);
        const looseRows = result.filter(r => r.path.endsWith('.mp3') && r.path.startsWith('/audiobooks/0'));
        expect(looseRows).toHaveLength(3);
        for (const row of looseRows) {
          expect(row.audioFileCount).toBe(1);
        }
        expect(result.find(r => r.path === '/audiobooks')).toBeUndefined();
      });

      it('album-mismatch signal alone (subdir name harmless) sets review reason', async () => {
        // Subdir "Notes" — doesn't match bonus regex. Albums differ →
        // signal fires via album mismatch.
        const chapters = Array.from({ length: 6 }, (_, i) => ({
          name: `Chapter ${String(i + 1).padStart(2, '0')}.mp3`,
          isFile: true,
          size: SMALL_CHAPTER,
        }));
        setupFs({
          '/audiobooks': [{ name: 'Book', isFile: false }],
          '/audiobooks/Book': [
            ...chapters,
            { name: 'Notes', isFile: false },
          ],
          '/audiobooks/Book/Notes': [
            { name: 'note.mp3', isFile: true, size: 1_000_000 },
          ],
        });
        mockReadAlbumTag.mockImplementation(async (filePath: string) => {
          if (filePath.includes('Notes')) return 'Some Other Album';
          return 'Heir to the Empire';
        });

        const result = await discoverBooks('/audiobooks');
        expect(result).toHaveLength(1);
        expect(result[0]!.reviewReason).toBe('Additional non-book content possibly merged');
      });
    });

    // ----- Adversarial import-root fixtures (#1048) -----
    //
    // AC14: tests in this block model "user points Manual Import at a messy
    // real download directory," not just intended book layouts. The shipped
    // #1031 implementation passed end-to-end review without anyone flagging
    // that the leaf classifier's merge bias would cause recursive subtree
    // absorption when the same classifier drove the mixed-content branch.
    // Future discovery changes MUST include at least one fixture of this
    // shape — distinct loose top-level audio + many audio-bearing subdirs —
    // and verify that absorption requires strict structural evidence, not
    // count caps or size heuristics.
    //
    // The invariant: adding a chapter/disc/part token to one loose top-level
    // file must not cause unrelated sibling files or child directories to be
    // absorbed into a single discovery row.
    describe('adversarial mixed-content import roots (#1048)', () => {
      const LARGE_BOOK = 200 * 1024 * 1024;

      // Pool of genuinely distinct title stems — chosen to NOT collapse under
      // `normalizeStemForComparison` (which strips trailing ` \d+`). Trailing
      // digits would defeat AC10's "distinct stems" premise.
      const DISTINCT_TITLES = [
        'Killing Floor', 'Die Trying', 'Tripwire', 'Running Blind', 'Echo Burning',
        'Without Fail', 'Persuader', 'The Enemy', 'One Shot', 'The Hard Way',
        'Bad Luck and Trouble', 'Nothing to Lose', 'Gone Tomorrow', 'Worth Dying For',
        'The Affair', 'A Wanted Man', 'Never Go Back', 'Personal', 'Make Me',
        'Night School', 'No Middle Name', 'The Midnight Line', 'Past Tense',
        'Blue Moon', 'The Sentinel', 'Better Off Dead', 'No Plan B', 'The Secret',
        'In Too Deep', 'Second Son', 'Deep Down', 'High Heat', 'Not a Drill',
        'Small Wars', 'James Penney', 'Everyone Talks', 'The Christmas Scorpion',
      ];

      function distinctTitleStems(count: number, withMarkerOnFirst = false): { name: string; isFile: true; size: number }[] {
        if (count > DISTINCT_TITLES.length) {
          throw new Error(`distinctTitleStems: requested ${count} but pool has ${DISTINCT_TITLES.length}`);
        }
        return Array.from({ length: count }, (_, i) => {
          if (i === 0 && withMarkerOnFirst) {
            return { name: `Sixth Realm Part 1.m4b` as const, isFile: true, size: LARGE_BOOK };
          }
          return { name: `${DISTINCT_TITLES[i]!}.m4b`, isFile: true as const, size: LARGE_BOOK };
        });
      }

      it('AC10: 37 distinct large loose .m4b files + many audio subdirs → 37 split rows + per-subdir rows', async () => {
        const looseFiles = distinctTitleStems(37);
        setupFs({
          '/audiobooks': [
            ...looseFiles,
            { name: 'Author A', isFile: false },
            { name: 'Author B', isFile: false },
          ],
          '/audiobooks/Author A': [{ name: 'BookA', isFile: false }],
          '/audiobooks/Author A/BookA': [{ name: 'ch.mp3', isFile: true, size: 5_000_000 }],
          '/audiobooks/Author B': [{ name: 'BookB', isFile: false }],
          '/audiobooks/Author B/BookB': [{ name: 'ch.mp3', isFile: true, size: 5_000_000 }],
        });

        const result = await discoverBooks('/audiobooks');
        expect(result).toHaveLength(39); // 37 loose + 2 child books
        const looseRows = result.filter(r => r.path.endsWith('.m4b'));
        expect(looseRows).toHaveLength(37);
        for (const row of looseRows) {
          expect(row.audioFileCount).toBe(1);
          expect(row.path.startsWith('/audiobooks/')).toBe(true);
        }
        // No row at the parent path absorbing the entire subtree.
        expect(result.find(r => r.path === '/audiobooks')).toBeUndefined();
      });

      it('AC11: 37 distinct large loose .m4b files (NO markers) + audio subdirs → splits (count cap NOT consulted)', async () => {
        // Pins the count-cap-driven absorption regression specifically: the
        // leaf classifier returns merge with reason `count-exceeds-cap` for
        // 37 files, but mixed-content must NOT consult that.
        const looseFiles = distinctTitleStems(37, /* withMarkerOnFirst */ false);
        setupFs({
          '/audiobooks': [
            ...looseFiles,
            { name: 'BookFolder', isFile: false },
          ],
          '/audiobooks/BookFolder': [{ name: 'ch.mp3', isFile: true, size: 5_000_000 }],
        });

        const result = await discoverBooks('/audiobooks');
        // 37 split loose + 1 child = 38 rows. No parent absorption.
        expect(result).toHaveLength(38);
        expect(result.find(r => r.path === '/audiobooks')).toBeUndefined();
      });

      it('AC12: 25 loose files where exactly one stem contains " Part 1" → splits (`.some()` regression)', async () => {
        // Pins the `.some()` regression: pre-#1048 a single stray Part-marker
        // stem caused whole-batch merge. With ALL-stems-must-match plus
        // shared-prefix, this must split.
        const looseFiles = distinctTitleStems(25, /* withMarkerOnFirst */ true);
        setupFs({
          '/audiobooks': [
            ...looseFiles,
            { name: 'BookFolder', isFile: false },
          ],
          '/audiobooks/BookFolder': [{ name: 'ch.mp3', isFile: true, size: 5_000_000 }],
        });

        const result = await discoverBooks('/audiobooks');
        expect(result).toHaveLength(26); // 25 loose + 1 child
        expect(result.find(r => r.path === '/audiobooks')).toBeUndefined();
      });

      it('AC13: Book A Part 1/Part 2 + 20 unrelated full books → splits (subset-duplicate guard)', async () => {
        // Pins both the prefix-subset false-positive AND the duplicate-
        // normalized-subset false-positive: the strict `distinct === 1`
        // rule in hasStrongChapterSetEvidence requires every normalized stem
        // to match — not the leaf classifier's subset-tolerant `distinct < count`.
        const subsetDup = [
          { name: 'Book A Part 1.m4b', isFile: true as const, size: LARGE_BOOK },
          { name: 'Book A Part 2.m4b', isFile: true as const, size: LARGE_BOOK },
        ];
        const unrelated = Array.from({ length: 20 }, (_, i) => ({
          name: `Standalone Title ${String(i).padStart(2, '0')}.m4b`,
          isFile: true as const,
          size: LARGE_BOOK,
        }));
        setupFs({
          '/audiobooks': [...subsetDup, ...unrelated, { name: 'BookFolder', isFile: false }],
          '/audiobooks/BookFolder': [{ name: 'ch.mp3', isFile: true, size: 5_000_000 }],
        });

        const result = await discoverBooks('/audiobooks');
        expect(result).toHaveLength(23); // 22 loose + 1 child
        expect(result.find(r => r.path === '/audiobooks')).toBeUndefined();
      });

      it('AC9: shared-prefix multi-disc loose audio + bonus subdir → ONE absorbed parent row', async () => {
        // Strong-evidence path via marker-set rule (all stems match,
        // markerless prefix "mistborn" non-empty and shared).
        const SMALL = 30 * 1024 * 1024;
        setupFs({
          '/audiobooks': [{ name: 'Mistborn', isFile: false }],
          '/audiobooks/Mistborn': [
            { name: 'Mistborn Disc 1.mp3', isFile: true, size: SMALL },
            { name: 'Mistborn Disc 2.mp3', isFile: true, size: SMALL },
            { name: 'Mistborn Disc 3.mp3', isFile: true, size: SMALL },
            { name: 'Bonus Material', isFile: false },
          ],
          '/audiobooks/Mistborn/Bonus Material': [
            { name: 'extra.mp3', isFile: true, size: 5_000_000 },
          ],
        });

        const result = await discoverBooks('/audiobooks');
        expect(result).toHaveLength(1);
        expect(result[0]!.path).toBe('/audiobooks/Mistborn');
        expect(result[0]!.audioFileCount).toBe(4);
        expect(result[0]!.reviewReason).toBe('Additional non-book content possibly merged');
      });
    });

    it('no audio files and no audio children returns empty', async () => {
      setupFs({
        '/audiobooks': [{ name: 'empty', isFile: false }],
        '/audiobooks/empty': [],
      });

      const result = await discoverBooks('/audiobooks');
      expect(result).toEqual([]);
    });
  });

  describe('mixed-content + disc merge interaction', () => {
    beforeEach(() => {
      mockReadAlbumTag.mockReset();
      mockReadAlbumTag.mockResolvedValue(undefined);
    });

    it('loose audio + disc subfolders (CD1, CD2) merges discs and includes loose files in count', async () => {
      setupFs({
        '/audiobooks': [{ name: 'Book', isFile: false }],
        '/audiobooks/Book': [
          { name: 'loose.mp3', isFile: true, size: 100 },
          { name: 'CD1', isFile: false },
          { name: 'CD2', isFile: false },
        ],
        '/audiobooks/Book/CD1': [{ name: 'a.mp3', isFile: true, size: 200 }],
        '/audiobooks/Book/CD2': [{ name: 'b.mp3', isFile: true, size: 300 }],
      });

      const result = await discoverBooks('/audiobooks');
      expect(result).toHaveLength(1);
      expect(result[0]!.path).toBe('/audiobooks/Book');
      expect(result[0]!.audioFileCount).toBe(3); // loose + 2 disc tracks
      expect(result[0]!.totalSize).toBe(600); // 100 + 200 + 300
      expect(result[0]).not.toHaveProperty('reviewReason');
    });

    it('loose audio + disc subfolders + non-disc immediateAudioChild prevents disc merge, recurses all and emits loose file', async () => {
      setupFs({
        '/audiobooks': [{ name: 'Book', isFile: false }],
        '/audiobooks/Book': [
          { name: 'loose.mp3', isFile: true, size: 100 },
          { name: 'CD1', isFile: false },
          { name: 'CD2', isFile: false },
          { name: 'Bonus', isFile: false },
        ],
        '/audiobooks/Book/CD1': [{ name: 'a.mp3', isFile: true, size: 200 }],
        '/audiobooks/Book/CD2': [{ name: 'b.mp3', isFile: true, size: 300 }],
        '/audiobooks/Book/Bonus': [{ name: 'c.mp3', isFile: true, size: 400 }],
      });

      const result = await discoverBooks('/audiobooks');
      // Disc merge doesn't trigger (Bonus is non-disc immediateAudioChild).
      // All three subfolders recursed individually, plus loose file emitted as its own book.
      expect(result).toHaveLength(4);
      const paths = result.map(r => r.path).sort();
      expect(paths).toEqual([
        '/audiobooks/Book/Bonus',
        '/audiobooks/Book/CD1',
        '/audiobooks/Book/CD2',
        '/audiobooks/Book/loose.mp3',
      ]);
    });

    it('loose audio + disc subfolders + deeper non-disc descendant merges discs and recurses deeper child', async () => {
      setupFs({
        '/audiobooks': [{ name: 'Collection', isFile: false }],
        '/audiobooks/Collection': [
          { name: 'loose.mp3', isFile: true, size: 50 },
          { name: 'CD1', isFile: false },
          { name: 'CD2', isFile: false },
          { name: 'Extra', isFile: false }, // no direct audio, deeper descendant has audio
        ],
        '/audiobooks/Collection/CD1': [{ name: 'a.mp3', isFile: true, size: 100 }],
        '/audiobooks/Collection/CD2': [{ name: 'b.mp3', isFile: true, size: 100 }],
        '/audiobooks/Collection/Extra': [{ name: 'Bonus Book', isFile: false }],
        '/audiobooks/Collection/Extra/Bonus Book': [{ name: 'c.mp3', isFile: true, size: 100 }],
      });

      const result = await discoverBooks('/audiobooks');
      // CD1 and CD2 are the only immediateAudioChildren → disc merge triggers
      // Extra recurses independently; loose files now counted in merged row
      expect(result).toHaveLength(2);
      const paths = result.map(r => r.path).sort();
      expect(paths).toEqual(['/audiobooks/Collection', '/audiobooks/Collection/Extra/Bonus Book']);
      // Merged row counts loose + 2 disc tracks; the deeper Extra/Bonus Book
      // file stays in its own row, NOT counted here.
      const merged = result.find(r => r.path === '/audiobooks/Collection')!;
      expect(merged.audioFileCount).toBe(3);
      expect(merged.totalSize).toBe(250);
    });

    it('loose audio + titled-disc subfolders merges discs and includes loose files in count', async () => {
      setupFs({
        '/audiobooks': [{ name: 'Book', isFile: false }],
        '/audiobooks/Book': [
          { name: 'loose.mp3', isFile: true, size: 100 },
          { name: 'BookTitle (Disc 01)', isFile: false },
          { name: 'BookTitle (Disc 02)', isFile: false },
        ],
        '/audiobooks/Book/BookTitle (Disc 01)': [{ name: '01.mp3', isFile: true, size: 200 }],
        '/audiobooks/Book/BookTitle (Disc 02)': [{ name: '01.mp3', isFile: true, size: 300 }],
      });

      const result = await discoverBooks('/audiobooks');
      expect(result).toHaveLength(1);
      expect(result[0]!.path).toBe('/audiobooks/Book');
      expect(result[0]!.audioFileCount).toBe(3); // loose + 2 disc tracks
      expect(result[0]!.totalSize).toBe(600); // 100 + 200 + 300
      expect(result[0]).not.toHaveProperty('reviewReason');
    });

    it('AC2 negative — top-level bonus-named loose audio does NOT flag (matching albums)', async () => {
      // Top-level filename matches BONUS_SUBDIR_RE, but detectBonusContent only
      // tests segments[0] of relative paths under info.path — top-level paths
      // are excluded from descendantFiles, so the name signal cannot fire.
      setupFs({
        '/audiobooks': [{ name: 'Book', isFile: false }],
        '/audiobooks/Book': [
          { name: 'bonus.mp3', isFile: true, size: 100 },
          { name: 'CD1', isFile: false },
          { name: 'CD2', isFile: false },
        ],
        '/audiobooks/Book/CD1': [{ name: 'track.mp3', isFile: true, size: 200 }],
        '/audiobooks/Book/CD2': [{ name: 'track.mp3', isFile: true, size: 300 }],
      });
      mockReadAlbumTag.mockResolvedValue('Heir to the Empire');

      const result = await discoverBooks('/audiobooks');
      expect(result).toHaveLength(1);
      expect(result[0]!.audioFileCount).toBe(3);
      expect(result[0]).not.toHaveProperty('reviewReason');
    });

    it('AC2 positive — album mismatch (top-level vs disc tracks) fires the flag', async () => {
      setupFs({
        '/audiobooks': [{ name: 'Book', isFile: false }],
        '/audiobooks/Book': [
          { name: 'intro.mp3', isFile: true, size: 100 },
          { name: 'CD1', isFile: false },
          { name: 'CD2', isFile: false },
        ],
        '/audiobooks/Book/CD1': [{ name: 'track.mp3', isFile: true, size: 200 }],
        '/audiobooks/Book/CD2': [{ name: 'track.mp3', isFile: true, size: 300 }],
      });
      mockReadAlbumTag.mockImplementation(async (filePath: string) => {
        if (filePath.endsWith('/intro.mp3')) return 'Behind the Scenes';
        return 'Heir to the Empire';
      });

      const result = await discoverBooks('/audiobooks');
      expect(result).toHaveLength(1);
      expect(result[0]!.audioFileCount).toBe(3);
      expect(result[0]!.reviewReason).toBe('Additional non-book content possibly merged');
    });

    it('AC5 negative — nested disc-internal bonus does NOT name-flag (matching albums)', async () => {
      // CD1 has direct audio (track1.mp3) AND a nested Bonus/ subdir — both
      // required for disc-merge eligibility. detectBonusContent only tests
      // segments[0] of paths relative to info.path, which is "CD1" here, so
      // BONUS_SUBDIR_RE never matches. With matching albums, no signal.
      setupFs({
        '/audiobooks': [{ name: 'Parent', isFile: false }],
        '/audiobooks/Parent': [
          { name: 'loose.mp3', isFile: true, size: 100 },
          { name: 'CD1', isFile: false },
          { name: 'CD2', isFile: false },
        ],
        '/audiobooks/Parent/CD1': [
          { name: 'track1.mp3', isFile: true, size: 200 },
          { name: 'Bonus', isFile: false },
        ],
        '/audiobooks/Parent/CD1/Bonus': [{ name: 'track2.mp3', isFile: true, size: 50 }],
        '/audiobooks/Parent/CD2': [{ name: 'track3.mp3', isFile: true, size: 300 }],
      });
      mockReadAlbumTag.mockResolvedValue('Real Book');

      const result = await discoverBooks('/audiobooks');
      expect(result).toHaveLength(1);
      expect(result[0]!.path).toBe('/audiobooks/Parent');
      expect(result[0]!.audioFileCount).toBe(4);
      expect(result[0]).not.toHaveProperty('reviewReason');
    });

    it('AC5 positive — nested disc-internal bonus + album mismatch on direct disc track DOES flag (album path only)', async () => {
      // Same fixture as the AC5 negative, but mock album reads so top-level
      // differs from EVERY disc-child file. readFirstAlbum returns the first
      // truthy descendant album (CD1/track1.mp3 → "Bonus Disc"), and topAlbum
      // is "Real Book" — album-mismatch fires. Mocking ONLY the nested
      // CD1/Bonus/track2.mp3 to differ would NOT fire because readFirstAlbum
      // short-circuits on CD1/track1.mp3's matching value.
      setupFs({
        '/audiobooks': [{ name: 'Parent', isFile: false }],
        '/audiobooks/Parent': [
          { name: 'loose.mp3', isFile: true, size: 100 },
          { name: 'CD1', isFile: false },
          { name: 'CD2', isFile: false },
        ],
        '/audiobooks/Parent/CD1': [
          { name: 'track1.mp3', isFile: true, size: 200 },
          { name: 'Bonus', isFile: false },
        ],
        '/audiobooks/Parent/CD1/Bonus': [{ name: 'track2.mp3', isFile: true, size: 50 }],
        '/audiobooks/Parent/CD2': [{ name: 'track3.mp3', isFile: true, size: 300 }],
      });
      mockReadAlbumTag.mockImplementation(async (filePath: string) => {
        if (filePath.endsWith('/loose.mp3')) return 'Real Book';
        return 'Bonus Disc';
      });

      const result = await discoverBooks('/audiobooks');
      expect(result).toHaveLength(1);
      expect(result[0]!.audioFileCount).toBe(4);
      expect(result[0]!.reviewReason).toBe('Additional non-book content possibly merged');
    });

    it('AC3 — pure disc-merge with no loose audio: no reviewReason', async () => {
      setupFs({
        '/audiobooks': [{ name: 'Book', isFile: false }],
        '/audiobooks/Book': [
          { name: 'CD1', isFile: false },
          { name: 'CD2', isFile: false },
        ],
        '/audiobooks/Book/CD1': [{ name: 'a.mp3', isFile: true, size: 200 }],
        '/audiobooks/Book/CD2': [{ name: 'b.mp3', isFile: true, size: 300 }],
      });
      mockReadAlbumTag.mockResolvedValue('Heir to the Empire');

      const result = await discoverBooks('/audiobooks');
      expect(result).toHaveLength(1);
      expect(result[0]!.path).toBe('/audiobooks/Book');
      expect(result[0]!.audioFileCount).toBe(2);
      expect(result[0]!.totalSize).toBe(500);
      expect(result[0]).not.toHaveProperty('reviewReason');
    });

    it('AC6 — tag-probe failure during bonus detection does not throw', async () => {
      setupFs({
        '/audiobooks': [{ name: 'Book', isFile: false }],
        '/audiobooks/Book': [
          { name: 'loose.mp3', isFile: true, size: 100 },
          { name: 'CD1', isFile: false },
          { name: 'CD2', isFile: false },
        ],
        '/audiobooks/Book/CD1': [{ name: 'a.mp3', isFile: true, size: 200 }],
        '/audiobooks/Book/CD2': [{ name: 'b.mp3', isFile: true, size: 300 }],
      });
      mockReadAlbumTag.mockResolvedValue(undefined);

      const result = await discoverBooks('/audiobooks');
      expect(result).toHaveLength(1);
      expect(result[0]!.audioFileCount).toBe(3);
      expect(result[0]).not.toHaveProperty('reviewReason');
    });
  });

  describe('mixed-content logging', () => {
    it('does not emit any skip log when emitting loose files as single-file books (non-disc-merge case)', async () => {
      setupFs({
        '/audiobooks': [
          { name: 'loose1.m4b', isFile: true, size: 100 },
          { name: 'loose2.mp3', isFile: true, size: 200 },
          { name: 'Book', isFile: false },
        ],
        '/audiobooks/Book': [{ name: 'ch.mp3', isFile: true, size: 1000 }],
      });

      const log: DiscoveryLogger = { debug: vi.fn() };
      await discoverBooks('/audiobooks', { log });

      const calls = (log.debug as ReturnType<typeof vi.fn>).mock.calls;
      const skipCalls = calls.filter(
        (c: unknown[]) =>
          c[1] === 'Skipping loose bonus audio in disc-merge folder'
          || c[1] === 'Skipping loose audio files in mixed-content folder',
      );
      expect(skipCalls).toHaveLength(0);
    });

    it('emits "Skipping loose bonus audio in disc-merge folder" when loose files are skipped because disc-merge will run', async () => {
      setupFs({
        '/audiobooks': [{ name: 'Book', isFile: false }],
        '/audiobooks/Book': [
          { name: 'bonus.mp3', isFile: true, size: 100 },
          { name: 'CD1', isFile: false },
          { name: 'CD2', isFile: false },
        ],
        '/audiobooks/Book/CD1': [{ name: 'a.mp3', isFile: true, size: 200 }],
        '/audiobooks/Book/CD2': [{ name: 'b.mp3', isFile: true, size: 300 }],
      });

      const log: DiscoveryLogger = { debug: vi.fn() };
      await discoverBooks('/audiobooks', { log });

      expect(log.debug).toHaveBeenCalledWith(
        { path: '/audiobooks/Book', skippedFiles: ['/audiobooks/Book/bonus.mp3'] },
        'Skipping loose bonus audio in disc-merge folder',
      );
    });

    it('does not emit skip log for pure leaf folder', async () => {
      setupFs({
        '/audiobooks': [{ name: 'Book', isFile: false }],
        '/audiobooks/Book': [{ name: 'ch.mp3', isFile: true, size: 1000 }],
      });

      const log: DiscoveryLogger = { debug: vi.fn() };
      await discoverBooks('/audiobooks', { log });

      const calls = (log.debug as ReturnType<typeof vi.fn>).mock.calls;
      const skipCalls = calls.filter(
        (c: unknown[]) =>
          c[1] === 'Skipping loose bonus audio in disc-merge folder'
          || c[1] === 'Skipping loose audio files in mixed-content folder',
      );
      expect(skipCalls).toHaveLength(0);
    });

    it('does not emit skip log for pure recurse folder (no loose audio)', async () => {
      setupFs({
        '/audiobooks': [
          { name: 'Book1', isFile: false },
          { name: 'Book2', isFile: false },
        ],
        '/audiobooks/Book1': [{ name: 'ch.mp3', isFile: true, size: 1000 }],
        '/audiobooks/Book2': [{ name: 'ch.mp3', isFile: true, size: 2000 }],
      });

      const log: DiscoveryLogger = { debug: vi.fn() };
      await discoverBooks('/audiobooks', { log });

      const calls = (log.debug as ReturnType<typeof vi.fn>).mock.calls;
      const skipCalls = calls.filter(
        (c: unknown[]) =>
          c[1] === 'Skipping loose bonus audio in disc-merge folder'
          || c[1] === 'Skipping loose audio files in mixed-content folder',
      );
      expect(skipCalls).toHaveLength(0);
    });
  });

  // ---- Root folder IS the book (folderParts from basename) ----

  describe('root folder is the book', () => {
    it('uses root folder basename when audio files are directly in the root', async () => {
      setupFs({
        '/downloads/The Name of the Wind by Patrick Rothfuss': [
          { name: 'chapter01.mp3', isFile: true, size: 5000 },
          { name: 'chapter02.mp3', isFile: true, size: 6000 },
        ],
      });

      const result = await discoverBooks('/downloads/The Name of the Wind by Patrick Rothfuss');
      expect(result).toHaveLength(1);
      expect(result[0]!.folderParts).toEqual(['The Name of the Wind by Patrick Rothfuss']);
      expect(result[0]!.audioFileCount).toBe(2);
      expect(result[0]!.totalSize).toBe(11000);
    });

    it('uses root folder basename for single m4b file at root', async () => {
      setupFs({
        '/downloads/My Audiobook': [
          { name: 'book.m4b', isFile: true, size: 500_000 },
        ],
      });

      const result = await discoverBooks('/downloads/My Audiobook');
      expect(result).toHaveLength(1);
      expect(result[0]!.folderParts).toEqual(['My Audiobook']);
    });

    it('still discovers child folders when root has subfolders with audio', async () => {
      setupFs({
        '/downloads/collection': [
          { name: 'Book One', isFile: false },
          { name: 'Book Two', isFile: false },
        ],
        '/downloads/collection/Book One': [{ name: 'a.mp3', isFile: true, size: 100 }],
        '/downloads/collection/Book Two': [{ name: 'b.mp3', isFile: true, size: 200 }],
      });

      const result = await discoverBooks('/downloads/collection');
      expect(result).toHaveLength(2);
      expect(result[0]!.folderParts).toEqual(['Book One']);
      expect(result[1]!.folderParts).toEqual(['Book Two']);
    });
  });

  describe('mixed-content end-to-end', () => {
    it('tree with mixed loose files at multiple levels returns folder books AND single-file loose books', async () => {
      setupFs({
        '/audiobooks': [
          { name: 'root-loose.m4b', isFile: true, size: 100 },
          { name: 'Author1', isFile: false },
          { name: 'Author2', isFile: false },
        ],
        '/audiobooks/Author1': [
          { name: 'author-loose.mp3', isFile: true, size: 200 },
          { name: 'Book A', isFile: false },
        ],
        '/audiobooks/Author1/Book A': [{ name: 'ch.mp3', isFile: true, size: 1000 }],
        '/audiobooks/Author2': [{ name: 'Book B', isFile: false }],
        '/audiobooks/Author2/Book B': [{ name: 'ch.flac', isFile: true, size: 2000 }],
      });

      const result = await discoverBooks('/audiobooks');
      expect(result).toHaveLength(4);
      const paths = result.map(r => r.path).sort();
      expect(paths).toEqual([
        '/audiobooks/Author1/Book A',
        '/audiobooks/Author1/author-loose.mp3',
        '/audiobooks/Author2/Book B',
        '/audiobooks/root-loose.m4b',
      ]);
    });
  });

  describe('titled-disc folder detection (issue #426)', () => {
    describe('parseTitledDiscFolder', () => {
      it('returns title and discNumber for "BookTitle (Disc 01)"', () => {
        expect(parseTitledDiscFolder('Finders Keepers (Disc 01)')).toEqual({ title: 'Finders Keepers', discNumber: 1 });
      });

      it('returns title and discNumber for "BookTitle (Disc 12)"', () => {
        expect(parseTitledDiscFolder('Finders Keepers (Disc 12)')).toEqual({ title: 'Finders Keepers', discNumber: 12 });
      });

      it('returns title and discNumber for "BookTitle (1 of 5)"', () => {
        expect(parseTitledDiscFolder('The Way of Kings (1 of 5)')).toEqual({ title: 'The Way of Kings', discNumber: 1 });
      });

      it('returns title and discNumber for "BookTitle (3 of 10)" — double-digit M', () => {
        expect(parseTitledDiscFolder('BookTitle (3 of 10)')).toEqual({ title: 'BookTitle', discNumber: 3 });
      });

      it('handles case-insensitive disc keyword', () => {
        expect(parseTitledDiscFolder('BookTitle (disc 03)')).toEqual({ title: 'BookTitle', discNumber: 3 });
        expect(parseTitledDiscFolder('BookTitle (DISC 03)')).toEqual({ title: 'BookTitle', discNumber: 3 });
      });

      it('returns null for bare disc folder "Disc 01" — handled by DISC_FOLDER_PATTERN', () => {
        expect(parseTitledDiscFolder('Disc 01')).toBeNull();
      });

      it('returns null for "BookTitle (2020)" — year not disc', () => {
        expect(parseTitledDiscFolder('BookTitle (2020)')).toBeNull();
      });

      it('returns null for "BookTitle (Unabridged)" — codec not disc', () => {
        expect(parseTitledDiscFolder('BookTitle (Unabridged)')).toBeNull();
      });

      it('returns null for "BookTitle (A Subtitle)" — subtitle not disc', () => {
        expect(parseTitledDiscFolder('BookTitle (A Subtitle)')).toBeNull();
      });

      it('returns null for "BookTitle (Jeff Hays)" — narrator name not disc', () => {
        expect(parseTitledDiscFolder('BookTitle (Jeff Hays)')).toBeNull();
      });

      it('returns null for empty string', () => {
        expect(parseTitledDiscFolder('')).toBeNull();
      });

      it('returns null for "Disc 0" (zero) — matches bare pattern, not titled', () => {
        expect(parseTitledDiscFolder('Disc 0')).toBeNull();
      });

      it('handles (Disc 0) with title', () => {
        expect(parseTitledDiscFolder('BookTitle (Disc 0)')).toEqual({ title: 'BookTitle', discNumber: 0 });
      });

      it('handles "Disk" spelling variant', () => {
        expect(parseTitledDiscFolder('BookTitle (Disk 05)')).toEqual({ title: 'BookTitle', discNumber: 5 });
      });

      it('returns null for combined parentheticals — disc + narrator', () => {
        // Disc paren is not at end of string, so regex $ anchor rejects
        expect(parseTitledDiscFolder('BookTitle (Disc 01) (Jeff Hays)')).toBeNull();
      });
    });

    describe('parenthetical disc merge in discoverBooks', () => {
      it('merges sibling "BookTitle (Disc NN)" folders into single book entry', async () => {
        setupFs({
          '/audiobooks': [
            { name: 'Finders Keepers (Disc 01)', isFile: false },
            { name: 'Finders Keepers (Disc 02)', isFile: false },
            { name: 'Finders Keepers (Disc 03)', isFile: false },
          ],
          '/audiobooks/Finders Keepers (Disc 01)': [{ name: '01.mp3', isFile: true, size: 1000 }],
          '/audiobooks/Finders Keepers (Disc 02)': [{ name: '01.mp3', isFile: true, size: 1000 }],
          '/audiobooks/Finders Keepers (Disc 03)': [{ name: '01.mp3', isFile: true, size: 1000 }],
        });

        const result = await discoverBooks('/audiobooks');
        expect(result).toHaveLength(1);
        expect(result[0]!.path).toBe('/audiobooks');
        expect(result[0]!.audioFileCount).toBe(3);
      });

      it('merges N-of-M sibling folders into single book entry', async () => {
        setupFs({
          '/audiobooks': [
            { name: 'The Way of Kings (1 of 3)', isFile: false },
            { name: 'The Way of Kings (2 of 3)', isFile: false },
            { name: 'The Way of Kings (3 of 3)', isFile: false },
          ],
          '/audiobooks/The Way of Kings (1 of 3)': [{ name: '01.mp3', isFile: true, size: 1000 }],
          '/audiobooks/The Way of Kings (2 of 3)': [{ name: '01.mp3', isFile: true, size: 1000 }],
          '/audiobooks/The Way of Kings (3 of 3)': [{ name: '01.mp3', isFile: true, size: 1000 }],
        });

        const result = await discoverBooks('/audiobooks');
        expect(result).toHaveLength(1);
        expect(result[0]!.path).toBe('/audiobooks');
        expect(result[0]!.audioFileCount).toBe(3);
      });

      it('does not merge siblings with different title prefixes', async () => {
        setupFs({
          '/audiobooks': [
            { name: 'Book A (Disc 01)', isFile: false },
            { name: 'Book B (Disc 01)', isFile: false },
          ],
          '/audiobooks/Book A (Disc 01)': [{ name: '01.mp3', isFile: true, size: 1000 }],
          '/audiobooks/Book B (Disc 01)': [{ name: '01.mp3', isFile: true, size: 1000 }],
        });

        const result = await discoverBooks('/audiobooks');
        expect(result).toHaveLength(2);
      });

      it('does not merge when non-disc sibling is present among titled-disc folders', async () => {
        setupFs({
          '/audiobooks': [
            { name: 'BookTitle (Disc 01)', isFile: false },
            { name: 'BookTitle (Disc 02)', isFile: false },
            { name: 'Bonus Material', isFile: false },
          ],
          '/audiobooks/BookTitle (Disc 01)': [{ name: '01.mp3', isFile: true, size: 1000 }],
          '/audiobooks/BookTitle (Disc 02)': [{ name: '01.mp3', isFile: true, size: 1000 }],
          '/audiobooks/Bonus Material': [{ name: 'bonus.mp3', isFile: true, size: 1000 }],
        });

        const result = await discoverBooks('/audiobooks');
        // Should NOT merge — 3 audio children but only 2 match disc pattern
        expect(result).toHaveLength(3);
      });

      it('still merges bare disc folders (Disc 01, CD1) — regression', async () => {
        setupFs({
          '/audiobooks': [
            { name: 'Disc 01', isFile: false },
            { name: 'Disc 02', isFile: false },
          ],
          '/audiobooks/Disc 01': [{ name: '01.mp3', isFile: true, size: 1000 }],
          '/audiobooks/Disc 02': [{ name: '01.mp3', isFile: true, size: 1000 }],
        });

        const result = await discoverBooks('/audiobooks');
        expect(result).toHaveLength(1);
        expect(result[0]!.path).toBe('/audiobooks');
      });

      it('does not merge single titled-disc folder (requires ≥2)', async () => {
        setupFs({
          '/audiobooks': [
            { name: 'BookTitle (Disc 01)', isFile: false },
          ],
          '/audiobooks/BookTitle (Disc 01)': [{ name: '01.mp3', isFile: true, size: 1000 }],
        });

        const result = await discoverBooks('/audiobooks');
        expect(result).toHaveLength(1);
        // Should be the child folder, not the parent (no merge)
        expect(result[0]!.path).toBe('/audiobooks/BookTitle (Disc 01)');
      });

      it('merges exactly 2 titled-disc siblings', async () => {
        setupFs({
          '/audiobooks': [
            { name: 'Joyland (Disc 01)', isFile: false },
            { name: 'Joyland (Disc 02)', isFile: false },
          ],
          '/audiobooks/Joyland (Disc 01)': [{ name: '01.mp3', isFile: true, size: 1500 }],
          '/audiobooks/Joyland (Disc 02)': [{ name: '01.mp3', isFile: true, size: 2000 }],
        });

        const result = await discoverBooks('/audiobooks');
        expect(result).toHaveLength(1);
        expect(result[0]!.path).toBe('/audiobooks');
        expect(result[0]!.audioFileCount).toBe(2);
        expect(result[0]!.totalSize).toBe(3500);
      });
    });
  });

  // ---- Leaf folder classifier merge/split (issue #1016) ----

  describe('leaf folder classifier merge/split', () => {
    const LARGE_BOOK = 340 * 1024 * 1024;
    const SMALL_CHAPTER = 30 * 1024 * 1024;

    it('AC4: series-collection of 3 distinct large named files emits 3 entries', async () => {
      setupFs({
        '/audiobooks': [{ name: 'Sanderson', isFile: false }],
        '/audiobooks/Sanderson': [{ name: 'Mistborn Trilogy', isFile: false }],
        '/audiobooks/Sanderson/Mistborn Trilogy': [
          { name: 'Mistborn 01 - The Final Empire.mp3', isFile: true, size: LARGE_BOOK },
          { name: 'Mistborn 02 - The Well of Ascension.mp3', isFile: true, size: LARGE_BOOK },
          { name: 'Mistborn 03 - The Hero of Ages.mp3', isFile: true, size: LARGE_BOOK },
        ],
      });

      const result = await discoverBooks('/audiobooks');
      expect(result).toHaveLength(3);
      const paths = result.map(r => r.path).sort();
      expect(paths).toEqual([
        '/audiobooks/Sanderson/Mistborn Trilogy/Mistborn 01 - The Final Empire.mp3',
        '/audiobooks/Sanderson/Mistborn Trilogy/Mistborn 02 - The Well of Ascension.mp3',
        '/audiobooks/Sanderson/Mistborn Trilogy/Mistborn 03 - The Hero of Ages.mp3',
      ]);
      const first = result.find(r => r.path.endsWith('Final Empire.mp3'))!;
      expect(first.audioFileCount).toBe(1);
      expect(first.totalSize).toBe(LARGE_BOOK);
      expect(first.folderParts).toEqual([
        'Sanderson', 'Mistborn Trilogy', 'Mistborn 01 - The Final Empire.mp3',
      ]);
    });

    it('AC5: chapter-encoded book with 30 small Chapter NN files emits 1 entry', async () => {
      const entries = Array.from({ length: 30 }, (_, i) => ({
        name: `Chapter ${String(i + 1).padStart(2, '0')} - Title ${i + 1}.mp3`,
        isFile: true,
        size: SMALL_CHAPTER,
      }));
      setupFs({
        '/audiobooks': [{ name: 'Eric', isFile: false }],
        '/audiobooks/Eric': entries,
      });

      const result = await discoverBooks('/audiobooks');
      expect(result).toHaveLength(1);
      expect(result[0]!.path).toBe('/audiobooks/Eric');
      expect(result[0]!.audioFileCount).toBe(30);
    });

    it('AC6: flattened-disc fixture (Disc NN files in one folder) emits 1 entry', async () => {
      const entries = Array.from({ length: 12 }, (_, i) => ({
        name: `BookTitle - Disc ${String(i + 1).padStart(2, '0')}.mp3`,
        isFile: true,
        size: 600 * 1024 * 1024,
      }));
      setupFs({
        '/audiobooks': [{ name: 'BookTitle', isFile: false }],
        '/audiobooks/BookTitle': entries,
      });

      const result = await discoverBooks('/audiobooks');
      expect(result).toHaveLength(1);
      expect(result[0]!.path).toBe('/audiobooks/BookTitle');
      expect(result[0]!.audioFileCount).toBe(12);
    });

    it('AC19: split classification logs largeCount and largeRatio from sizeEvidence', async () => {
      // 3 large distinct novels — split path; sizeEvidence must surface in the
      // "Leaf folder classified" debug log so #1035 metadata can be replayed
      // from the search-trace without recomputing.
      setupFs({
        '/audiobooks': [{ name: 'Sanderson', isFile: false }],
        '/audiobooks/Sanderson': [{ name: 'Mistborn Trilogy', isFile: false }],
        '/audiobooks/Sanderson/Mistborn Trilogy': [
          { name: 'Mistborn 01 - The Final Empire.mp3', isFile: true, size: LARGE_BOOK },
          { name: 'Mistborn 02 - The Well of Ascension.mp3', isFile: true, size: LARGE_BOOK },
          { name: 'Mistborn 03 - The Hero of Ages.mp3', isFile: true, size: LARGE_BOOK },
        ],
      });

      const log: DiscoveryLogger = { debug: vi.fn() };
      await discoverBooks('/audiobooks', { log });

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: 'split',
          reason: 'distinct-large-files-no-marker',
          largeCount: 3,
          largeRatio: 1,
        }),
        'Leaf folder classified',
      );
    });

    it('AC19: merge classification (single-file) does NOT log largeCount/largeRatio', async () => {
      setupFs({
        '/audiobooks': [{ name: 'Book', isFile: false }],
        '/audiobooks/Book': [{ name: 'a.mp3', isFile: true, size: 100 }],
      });

      const log: DiscoveryLogger = { debug: vi.fn() };
      await discoverBooks('/audiobooks', { log });

      const calls = (log.debug as ReturnType<typeof vi.fn>).mock.calls;
      const leafCall = calls.find(c => c[1] === 'Leaf folder classified');
      expect(leafCall).toBeDefined();
      expect(leafCall![0]).not.toHaveProperty('largeCount');
      expect(leafCall![0]).not.toHaveProperty('largeRatio');
    });

    it('AC7: Mistborn Trilogy with bare Mistborn 0N files merges via duplicate-normalized-stems', async () => {
      setupFs({
        '/audiobooks': [{ name: 'Mistborn Trilogy', isFile: false }],
        '/audiobooks/Mistborn Trilogy': [
          { name: 'Mistborn 01.mp3', isFile: true, size: LARGE_BOOK },
          { name: 'Mistborn 02.mp3', isFile: true, size: LARGE_BOOK },
          { name: 'Mistborn 03.mp3', isFile: true, size: LARGE_BOOK },
        ],
      });

      const log: DiscoveryLogger = { debug: vi.fn() };
      const result = await discoverBooks('/audiobooks', { log });
      expect(result).toHaveLength(1);
      expect(result[0]!.path).toBe('/audiobooks/Mistborn Trilogy');
      expect(result[0]!.audioFileCount).toBe(3);
      // Pin the specific guard reason — duplicate-normalized-stems fires before
      // title-content because all three files normalize to 'Mistborn'.
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: 'merge',
          reason: 'duplicate-normalized-stems',
        }),
        'Leaf folder classified',
      );
    });
  });
});

// AC12: album normalization — collapses publisher suffixes that mark
// "same album, different volume" so the bonus-detection heuristic doesn't
// false-fire on legitimate multi-volume series.
describe('normalizeAlbumForComparison (#1031)', () => {
  it.each([
    ['Stormlight (1 of 5)', 'Stormlight (3 of 5)'],
    ['Book Part 01', 'Book Part 02'],
    ['Album Disc 2', 'Album Disc 3'],
    ['Album CD 03', 'Album CD 04'],
    ['Album-Part-01', 'Album_Part_02'],
    ['ALBUM (Disc 1)', 'album (disc 2)'],
  ])('collapses %s and %s to same canonical form', (a, b) => {
    expect(normalizeAlbumForComparison(a)).toBe(normalizeAlbumForComparison(b));
  });

  it('keeps genuinely distinct titles distinct', () => {
    const a = normalizeAlbumForComparison("The Hitchhiker's Guide to the Galaxy");
    const b = normalizeAlbumForComparison('The Restaurant at the End of the Universe');
    expect(a).not.toBe(b);
  });

  it('case- and punctuation-insensitive', () => {
    expect(normalizeAlbumForComparison('Foo  Bar!!')).toBe(normalizeAlbumForComparison('FOO_BAR'));
  });

  it('strips terminal "Pt 3" / "pt 03" variant', () => {
    expect(normalizeAlbumForComparison('Saga Pt 3')).toBe(normalizeAlbumForComparison('Saga'));
    expect(normalizeAlbumForComparison('Saga pt 03')).toBe(normalizeAlbumForComparison('Saga'));
  });
});
