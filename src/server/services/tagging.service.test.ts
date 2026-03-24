import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { buildFfmpegArgs, tagFile, TaggingService, RetagError, type TagMetadata } from './tagging.service.js';
import { createMockSettingsService } from '../__tests__/helpers.js';

// Mock child_process
vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], cb: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
    cb(null, { stdout: '', stderr: '' });
  }),
}));

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  readdir: vi.fn().mockResolvedValue([]),
  rename: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ size: 1000 }),
}));

// Mock music-metadata
vi.mock('music-metadata', () => ({
  parseFile: vi.fn().mockResolvedValue({
    common: {},
    format: {},
  }),
}));

// Mock drizzle-orm — uses importOriginal to preserve all real exports (getTableColumns,
// sql, etc.) while only overriding `eq` for assertion capture. This is necessary because
// drizzle-orm is imported at module scope by transitive dependencies (e.g., book-list.service.ts
// uses getTableColumns). Without importOriginal, those imports would be undefined.
// See: .claude/cl/learnings/getTableColumns-module-scope-mock.md
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    eq: vi.fn((col, val) => ({ col, val })),
  };
});

// Mock db schema
vi.mock('../../db/schema.js', () => ({
  books: { id: 'books.id' },
  authors: { id: 'authors.id', name: 'authors.name' },
  bookAuthors: { bookId: 'bookAuthors.bookId', authorId: 'bookAuthors.authorId', position: 'bookAuthors.position' },
  bookNarrators: { bookId: 'bookNarrators.bookId', narratorId: 'bookNarrators.narratorId' },
  narrators: { id: 'narrators.id', name: 'narrators.name' },
}));

