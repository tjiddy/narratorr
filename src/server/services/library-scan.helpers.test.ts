import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { inject } from '../__tests__/helpers.js';
import {
  buildDiscoveredBook,
  findAudioLeafFolders,
  getAudioStats,
} from './library-scan.helpers.js';

function createMockLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    silent: vi.fn(),
    level: 'info',
  };
}

describe('buildDiscoveredBook', () => {
  it('builds a non-duplicate discovered book with parsed metadata', () => {
    const result = buildDiscoveredBook(
      '/audiobooks/Author/Book Title',
      { title: 'Book Title', author: 'Author', series: null },
      10,
      500000,
      false,
    );

    expect(result).toEqual({
      path: '/audiobooks/Author/Book Title',
      parsedTitle: 'Book Title',
      parsedAuthor: 'Author',
      parsedSeries: null,
      fileCount: 10,
      totalSize: 500000,
      isDuplicate: false,
    });
  });

  it('includes duplicate fields when provided', () => {
    const result = buildDiscoveredBook(
      '/audiobooks/Author/Book',
      { title: 'Book', author: 'Author', series: 'Series' },
      5,
      250000,
      true,
      42,
      'slug',
      '/audiobooks/Author/Book Original',
    );

    expect(result).toMatchObject({
      isDuplicate: true,
      existingBookId: 42,
      duplicateReason: 'slug',
      duplicateFirstPath: '/audiobooks/Author/Book Original',
    });
  });

  it('omits optional duplicate fields when not provided', () => {
    const result = buildDiscoveredBook(
      '/path',
      { title: 'T', author: null, series: null },
      1,
      100,
      false,
    );

    expect(result).not.toHaveProperty('existingBookId');
    expect(result).not.toHaveProperty('duplicateReason');
    expect(result).not.toHaveProperty('duplicateFirstPath');
  });
});

describe('getAudioStats', () => {
  let root: string;
  let log: ReturnType<typeof createMockLog>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'library-scan-helpers-stats-'));
    log = createMockLog();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns zeroed stats for empty directory', async () => {
    const result = await getAudioStats(root, inject<FastifyBaseLogger>(log));
    expect(result).toEqual({ fileCount: 0, totalSize: 0 });
  });

  it('counts audio files and sums their sizes', async () => {
    await writeFile(join(root, 'a.m4b'), Buffer.alloc(100));
    await writeFile(join(root, 'b.mp3'), Buffer.alloc(200));

    const result = await getAudioStats(root, inject<FastifyBaseLogger>(log));
    expect(result).toEqual({ fileCount: 2, totalSize: 300 });
  });

  it('totalSize includes non-audio files but fileCount counts only audio', async () => {
    // Pin current behavior at library-scan.helpers.ts:48-53: stat() runs for
    // EVERY file (audio or not), so totalSize aggregates the whole folder
    // while fileCount only increments for audio extensions.
    await writeFile(join(root, 'book.m4b'), Buffer.alloc(500));
    await writeFile(join(root, 'cover.jpg'), Buffer.alloc(50));
    await writeFile(join(root, 'metadata.opf'), Buffer.alloc(25));

    const result = await getAudioStats(root, inject<FastifyBaseLogger>(log));
    expect(result.fileCount).toBe(1);
    expect(result.totalSize).toBe(500 + 50 + 25);
  });

  it('recurses into nested directories and accumulates from subdirs', async () => {
    const nested = join(root, 'level1', 'level2');
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, 'top.m4b'), Buffer.alloc(10));
    await writeFile(join(root, 'level1', 'mid.m4b'), Buffer.alloc(20));
    await writeFile(nested, Buffer.alloc(0)).catch(() => {}); // ignore
    await writeFile(join(nested, 'deep.m4b'), Buffer.alloc(40));

    const result = await getAudioStats(root, inject<FastifyBaseLogger>(log));
    expect(result.fileCount).toBe(3);
    expect(result.totalSize).toBe(70);
  });

  it('logs warn and continues with partial results when a subdirectory cannot be read', async () => {
    await writeFile(join(root, 'good.m4b'), Buffer.alloc(100));
    const denied = join(root, 'denied');
    await mkdir(denied);
    await writeFile(join(denied, 'unreachable.m4b'), Buffer.alloc(999));
    await chmod(denied, 0o000);

    try {
      const result = await getAudioStats(root, inject<FastifyBaseLogger>(log));
      // Top-level audio file still counted; denied subdir contributes nothing.
      expect(result.fileCount).toBe(1);
      expect(result.totalSize).toBe(100);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ path: denied }),
        expect.stringContaining('Error getting audio stats'),
      );
    } finally {
      // Restore perms so afterEach can clean up.
      await chmod(denied, 0o700);
    }
  });

  it('silently ignores symlink entries (Dirent#isFile / #isDirectory both false for symlinks under withFileTypes)', async () => {
    // readdir(..., { withFileTypes: true }) returns Dirents whose isFile()
    // and isDirectory() both return false for symlinks. The helper only
    // handles real files and directories, so symlinks of any kind are
    // silently ignored (neither counted nor recursed into).
    const realDir = join(root, 'real');
    await mkdir(realDir);
    await writeFile(join(realDir, 'real.m4b'), Buffer.alloc(50));

    // Symlink to a file outside our walk
    const externalAudio = join(root, '..', `library-scan-external-${Date.now()}.m4b`);
    await writeFile(externalAudio, Buffer.alloc(9999));
    try {
      await symlink(externalAudio, join(root, 'linked.m4b'));
      // Symlink to a directory containing audio
      await symlink(realDir, join(root, 'linked-dir'));

      const result = await getAudioStats(root, inject<FastifyBaseLogger>(log));
      // Only the real file under realDir is counted; both symlinks ignored.
      expect(result.fileCount).toBe(1);
      expect(result.totalSize).toBe(50);
    } finally {
      await rm(externalAudio, { force: true });
    }
  });
});

