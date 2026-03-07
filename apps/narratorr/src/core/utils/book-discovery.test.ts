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
  };
});

import { discoverBooks, type DiscoveryLogger } from './book-discovery.js';
import { readdir, stat } from 'node:fs/promises';

const mockReaddir = vi.mocked(readdir);
const mockStat = vi.mocked(stat);

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
    expect(result[0].audioFileCount).toBe(1);
    expect(result[0].totalSize).toBe(100);
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
      expect(result[0].audioFileCount).toBe(1);
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
    expect(result[0].audioFileCount).toBe(1);
    expect(result[0].totalSize).toBe(5000);
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
    expect(result[0].folderParts).toEqual(['Brandon Sanderson', 'Mistborn']);
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
    expect(result[0].folderParts).toEqual(['Joe Abercrombie', 'First Law', 'The Blade Itself']);
  });

  it('returns empty folderParts when audio is in root directory itself', async () => {
    setupFs({
      '/audiobooks': [
        { name: 'track.mp3', isFile: true, size: 1000 },
      ],
    });

    const result = await discoverBooks('/audiobooks');
    expect(result).toHaveLength(1);
    expect(result[0].folderParts).toEqual([]);
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
      expect(result[0].path).toBe('/audiobooks/Long Book');
      expect(result[0].audioFileCount).toBe(4);
      expect(result[0].totalSize).toBe(11_000);
      expect(result[0].folderParts).toEqual(['Long Book']);
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
      expect(result[0].path).toBe('/audiobooks/Book');
      expect(result[0].audioFileCount).toBe(2);
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
      expect(result[0].path).toBe('/audiobooks/Book');
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
      expect(result[0].path).toBe('/audiobooks/Book');
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
      expect(result[0].path).toBe('/audiobooks/Book');
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
      expect(result[0].path).toBe('/audiobooks/Book');
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
      expect(result[0].path).toBe('/audiobooks/Book/CD1');
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
      return result.length === 1 && result[0].path === '/audiobooks/Book';
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

  it('treats parent as leaf when it has its own audio, does not recurse into children', async () => {
    setupFs({
      '/audiobooks': [{ name: 'Book', isFile: false }],
      '/audiobooks/Book': [
        { name: 'main.mp3', isFile: true, size: 5000 },
        { name: 'subfolder', isFile: false },
      ],
      '/audiobooks/Book/subfolder': [
        { name: 'extra.mp3', isFile: true, size: 1000 },
      ],
    });

    const result = await discoverBooks('/audiobooks');
    // Parent has audio -> it's a leaf. Subfolder is ignored.
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('/audiobooks/Book');
    expect(result[0].audioFileCount).toBe(1);
    expect(result[0].totalSize).toBe(5000);
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
    expect(result[0].folderParts).toEqual(['Author', 'Series', 'Book 1']);
    expect(result[1].folderParts).toEqual(['Author', 'Series', 'Book 2']);
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
    expect(result[0].folderParts).toEqual(['has-audio']);
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
    expect(result[0].audioFileCount).toBe(1);
    expect(result[0].totalSize).toBe(2000);
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
    // Leaf book folder debug
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ audioFiles: 1 }),
      'Leaf book folder',
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
    expect(result[0].path).toBe('/audiobooks/Book');
    expect(result[0].audioFileCount).toBe(3);
    expect(result[0].totalSize).toBe(600);
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
    expect(result[0].audioFileCount).toBe(2);
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
    expect(result[0].totalSize).toBe(10);
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
    expect(result[0].folderParts).toEqual(['ab', 'book']);
  });
});