import { readdir, rename, unlink, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { parseFile } from 'music-metadata';

describe('buildFfmpegArgs', () => {
  it('builds correct args for MP3 with all tags', () => {
    const tags: TagMetadata = {
      artist: 'Brandon Sanderson',
      albumArtist: 'Brandon Sanderson',
      album: 'The Way of Kings',
      title: 'The Way of Kings',
      composer: 'Michael Kramer',
      grouping: 'The Stormlight Archive',
      track: 1,
      trackTotal: 3,
    };

    const args = buildFfmpegArgs('/books/input.mp3', '/books/input.tmp.mp3', tags);

    expect(args).toContain('-y');
    expect(args).toContain('-i');
    expect(args).toContain('/books/input.mp3');
    expect(args).toContain('-c:a');
    expect(args).toContain('copy');
    expect(args).toContain('-metadata');
    expect(args).toContain('artist=Brandon Sanderson');
    expect(args).toContain('album_artist=Brandon Sanderson');
    expect(args).toContain('album=The Way of Kings');
    expect(args).toContain('title=The Way of Kings');
    expect(args).toContain('composer=Michael Kramer');
    expect(args).toContain('grouping=The Stormlight Archive');
    expect(args).toContain('track=1/3');
    expect(args[args.length - 1]).toBe('/books/input.tmp.mp3');
  });

  it('builds correct args for M4B with all tags', () => {
    const tags: TagMetadata = {
      artist: 'Author',
      album: 'Book Title',
    };

    const args = buildFfmpegArgs('/books/input.m4b', '/books/input.tmp.m4b', tags);

    expect(args).toContain('artist=Author');
    expect(args).toContain('album=Book Title');
    expect(args).not.toContain('composer=');
  });

  it('includes cover art args when coverPath provided', () => {
    const tags: TagMetadata = { artist: 'Author' };
    const args = buildFfmpegArgs('/books/input.mp3', '/books/out.mp3', tags, '/books/cover.jpg');

    expect(args).toContain('-i');
    expect(args).toContain('/books/cover.jpg');
    expect(args).toContain('-map');
    expect(args).toContain('1');
    expect(args).toContain('-c:v');
    expect(args).toContain('copy');
    expect(args).toContain('-disposition:v');
    expect(args).toContain('attached_pic');
  });

  it('omits cover art args when no coverPath', () => {
    const tags: TagMetadata = { artist: 'Author' };
    const args = buildFfmpegArgs('/books/input.mp3', '/books/out.mp3', tags);

    // Should only have one -i (for the audio input)
    const iCount = args.filter(a => a === '-i').length;
    expect(iCount).toBe(1);
    expect(args).not.toContain('-c:v');
  });

  it('omits undefined tag fields', () => {
    const tags: TagMetadata = { artist: 'Author' };
    const args = buildFfmpegArgs('/input.mp3', '/out.mp3', tags);

    const metadataArgs = args.filter(a => a.startsWith('artist=') || a.startsWith('album=') || a.startsWith('composer='));
    expect(metadataArgs).toEqual(['artist=Author']);
  });

  it('omits track when track or trackTotal is null', () => {
    const tags: TagMetadata = { artist: 'Author', track: 1 };
    const args = buildFfmpegArgs('/input.mp3', '/out.mp3', tags);
    expect(args.join(' ')).not.toContain('track=');
  });
});

describe('tagFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (stat as Mock).mockResolvedValue({ size: 1000 });
  });

  it('skips unsupported format (.ogg) with warning', async () => {
    const result = await tagFile('/books/file.ogg', '/usr/bin/ffmpeg', { artist: 'Author' }, 'overwrite');
    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('Unsupported format');
    expect(result.reason).toContain('.ogg');
  });

  it('skips unsupported format (.flac)', async () => {
    const result = await tagFile('/books/file.flac', '/usr/bin/ffmpeg', { artist: 'Author' }, 'overwrite');
    expect(result.status).toBe('skipped');
  });

  it('tags MP3 file in overwrite mode', async () => {
    (stat as Mock).mockResolvedValue({ size: 1000 });
    const result = await tagFile('/books/file.mp3', '/usr/bin/ffmpeg', { artist: 'Author', album: 'Book' }, 'overwrite');
    expect(result.status).toBe('tagged');
    expect(result.file).toBe('file.mp3');
    expect(rename).toHaveBeenCalled();
  });

  it('tags M4B file in overwrite mode', async () => {
    const result = await tagFile('/books/file.m4b', '/usr/bin/ffmpeg', { artist: 'Author' }, 'overwrite');
    expect(result.status).toBe('tagged');
    expect(result.file).toBe('file.m4b');
  });

  it('tags M4A file in overwrite mode', async () => {
    const result = await tagFile('/books/file.m4a', '/usr/bin/ffmpeg', { artist: 'Author' }, 'overwrite');
    expect(result.status).toBe('tagged');
  });

  it('in populate_missing mode, reads existing tags and skips non-empty fields', async () => {
    (parseFile as Mock).mockResolvedValueOnce({
      common: { artist: 'Existing Author', album: '', title: '' },
      format: {},
    });

    const result = await tagFile(
      '/books/file.mp3',
      '/usr/bin/ffmpeg',
      { artist: 'New Author', album: 'New Book', title: 'Title' },
      'populate_missing',
    );

    expect(result.status).toBe('tagged');
    expect(parseFile).toHaveBeenCalledWith('/books/file.mp3');

    // Verify ffmpeg was called with args that do NOT contain artist (already exists)
    // but DO contain album and title (which were empty)
    const { execFile } = await import('node:child_process');
    const callArgs = (execFile as unknown as Mock).mock.calls[0][1] as string[];
    expect(callArgs).not.toContain('artist=New Author');
    expect(callArgs).toContain('album=New Book');
    expect(callArgs).toContain('title=Title');
  });

  it('in populate_missing mode, skips entirely when all tags populated', async () => {
    (parseFile as Mock).mockResolvedValue({
      common: {
        artist: 'Existing',
        albumartist: 'Existing',
        album: 'Existing',
        title: 'Existing',
        composer: ['Existing'],
        grouping: 'Existing',
        track: { no: 1 },
        picture: [],
      },
      format: {},
    });

    const result = await tagFile(
      '/books/file.mp3',
      '/usr/bin/ffmpeg',
      { artist: 'New', album: 'New', title: 'New', composer: 'New', grouping: 'New' },
      'populate_missing',
    );

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('All tags already populated');
  });

  it('returns failed status when ffmpeg errors', async () => {
    const { execFile } = await import('node:child_process');
    (execFile as unknown as Mock).mockImplementationOnce(
      (_cmd: string, _args: string[], cb: (err: Error | null) => void) => {
        cb(new Error('ffmpeg crashed'));
      },
    );

    const result = await tagFile('/books/file.mp3', '/usr/bin/ffmpeg', { artist: 'Author' }, 'overwrite');
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('ffmpeg crashed');
  });

  it('returns failed when output file is suspiciously small', async () => {
    (stat as Mock)
      .mockResolvedValueOnce({ size: 1000 }) // original
      .mockResolvedValueOnce({ size: 100 });  // tmp (10% — below 50% threshold)

    const result = await tagFile('/books/file.mp3', '/usr/bin/ffmpeg', { artist: 'Author' }, 'overwrite');
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('suspiciously small');
  });

  it('uses temp file strategy: writes to .tmp.ext, then atomically renames', async () => {
    await tagFile('/books/file.mp3', '/usr/bin/ffmpeg', { artist: 'Author' }, 'overwrite');

    // Should atomically rename tmp over original (no separate delete)
    expect(rename).toHaveBeenCalledWith(
      expect.stringContaining('file.tmp.mp3'),
      '/books/file.mp3',
    );
    // Original should NOT be unlinked — rename overwrites atomically on POSIX
    expect(unlink).not.toHaveBeenCalledWith('/books/file.mp3');
  });

  it('cleans up temp file on ffmpeg failure', async () => {
    const { execFile } = await import('node:child_process');
    (execFile as unknown as Mock).mockImplementationOnce(
      (_cmd: string, _args: string[], cb: (err: Error | null) => void) => {
        cb(new Error('ffmpeg error'));
      },
    );

    await tagFile('/books/file.mp3', '/usr/bin/ffmpeg', { artist: 'Author' }, 'overwrite');
    expect(unlink).toHaveBeenCalledWith(expect.stringContaining('file.tmp.mp3'));
  });

  it('assigns track number for multi-file books, omits for single-file', async () => {
    // This tests the TaggingService.tagBook behavior for track numbering
    // tagFile itself receives the tags — it doesn't decide track numbering
    const tags: TagMetadata = { artist: 'Author', track: 2, trackTotal: 5 };
    const args = buildFfmpegArgs('/books/ch02.mp3', '/books/ch02.tmp.mp3', tags);
    expect(args).toContain('track=2/5');

    const tagsNoTrack: TagMetadata = { artist: 'Author' };
    const argsNoTrack = buildFfmpegArgs('/books/book.mp3', '/books/book.tmp.mp3', tagsNoTrack);
    expect(argsNoTrack.join(' ')).not.toContain('track=');
  });

  it('in populate_missing mode with cover, skips cover when file already has art', async () => {
    // File has existing tags AND existing cover art
    (parseFile as Mock).mockResolvedValue({
      common: { artist: 'Existing', album: 'Existing', title: 'Existing', picture: [{ data: Buffer.from('img') }] },
      format: {},
    });

    const result = await tagFile(
      '/books/file.mp3',
      '/usr/bin/ffmpeg',
      { artist: 'Author', album: 'Book', title: 'Title' },
      'populate_missing',
      '/books/cover.jpg',
    );

    // All tags populated + cover art exists → should skip entirely
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('All tags already populated');
  });

  it('in populate_missing mode with cover, embeds cover when file has no art', async () => {
    // File has existing tags but NO cover art
    (parseFile as Mock).mockResolvedValue({
      common: { artist: 'Existing', album: 'Existing', title: 'Existing', picture: [] },
      format: {},
    });

    const result = await tagFile(
      '/books/file.mp3',
      '/usr/bin/ffmpeg',
      { artist: 'Author', album: 'Book', title: 'Title' },
      'populate_missing',
      '/books/cover.jpg',
    );

    // Tags all populated but no cover → should embed cover
    expect(result.status).toBe('tagged');

    const { execFile } = await import('node:child_process');
    const callArgs = (execFile as unknown as Mock).mock.calls[0][1] as string[];
    expect(callArgs).toContain('/books/cover.jpg');
    expect(callArgs).toContain('-disposition:v');
  });

  it('in overwrite mode, always embeds cover even when file has art', async () => {
    (parseFile as Mock).mockResolvedValue({
      common: { picture: [{ data: Buffer.from('img') }] },
      format: {},
    });

    const result = await tagFile(
      '/books/file.mp3',
      '/usr/bin/ffmpeg',
      { artist: 'Author' },
      'overwrite',
      '/books/cover.jpg',
    );

    expect(result.status).toBe('tagged');
    const { execFile } = await import('node:child_process');
    const callArgs = (execFile as unknown as Mock).mock.calls[0][1] as string[];
    expect(callArgs).toContain('/books/cover.jpg');
  });

  it('returns failed and preserves original when rename fails', async () => {
    (rename as Mock).mockRejectedValueOnce(new Error('EXDEV: cross-device link not permitted'));

    const result = await tagFile('/books/file.mp3', '/usr/bin/ffmpeg', { artist: 'Author' }, 'overwrite');

    expect(result.status).toBe('failed');
    expect(result.reason).toContain('EXDEV');
    // Original file should NOT have been deleted (no unlink on original)
    expect(unlink).not.toHaveBeenCalledWith('/books/file.mp3');
    // Temp file should be cleaned up
    expect(unlink).toHaveBeenCalledWith(expect.stringContaining('file.tmp.mp3'));
  });

  it('readExistingTags returns empty on parse failure (treats as all empty)', async () => {
    (parseFile as Mock).mockRejectedValueOnce(new Error('corrupt file'));

    // In populate_missing with parse failure, should tag (treats existing as {})
    const result = await tagFile(
      '/books/file.mp3',
      '/usr/bin/ffmpeg',
      { artist: 'Author' },
      'populate_missing',
    );

    expect(result.status).toBe('tagged');
  });
});