describe('findAudioLeafFolders', () => {
  let root: string;
  let log: ReturnType<typeof createMockLog>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'library-scan-helpers-leaf-'));
    log = createMockLog();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns empty array for empty directory', async () => {
    const result = await findAudioLeafFolders(root, inject<FastifyBaseLogger>(log));
    expect(result).toEqual([]);
  });

  it('returns root when audio files live at the top level', async () => {
    await writeFile(join(root, 'book.m4b'), Buffer.alloc(0));

    const result = await findAudioLeafFolders(root, inject<FastifyBaseLogger>(log));
    expect(result).toEqual([root]);
  });

  it('returns deepest directories when audio is nested', async () => {
    const author = join(root, 'Author');
    const bookA = join(author, 'Book A');
    const bookB = join(author, 'Book B');
    await mkdir(bookA, { recursive: true });
    await mkdir(bookB, { recursive: true });
    await writeFile(join(bookA, 'a.m4b'), Buffer.alloc(0));
    await writeFile(join(bookB, 'b.mp3'), Buffer.alloc(0));

    const result = await findAudioLeafFolders(root, inject<FastifyBaseLogger>(log));
    expect(result.sort()).toEqual([bookA, bookB].sort());
  });

  it('skips hidden directories starting with a dot', async () => {
    const visible = join(root, 'Visible');
    const hidden = join(root, '.hidden');
    await mkdir(visible);
    await mkdir(hidden);
    await writeFile(join(visible, 'a.m4b'), Buffer.alloc(0));
    await writeFile(join(hidden, 'b.m4b'), Buffer.alloc(0));

    const result = await findAudioLeafFolders(root, inject<FastifyBaseLogger>(log));
    expect(result).toEqual([visible]);
  });

  it('silently skips symlinks-to-directory (Dirent#isDirectory returns false for symlinks; helper does not lstat or readlink, so symlink-following requires a deliberate contract change)', async () => {
    // Pin: under readdir(..., { withFileTypes: true }), a symlink-to-directory
    // reports isDirectory() === false and isFile() === false. findAudioLeafFolders
    // only descends entries where isDirectory() returns true, so symlinks are
    // ignored regardless of whether their target contains audio. A future
    // implementer who wants symlink-following must explicitly add an lstat /
    // readlink branch — this test exists to flag that change.
    const realBook = join(root, 'Real Book');
    await mkdir(realBook);
    await writeFile(join(realBook, 'audio.m4b'), Buffer.alloc(0));

    // Out-of-tree directory whose audio should NOT be discovered via the symlink.
    const externalDir = join(root, '..', `library-scan-external-leaf-${Date.now()}`);
    await mkdir(externalDir);
    await writeFile(join(externalDir, 'phantom.m4b'), Buffer.alloc(0));

    try {
      await symlink(externalDir, join(root, 'linked'));

      const result = await findAudioLeafFolders(root, inject<FastifyBaseLogger>(log));
      expect(result).toEqual([realBook]);
    } finally {
      await rm(externalDir, { recursive: true, force: true });
    }
  });
});