describe('TaggingService', () => {
  function createMockDb() {
    // db is passed to constructor but no longer used by retagBook (delegates to BookService)
    return { select: vi.fn() };
  }

  let mockBookService: { getById: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockBookService = { getById: vi.fn() };
  });

  /** Build a minimal BookWithAuthor for mock returns. */
  function makeBook(overrides: {
    id?: number; title?: string; path?: string | null;
    authors?: { name: string }[]; narrators?: { name: string }[];
    seriesName?: string | null; seriesPosition?: number | null; coverUrl?: string | null;
  } = {}) {
    return {
      id: 1,
      title: 'Test Book',
      path: '/library/test',
      authors: [],
      narrators: [],
      seriesName: null,
      seriesPosition: null,
      coverUrl: null,
      ...overrides,
    };
  }

  /** Default tagging-ready settings: ffmpeg configured + tagging enabled. */
  const taggingDefaults = {
    processing: { ffmpegPath: '/usr/bin/ffmpeg' },
    tagging: { enabled: true, mode: 'overwrite' as const },
  };

  function createMockLog() {
    return {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn().mockReturnThis(),
      level: 'info',
      silent: vi.fn(),
    };
  }

  describe('retagBook', () => {
    it('throws FFMPEG_NOT_CONFIGURED when ffmpeg path is empty', async () => {
      const db = createMockDb();
      const settings = createMockSettingsService({
        processing: { ffmpegPath: '' },
        tagging: { enabled: true, mode: 'overwrite' },
      });

      const service = new TaggingService(db as never, settings as never, createMockLog() as never, mockBookService as never);
      await expect(service.retagBook(1)).rejects.toThrow(RetagError);
      await expect(service.retagBook(1)).rejects.toThrow(/ffmpeg is not configured/);
    });

    it('throws NOT_FOUND when book does not exist', async () => {
      const db = createMockDb();
      mockBookService.getById.mockResolvedValue(null);
      const settings = createMockSettingsService(taggingDefaults);

      const service = new TaggingService(db as never, settings as never, createMockLog() as never, mockBookService as never);
      await expect(service.retagBook(999)).rejects.toThrow(RetagError);
    });

    it('throws NO_PATH when book has no library path', async () => {
      const db = createMockDb();
      mockBookService.getById.mockResolvedValue(makeBook({ path: null }));
      const settings = createMockSettingsService(taggingDefaults);

      const service = new TaggingService(db as never, settings as never, createMockLog() as never, mockBookService as never);
      await expect(service.retagBook(1)).rejects.toThrow(/no library path/);
    });

    it('throws PATH_MISSING when book path does not exist on disk', async () => {
      const db = createMockDb();
      mockBookService.getById.mockResolvedValue(makeBook({ path: '/nonexistent' }));
      const settings = createMockSettingsService(taggingDefaults);
      (stat as Mock).mockRejectedValueOnce(new Error('ENOENT'));

      const service = new TaggingService(db as never, settings as never, createMockLog() as never, mockBookService as never);
      await expect(service.retagBook(1)).rejects.toThrow(/does not exist on disk/);
    });

    it('fetches book via BookService.getById and calls tagBook with correct metadata', async () => {
      const db = createMockDb();
      mockBookService.getById.mockResolvedValue(makeBook({
        id: 42,
        title: 'The Final Empire',
        path: '/library/sanderson/final-empire',
        authors: [{ name: 'Brandon Sanderson' }],
        narrators: [{ name: 'Michael Kramer' }],
        seriesName: 'Mistborn',
        seriesPosition: 1,
        coverUrl: 'https://example.com/cover.jpg',
      }));
      const settings = createMockSettingsService({
        processing: { ffmpegPath: '/usr/bin/ffmpeg' },
        tagging: { enabled: true, mode: 'populate_missing', embedCover: true },
      });
      (stat as Mock).mockResolvedValue({ size: 1000 });
      (readdir as Mock).mockResolvedValue(['ch01.mp3']);

      const log = createMockLog();
      const service = new TaggingService(db as never, settings as never, log as never, mockBookService as never);
      const result = await service.retagBook(42);

      expect(mockBookService.getById).toHaveBeenCalledWith(42);
      expect(result.bookId).toBe(42);
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, tagged: 1 }),
        expect.any(String),
      );
    });

    it('passes null author name when book has no author', async () => {
      const db = createMockDb();
      mockBookService.getById.mockResolvedValue(makeBook({ authors: [], narrators: [] }));
      const settings = createMockSettingsService(taggingDefaults);
      (stat as Mock).mockResolvedValue({ size: 1000 });
      (readdir as Mock).mockResolvedValue(['book.mp3']);

      const service = new TaggingService(db as never, settings as never, createMockLog() as never, mockBookService as never);
      const result = await service.retagBook(1);

      // Should complete without error — author is optional
      expect(result.tagged).toBe(1);
    });
  });

  describe('tagBook', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      (stat as Mock).mockResolvedValue({ size: 1000 });
    });

    it('returns empty result when no taggable audio files found', async () => {
      (readdir as Mock).mockResolvedValue([]);
      const db = createMockDb();
      const settings = createMockSettingsService(taggingDefaults);
      const service = new TaggingService(db as never, settings as never, createMockLog() as never, mockBookService as never);

      const result = await service.tagBook(1, '/books/test', {
        title: 'Test',
        authorName: 'Author',
      }, '/usr/bin/ffmpeg', 'overwrite', false);

      expect(result.tagged).toBe(0);
      expect(result.warnings).toContain('No taggable audio files found');
    });

    it('assigns track numbers in locale-aware sort order for multi-file books', async () => {
      (readdir as Mock).mockResolvedValue(['02.mp3', '01.mp3', '10.mp3']);
      const db = createMockDb();
      const settings = createMockSettingsService(taggingDefaults);
      const log = createMockLog();
      const service = new TaggingService(db as never, settings as never, log as never, mockBookService as never);

      await service.tagBook(1, '/books/test', {
        title: 'Test',
        authorName: 'Author',
      }, '/usr/bin/ffmpeg', 'overwrite', false);

      // 3 files → 3 tagged calls
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ tagged: 3 }),
        expect.any(String),
      );

      // Verify track numbers were assigned in sorted order
      const { execFile } = await import('node:child_process');
      const calls = (execFile as unknown as Mock).mock.calls;
      // Files sorted: 01.mp3 (track 1/3), 02.mp3 (track 2/3), 10.mp3 (track 3/3)
      const trackArgs = calls.map((c: unknown[]) => {
        const args = c[1] as string[];
        return args.find(a => a.startsWith('track='));
      });
      expect(trackArgs).toEqual(['track=1/3', 'track=2/3', 'track=3/3']);

      // Verify files were processed in numeric sort order (01 before 02 before 10)
      const inputFiles = calls.map((c: unknown[]) => {
        const args = c[1] as string[];
        // The input file is the arg right after the first -i
        const iIdx = args.indexOf('-i');
        return args[iIdx + 1];
      });
      expect(inputFiles[0]).toContain('01.mp3');
      expect(inputFiles[1]).toContain('02.mp3');
      expect(inputFiles[2]).toContain('10.mp3');
    });

    it('omits track number for single-file books', async () => {
      (readdir as Mock).mockResolvedValue(['book.mp3']);
      const db = createMockDb();
      const settings = createMockSettingsService(taggingDefaults);
      const service = new TaggingService(db as never, settings as never, createMockLog() as never, mockBookService as never);

      const result = await service.tagBook(1, '/books/test', {
        title: 'Test',
        authorName: 'Author',
      }, '/usr/bin/ffmpeg', 'overwrite', false);

      expect(result.tagged).toBe(1);

      // Verify no track metadata was passed to ffmpeg
      const { execFile } = await import('node:child_process');
      const calls = (execFile as unknown as Mock).mock.calls;
      const args = calls[0][1] as string[];
      expect(args.join(' ')).not.toContain('track=');
    });

    it('warns about unsupported audio formats in directory', async () => {
      (readdir as Mock).mockResolvedValue(['book.ogg', 'book.flac', 'cover.jpg']);
      const db = createMockDb();
      const settings = createMockSettingsService(taggingDefaults);
      const log = createMockLog();
      const service = new TaggingService(db as never, settings as never, log as never, mockBookService as never);

      const result = await service.tagBook(1, '/books/test', {
        title: 'Test',
      }, '/usr/bin/ffmpeg', 'overwrite', false);

      expect(result.tagged).toBe(0);
      expect(result.skipped).toBe(2); // .ogg and .flac
      expect(result.warnings).toContainEqual(expect.stringContaining('.ogg'));
      expect(result.warnings).toContainEqual(expect.stringContaining('.flac'));
      expect(result.warnings).toContain('No taggable audio files found');
      // cover.jpg should NOT be warned about (not an audio format)
      expect(result.warnings.some(w => w.includes('cover.jpg'))).toBe(false);
      // Should log warnings for each unsupported file
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ file: 'book.ogg' }),
        'Tag write skipped',
      );
    });

    it('logs warnings for unsupported files alongside tagging taggable ones', async () => {
      // readdir is called twice: once by collectAudioFiles, once by tagBook for unsupported scan
      (readdir as Mock).mockResolvedValue(['ch01.mp3', 'bonus.ogg', 'ch02.mp3']);
      const db = createMockDb();
      const settings = createMockSettingsService(taggingDefaults);
      const log = createMockLog();
      const service = new TaggingService(db as never, settings as never, log as never, mockBookService as never);

      const result = await service.tagBook(1, '/books/test', {
        title: 'Test',
        authorName: 'Author',
      }, '/usr/bin/ffmpeg', 'overwrite', false);

      expect(result.tagged).toBe(2); // two mp3s tagged
      expect(result.skipped).toBe(1); // .ogg skipped with warning
      expect(result.warnings).toContainEqual(expect.stringContaining('.ogg'));
    });

    it('adds warning when cover embedding enabled but no cover file found', async () => {
      (readdir as Mock).mockResolvedValue(['book.mp3']);
      const db = createMockDb();
      const settings = createMockSettingsService(taggingDefaults);
      const service = new TaggingService(db as never, settings as never, createMockLog() as never, mockBookService as never);

      const result = await service.tagBook(1, '/books/test', {
        title: 'Test',
        authorName: 'Author',
      }, '/usr/bin/ffmpeg', 'overwrite', true);

      expect(result.warnings.some(w => w.includes('cover image found'))).toBe(true);
    });
  });
});

describe('TaggingService — multi-value serialization (#71, #79)', () => {
  const taggingDefaults = {
    processing: { ffmpegPath: '/usr/bin/ffmpeg' },
    tagging: { enabled: true, mode: 'overwrite' as const },
  };

  function createLog() {
    return {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(), level: 'info', silent: vi.fn(),
    };
  }

  let mockBookService: { getById: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    (stat as Mock).mockResolvedValue({ size: 1000 });
    (readdir as Mock).mockResolvedValue(['book.mp3']);
    mockBookService = { getById: vi.fn() };
  });

  function setupBook(authors: { name: string }[], narrators: { name: string }[]) {
    mockBookService.getById.mockResolvedValue({
      id: 1, title: 'Test Book', path: '/library/test',
      authors, narrators,
      seriesName: null, seriesPosition: null, coverUrl: null,
    });
  }

  it('authors ["Brandon Sanderson", "Robert Jordan"] → artist tag uses ", " delimiter', async () => {
    setupBook([{ name: 'Brandon Sanderson' }, { name: 'Robert Jordan' }], []);
    const settings = createMockSettingsService(taggingDefaults);
    const service = new TaggingService({ select: vi.fn() } as never, settings as never, createLog() as never, mockBookService as never);

    await service.retagBook(1);

    const calls = (execFile as unknown as Mock).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const args = calls[0][1] as string[];
    const artistArg = args.find((a, i) => args[i - 1] === '-metadata' && a.startsWith('artist='));
    expect(artistArg).toBe('artist=Brandon Sanderson, Robert Jordan');
  });

  it('narrators ["Kate Reading", "Michael Kramer"] → composer tag uses ", " delimiter', async () => {
    setupBook([{ name: 'Brandon Sanderson' }], [{ name: 'Kate Reading' }, { name: 'Michael Kramer' }]);
    const settings = createMockSettingsService(taggingDefaults);
    const service = new TaggingService({ select: vi.fn() } as never, settings as never, createLog() as never, mockBookService as never);

    await service.retagBook(1);

    const args = (execFile as unknown as Mock).mock.calls[0][1] as string[];
    const composerArg = args.find((a, i) => args[i - 1] === '-metadata' && a.startsWith('composer='));
    expect(composerArg).toBe('composer=Kate Reading, Michael Kramer');
  });

  it('single narrator → composer tag = narrator name only (no trailing ", ")', async () => {
    setupBook([{ name: 'Brandon Sanderson' }], [{ name: 'Michael Kramer' }]);
    const settings = createMockSettingsService(taggingDefaults);
    const service = new TaggingService({ select: vi.fn() } as never, settings as never, createLog() as never, mockBookService as never);

    await service.retagBook(1);

    const args = (execFile as unknown as Mock).mock.calls[0][1] as string[];
    const composerArg = args.find((a, i) => args[i - 1] === '-metadata' && a.startsWith('composer='));
    expect(composerArg).toBe('composer=Michael Kramer');
  });
});

describe('TaggingService.retagBook() via BookService.getById() (issue #79)', () => {
  const taggingDefaults = {
    processing: { ffmpegPath: '/usr/bin/ffmpeg' },
    tagging: { enabled: true, mode: 'overwrite' as const },
  };

  let mockBookService: { getById: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    (stat as Mock).mockResolvedValue({ size: 1000 });
    (readdir as Mock).mockResolvedValue(['book.mp3']);
    mockBookService = { getById: vi.fn().mockResolvedValue({
      id: 7, title: 'Dune', path: '/library/dune',
      authors: [{ name: 'Frank Herbert' }],
      narrators: [{ name: 'Scott Brick' }],
      seriesName: null, seriesPosition: null, coverUrl: null,
    }) };
  });

  it('retagBook() calls BookService.getById() rather than raw junction queries', async () => {
    const db = { select: vi.fn() }; // select should not be called
    const settings = createMockSettingsService(taggingDefaults);
    const service = new TaggingService(db as never, settings as never, {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(), level: 'info', silent: vi.fn(),
    } as never, mockBookService as never);

    await service.retagBook(7);

    expect(mockBookService.getById).toHaveBeenCalledWith(7);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('author and narrator names passed to tagger match BookWithAuthor shape', async () => {
    const db = { select: vi.fn() };
    const settings = createMockSettingsService(taggingDefaults);
    const service = new TaggingService(db as never, settings as never, {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(), level: 'info', silent: vi.fn(),
    } as never, mockBookService as never);

    await service.retagBook(7);

    const args = (execFile as unknown as Mock).mock.calls[0][1] as string[];
    expect(args).toContain('artist=Frank Herbert');
    expect(args).toContain('composer=Scott Brick');
  });
});
