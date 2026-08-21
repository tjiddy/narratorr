import { describe, it, expect, afterEach, beforeEach, vi, type Mock } from 'vitest';
vi.mock('@core/utils/audio-processor.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, resolveFfmpegPath: () => Promise.resolve('/usr/bin/ffmpeg') };
});

import { createMockDb, createMockLogger, inject, mockDbChain, createMockSettingsService } from '../__tests__/helpers.js';
import { ImportService } from './import.service.js';
import { buildTargetPath } from '../utils/import-helpers.js';
import { deriveImportSiblings } from '../utils/import-sibling-paths.js';
import { sanitizePath } from '@core/utils/index.js';
import type { DownloadClientService } from './download-client.service.js';
import type { RemotePathMappingService } from './remote-path-mapping.service.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { downloads, books } from '@db/schema.js';

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  cp: vi.fn().mockResolvedValue(undefined),
  // Markers default absent; "everything exists" would preserve backups on ordinary failures (#1290).
  stat: vi.fn().mockImplementation(async (p: unknown) =>
    String(p).endsWith('.import-commit-pending')
      ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      : { isFile: () => false, isDirectory: () => true, size: 1024 }),
  // Cleanup sees an ordinary directory here; symlink cases override lstat (#1598).
  lstat: vi.fn().mockImplementation(async (p: unknown) =>
    String(p).endsWith('.import-commit-pending')
      ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      : { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, size: 1024 }),
  readdir: vi.fn().mockResolvedValue([]),
  // Unmarked OPF is the safe default; ownership-deletion tests override it (#1674).
  readFile: vi.fn().mockResolvedValue('<?xml version="1.0"?><package><metadata><dc:title>foreign</dc:title></metadata></package>'),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  rmdir: vi.fn().mockResolvedValue(undefined),
  // Identity preserves containment; symlink cases override realpath (#1591).
  realpath: vi.fn().mockImplementation(async (p: unknown) => String(p)),
  statfs: vi.fn().mockResolvedValue({ bavail: BigInt(100_000_000_000), bsize: BigInt(1) }),
}));

// The hoisted delegate preserves real enrichment unless a test overrides the mock.
const realEnrichBookFromAudio = vi.hoisted(() => {
  let realFn: ((...args: unknown[]) => Promise<unknown>) | null = null;
  return {
    setReal: (fn: (...args: unknown[]) => Promise<unknown>) => { realFn = fn; },
    call: (...args: unknown[]) => realFn ? realFn(...args) : Promise.resolve({ enriched: false }),
  };
});

vi.mock('./enrichment-utils.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, (...args: unknown[]) => Promise<unknown>>;
  // Import holds the admission lock across enrichment, so it calls the inner form; spread `actual`
  // so the public wrapper stays real rather than becoming undefined.
  realEnrichBookFromAudio.setReal(actual.enrichBookFromAudioWithinAdmissionLock!);
  return {
    ...actual,
    enrichBookFromAudioWithinAdmissionLock: vi.fn().mockImplementation((...args: unknown[]) => realEnrichBookFromAudio.call(...args)),
  };
});

vi.mock('@core/utils/audio-scanner.js', () => ({
  scanAudioDirectory: vi.fn().mockResolvedValue(null),
}));

vi.mock('../utils/import-helpers.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    buildTargetPath: vi.fn().mockImplementation(actual.buildTargetPath as (...args: unknown[]) => unknown),
  };
});

vi.mock('../utils/paths.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    renameFilesWithTemplate: vi.fn().mockImplementation(actual.renameFilesWithTemplate as (...args: unknown[]) => unknown),
  };
});

vi.mock('../utils/import-steps.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    copyToLibrary: vi.fn().mockImplementation(actual.copyToLibrary as (...args: unknown[]) => unknown),
  };
});

import { mkdir, cp, stat, readdir, writeFile, rename, realpath, rm, rmdir, statfs } from 'node:fs/promises';
import { scanAudioDirectory } from '@core/utils/audio-scanner.js';
import { enrichBookFromAudioWithinAdmissionLock } from './enrichment-utils.js';
import { renameFilesWithTemplate } from '../utils/paths.js';
import { copyToLibrary, MarkerPathConflictError } from '../utils/import-steps.js';

import { createMockDbBook, createMockDbAuthor } from '../__tests__/factories.js';
import { useMswServer } from '@core/__tests__/msw/server.js';
import { http, HttpResponse } from 'msw';
import { transmissionSelects } from '@core/__tests__/download-client-id-semantics.js';
import { TransmissionClient } from '@core/download-clients/transmission.js';

const now = new Date();

const markerEnoent = (): Promise<never> => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

/**
 * Non-marker paths default to directories; the marker defaults to ENOENT.
 * Treating every path as a directory aborts every happy path with MarkerPathConflictError (#1341).
 */
const statDirMarkerAbsent = async (p: unknown): Promise<never> =>
  (String(p).endsWith('.import-commit-pending')
    ? markerEnoent()
    : ({ isFile: () => false, isDirectory: () => true, size: 500_000_000 } as never));

const mockBook = createMockDbBook({
  narrator: null,
  description: null,
  seriesName: 'The Stormlight Archive',
  seriesPosition: 1,
  status: 'downloading' as const,
});

const mockAuthor = createMockDbAuthor();

const mockDownload = {
  id: 1,
  bookId: 1,
  indexerId: 1,
  downloadClientId: 1,
  title: 'The Way of Kings',
  protocol: 'torrent' as const,
  infoHash: 'abc123',
  downloadUrl: 'magnet:?xt=urn:btih:abc123',
  size: 500_000_000,
  seeders: 10,
  clientStatus: 'completed' as const,
  pipelineStage: 'idle' as const,
  progress: 1,
  externalId: 'ext-1',
  errorMessage: null,
  addedAt: now,
  completedAt: new Date(Date.now() - 3600_000), // one hour ago
  guid: null, outputPath: null, progressUpdatedAt: null, pendingCleanup: null,
  // Default first-download snapshot reverts failures to wanted; upgrade tests override it.
  bookStatusAtGrab: 'wanted' as const,
};

const defaultDownloadItem = {
  id: 'ext-1',
  name: 'The Way of Kings',
  progress: 100,
  status: 'completed',
  savePath: '/downloads',
  size: 500_000_000,
  downloaded: 500_000_000,
  uploaded: 100_000_000,
  ratio: 0.2,
  seeders: 10,
  leechers: 5,
  addedAt: now,
  completedAt: now,
};

const mockAdapter = {
  getDownload: vi.fn().mockResolvedValue(defaultDownloadItem),
  removeDownload: vi.fn().mockResolvedValue(undefined),
};

function createMockDownloadClientService(): DownloadClientService {
  return inject<DownloadClientService>({
    getAdapter: vi.fn().mockResolvedValue(mockAdapter),
    getById: vi.fn().mockResolvedValue({ id: 1, name: 'qBit', type: 'qbittorrent', enabled: true }),
  });
}


describe('sanitizePath', () => {
  it('removes illegal characters', () => {
    expect(sanitizePath('Hello: World?')).toBe('Hello World');
  });

  it('removes trailing dots', () => {
    expect(sanitizePath('test...')).toBe('test');
  });

  it('returns Unknown for empty string after sanitization', () => {
    expect(sanitizePath('???')).toBe('Unknown');
  });

  it('preserves normal characters', () => {
    expect(sanitizePath('Brandon Sanderson')).toBe('Brandon Sanderson');
  });
});

describe('buildTargetPath', () => {
  it('builds path with author and title', () => {
    const result = buildTargetPath('/audiobooks', '{author}/{title}', { title: 'The Way of Kings' }, 'Brandon Sanderson');
    expect(result).toMatch(/audiobooks.*Brandon Sanderson.*The Way of Kings/);
  });

  it('uses Unknown Author when author is null', () => {
    const result = buildTargetPath('/audiobooks', '{author}/{title}', { title: 'Test' }, null);
    expect(result).toMatch(/Unknown Author/);
  });

  it('handles series format with empty series', () => {
    const result = buildTargetPath('/audiobooks', '{author}/{series}/{title}', { title: 'Test', seriesName: null }, 'Author');
    expect(result).not.toMatch(/\/\//);
  });

  it('handles series format with series name', () => {
    const result = buildTargetPath('/audiobooks', '{author}/{series}/{title}', { title: 'Book 1', seriesName: 'My Series' }, 'Author');
    expect(result).toMatch(/Author/);
    expect(result).toMatch(/My Series/);
    expect(result).toMatch(/Book 1/);
  });

  it('sanitizes special characters in path segments', () => {
    const result = buildTargetPath('/audiobooks', '{author}/{title}', { title: 'Book: Subtitle?' }, 'Author');
    expect(result).not.toMatch(/[?:]/);
  });

  it('includes narrator token', () => {
    const result = buildTargetPath('/audiobooks', '{author}/{title} [{narrator}]', { title: 'Book', narrators: [{ name: 'John Smith' }] }, 'Author');
    expect(result).toMatch(/John Smith/);
  });

  it('includes year token from publishedDate', () => {
    const result = buildTargetPath('/audiobooks', '{author}/{title} ({year})', { title: 'Book', publishedDate: '2010-11-02' }, 'Author');
    expect(result).toMatch(/2010/);
  });

  it('includes seriesPosition with zero-padding', () => {
    const result = buildTargetPath('/audiobooks', '{author}/{series} {seriesPosition:00}/{title}', {
      title: 'Book',
      seriesName: 'Series',
      seriesPosition: 3,
    }, 'Author');
    expect(result).toMatch(/Series 03/);
  });

  it('handles conditional blocks', () => {
    const result = buildTargetPath('/audiobooks', '{author}/{series? - }{title}', {
      title: 'Book',
      seriesName: 'My Series',
    }, 'Author');
    expect(result).toMatch(/My Series - Book/);
  });

  it('omits conditional blocks when value is missing', () => {
    const result = buildTargetPath('/audiobooks', '{author}/{series? - }{title}', {
      title: 'Book',
    }, 'Author');
    expect(result).toMatch(/Author/);
    expect(result).toMatch(/Book/);
    expect(result).not.toMatch(/- /);
  });

  it('renders {authorLastFirst} as "Last, First"', () => {
    const result = buildTargetPath('/audiobooks', '{authorLastFirst}/{title}', { title: 'Book' }, 'Brandon Sanderson');
    expect(result).toMatch(/Sanderson, Brandon/);
  });

  it('renders {titleSort} without leading article', () => {
    const result = buildTargetPath('/audiobooks', '{author}/{titleSort}', { title: 'The Way of Kings' }, 'Author');
    expect(result).toMatch(/Way of Kings/);
  });

  it('renders {narratorLastFirst} for single narrator', () => {
    const result = buildTargetPath('/audiobooks', '{author}/{title} [{narratorLastFirst}]', { title: 'Book', narrators: [{ name: 'Michael Kramer' }] }, 'Author');
    expect(result).toMatch(/Kramer, Michael/);
  });

  it('renders {narratorLastFirst} for multiple narrators → uses position-0 narrator only', () => {
    const result = buildTargetPath('/audiobooks', '{author}/{title} [{narratorLastFirst}]', { title: 'Book', narrators: [{ name: 'Michael Kramer' }, { name: 'Kate Reading' }] }, 'Author');
    expect(result).toMatch(/Kramer, Michael/);
    expect(result).not.toMatch(/Reading, Kate/);
  });
});

describe('ImportService', () => {
  let db: ReturnType<typeof createMockDb>;
  let log: ReturnType<typeof createMockLogger>;
  let clientService: ReturnType<typeof createMockDownloadClientService>;
  let settingsService: ReturnType<typeof createMockSettingsService>;
  let service: ImportService;
  let mockBookService: { getById: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };

  function withAuthor(book: Record<string, unknown>, narratorNames: string[] = []) {
    return {
      ...book,
      authors: [mockAuthor],
      narrators: narratorNames.map((name, i) => ({ id: i + 1, name, slug: name.toLowerCase().replace(/\s+/g, '-'), createdAt: new Date(), updatedAt: new Date() })),
    };
  }

  function collectSetArgs(database: typeof db): Record<string, unknown>[] {
    const setCalls = database.update.mock.results
      .map((r: { value: unknown }) => { try { return (r.value as { set: ReturnType<typeof vi.fn> }).set; } catch { return null; } })
      .filter(Boolean);
    return setCalls.flatMap((s: ReturnType<typeof vi.fn> | null) => s!.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>));
  }

  function setupDefaults() {
    vi.clearAllMocks();
    db = createMockDb();
    log = createMockLogger();
    clientService = createMockDownloadClientService();
    settingsService = createMockSettingsService();
    mockBookService = { getById: vi.fn().mockResolvedValue(withAuthor(mockBook)), update: vi.fn().mockResolvedValue(undefined) };
    service = new ImportService(inject<Db>(db), clientService, settingsService, inject<FastifyBaseLogger>(log), undefined, mockBookService as never);

    // clearAllMocks preserves implementations; reset fs mocks to prevent order-dependent leaks.
    vi.mocked(rm).mockReset();
    vi.mocked(rm).mockResolvedValue(undefined);
    vi.mocked(rename).mockReset();
    vi.mocked(rename).mockResolvedValue(undefined);
    vi.mocked(cp).mockReset();
    vi.mocked(cp).mockResolvedValue(undefined);

    // Source and target default to directories while the commit marker remains absent.
    vi.mocked(stat).mockImplementation(async (p: unknown) =>
      String(p).endsWith('.import-commit-pending')
        ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
        : ({ isFile: () => false, isDirectory: () => true, size: 500_000_000 } as never));

    vi.mocked(readdir).mockResolvedValue([
      { name: 'chapter1.mp3', isFile: () => true, isDirectory: () => false },
    ] as never);
  }

  describe('importDownload', () => {
    beforeEach(setupDefaults);
    it('imports a completed download successfully', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      const chain = mockDbChain();
      db.update.mockReturnValue(chain);

      const result = await service.importDownload(1);

      expect(result.downloadId).toBe(1);
      expect(result.bookId).toBe(1);
      expect(result.targetPath).toMatch(/audiobooks/);
      expect(mkdir).toHaveBeenCalled();
      expect(cp).toHaveBeenCalled();

      // Lifecycle writes touch pipelineStage only; clientStatus belongs to the adapter axis (#1445).
      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      // The first DB write claims the pipeline.
      expect(setCalls[0]).toEqual({ pipelineStage: 'importing' });
      expect(setCalls).toContainEqual({ pipelineStage: 'imported' });
      const downloadAxisWrites = setCalls.filter((s) => 'pipelineStage' in s);
      for (const w of downloadAxisWrites) {
        expect('clientStatus' in w).toBe(false);
      }
    });

    it('throws when download has no linked book', async () => {
      db.select.mockReturnValueOnce(mockDbChain([{ ...mockDownload, bookId: null }]));

      await expect(service.importDownload(1)).rejects.toThrow('no linked book');
    });

    it('throws when download not found', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));

      await expect(service.importDownload(1)).rejects.toThrow('not found');
    });

    it('sets download to failed on error and rethrows', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      const statMock = vi.mocked(stat);
      statMock.mockImplementation(async (p: unknown) =>
        String(p).endsWith('.import-commit-pending') ? markerEnoent() : Promise.reject(new Error('ENOENT')));

      await expect(service.importDownload(1)).rejects.toThrow();
    });

    it('handles torrent removal when deleteAfterImport is true', async () => {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: true, minSeedTime: 0, minSeedRatio: 0 });
        return Promise.resolve({});
      });

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      expect(mockAdapter.removeDownload).toHaveBeenCalledWith('ext-1', true);
    });

    it('swallows adapter error during torrent removal (import still succeeds)', async () => {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: true, minSeedTime: 0, minSeedRatio: 0 });
        return Promise.resolve({});
      });

      mockAdapter.removeDownload.mockRejectedValueOnce(new Error('Connection refused'));

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      const result = await service.importDownload(1);

      expect(result.downloadId).toBe(1);
      expect(mockAdapter.removeDownload).toHaveBeenCalled();
    });

    it('forwards non-default namingSeparator/namingCase to buildTargetPath', async () => {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '', namingSeparator: 'period', namingCase: 'upper' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: false, minSeedTime: 0, minSeedRatio: 0, minFreeSpaceGB: 0 });
        if (key === 'processing') return Promise.resolve({});
        return Promise.resolve({});
      });

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      expect(buildTargetPath).toHaveBeenCalledWith(
        '/audiobooks',
        '{author}/{title}',
        expect.any(Object),
        expect.any(String),
        expect.objectContaining({ separator: 'period', case: 'upper' }),
        null, // editionLabel (#1712)
      );
    });

    it('passes the stored edition label into buildTargetPath as the 6th arg (#1712 F1)', async () => {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title} ({edition})', fileFormat: '', namingSeparator: 'space', namingCase: 'default' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: false, minSeedTime: 0, minSeedRatio: 0, minFreeSpaceGB: 0 });
        if (key === 'processing') return Promise.resolve({});
        return Promise.resolve({});
      });
      mockBookService.getById.mockResolvedValueOnce(withAuthor({ ...mockBook, editionLabel: 'Full Cast' }));

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      expect(buildTargetPath).toHaveBeenCalledWith(
        '/audiobooks',
        '{author}/{title} ({edition})',
        expect.any(Object),
        expect.any(String),
        expect.any(Object),
        'Full Cast',
      );
    });

    it('forwards non-default naming options to renameFilesWithTemplate', async () => {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}', namingSeparator: 'period', namingCase: 'upper' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: false, minSeedTime: 0, minSeedRatio: 0, minFreeSpaceGB: 0 });
        if (key === 'processing') return Promise.resolve({ ffmpegPath: '/usr/bin/ffmpeg' });
        return Promise.resolve({});
      });

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      expect(renameFilesWithTemplate).toHaveBeenCalledWith(
        expect.any(String),
        '{author} - {title}',
        expect.any(Object),
        expect.any(String),
        expect.anything(),
        expect.objectContaining({ separator: 'period', case: 'upper' }),
        undefined,
      );
    });

    it('skips torrent removal when minSeedTime not elapsed', async () => {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: true, minSeedTime: 120, minSeedRatio: 0 }); // 2 hours
        return Promise.resolve({});
      });

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      expect(mockAdapter.removeDownload).not.toHaveBeenCalled();
    });

  describe('enrichFromAudioFiles (via importDownload)', () => {
    const mockScanResult = {
      codec: 'MPEG 1 Layer 3',
      bitrate: 128000,
      sampleRate: 44100,
      channels: 2,
      bitrateMode: 'cbr' as const,
      fileFormat: 'mp3',
      totalDuration: 7200, // 2 hours in seconds
      totalSize: 500_000_000,
      fileCount: 12,
      tagNarrator: 'Steven Pacey',
      hasCoverArt: false,
    };

    function setupImportMocks() {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());
    }

    function getEnrichmentUpdate(): Record<string, unknown> | undefined {
      const updateCalls = db.update.mock.results;
      const setCalls = updateCalls
        .map((r: { value: unknown }) => ((r.value as { set: ReturnType<typeof vi.fn> }).set))
        .filter(Boolean);
      const allSetArgs = setCalls.flatMap((s: ReturnType<typeof vi.fn>) => s.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>));
      return allSetArgs.find((a: Record<string, unknown>) => a.audioCodec);
    }

    /** #2435 split the bibliographic `duration` into its own compare-and-set statement, so it is
     * no longer part of the technical-stats update above. */
    function getDurationUpdate(): Record<string, unknown> | undefined {
      const allSetArgs = db.update.mock.results
        .map((r: { value: unknown }) => ((r.value as { set: ReturnType<typeof vi.fn> }).set))
        .filter(Boolean)
        .flatMap((s: ReturnType<typeof vi.fn>) => s.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>));
      return allSetArgs.find((a: Record<string, unknown>) => a.duration !== undefined && a.audioCodec === undefined);
    }

    it('converts duration from seconds to minutes when writing to books.duration', async () => {
      setupImportMocks();
      const mockScan = vi.mocked(scanAudioDirectory);
      mockScan.mockResolvedValueOnce(mockScanResult);

      await service.importDownload(1);

      const enrichmentCall = getEnrichmentUpdate();
      expect(enrichmentCall).toBeDefined();
      expect(enrichmentCall!.audioDuration).toBe(7200); // technical stat, stays in seconds
      // The bibliographic minute value now lands as its own guarded statement.
      expect(getDurationUpdate()?.duration).toBe(120); // 7200 seconds / 60 = 120 minutes
    });

    it('does not overwrite existing narrator', async () => {
      const bookWithNarrator = withAuthor(mockBook, ['Existing Narrator']);
      mockBookService.getById.mockResolvedValueOnce(bookWithNarrator);
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      const mockScan = vi.mocked(scanAudioDirectory);
      mockScan.mockResolvedValueOnce(mockScanResult);

      await service.importDownload(1);

      const enrichmentCall = getEnrichmentUpdate();
      expect(enrichmentCall).toBeDefined();
      expect(enrichmentCall!.narrator).toBeUndefined();
    });

    it('does not overwrite existing duration', async () => {
      const bookWithDuration = { ...mockBook, duration: 150 };
      mockBookService.getById.mockResolvedValueOnce(withAuthor(bookWithDuration));
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      const mockScan = vi.mocked(scanAudioDirectory);
      mockScan.mockResolvedValueOnce(mockScanResult);

      await service.importDownload(1);

      const enrichmentCall = getEnrichmentUpdate();
      expect(enrichmentCall).toBeDefined();
      expect(enrichmentCall!.duration).toBeUndefined();
    });

    it('saves embedded cover art and sets coverUrl', async () => {
      setupImportMocks();
      const coverData = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const mockScan = vi.mocked(scanAudioDirectory);
      mockScan.mockResolvedValueOnce({
        ...mockScanResult,
        hasCoverArt: true,
        coverImage: coverData,
        coverMimeType: 'image/png',
      });

      await service.importDownload(1);

      // Marker writes share this mock; select the cover call explicitly (#1290).
      const coverCall = vi.mocked(writeFile).mock.calls.find((c) => /cover\.png$/.test(String(c[0])));
      expect(coverCall).toBeDefined();
      expect(coverCall![1]).toBe(coverData);

      const enrichmentCall = getEnrichmentUpdate();
      expect(enrichmentCall!.coverUrl).toBe('/api/books/1/cover');
    });

    it('does not save cover when book already has coverUrl', async () => {
      const bookWithCover = { ...mockBook, coverUrl: 'https://example.com/cover.jpg' };
      mockBookService.getById.mockResolvedValueOnce(withAuthor(bookWithCover));
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      const coverData = Buffer.from([0xff, 0xd8, 0xff]);
      const mockScan = vi.mocked(scanAudioDirectory);
      mockScan.mockResolvedValueOnce({
        ...mockScanResult,
        hasCoverArt: true,
        coverImage: coverData,
        coverMimeType: 'image/jpeg',
      });

      await service.importDownload(1);

      // Marker writes share this mock; exclude cover calls explicitly (#1290).
      const coverCall = vi.mocked(writeFile).mock.calls.find((c) => /cover\./.test(String(c[0])));
      expect(coverCall).toBeUndefined();
    });

    it('continues gracefully when scanner returns null', async () => {
      setupImportMocks();
      const mockScan = vi.mocked(scanAudioDirectory);
      mockScan.mockResolvedValueOnce(null);

      const result = await service.importDownload(1);
      expect(result.downloadId).toBe(1);
    });

    it('writes technical audio fields in enrichment update', async () => {
      setupImportMocks();
      const mockScan = vi.mocked(scanAudioDirectory);
      mockScan.mockResolvedValueOnce(mockScanResult);

      await service.importDownload(1);

      const enrichmentCall = getEnrichmentUpdate();
      expect(enrichmentCall).toMatchObject({
        audioCodec: 'MPEG 1 Layer 3',
        audioBitrate: 128000,
        audioSampleRate: 44100,
        audioChannels: 2,
        audioBitrateMode: 'cbr',
        audioFileFormat: 'mp3',
        audioFileCount: 12,
        audioTotalSize: 500_000_000,
        audioDuration: 7200,
        enrichmentStatus: 'file-enriched',
      });
    });
  });

  describe('importDownload edge cases', () => {
    it('throws when download has no downloadClientId (missing clientId early return)', async () => {
      const downloadNoClient = { ...mockDownload, downloadClientId: null, externalId: null };
      db.select.mockReturnValueOnce(mockDbChain([downloadNoClient]));
      db.update.mockReturnValue(mockDbChain());

      await expect(service.importDownload(1)).rejects.toThrow('missing client or external ID');
    });

    it('throws when download has no externalId', async () => {
      const downloadNoExtId = { ...mockDownload, externalId: null };
      db.select.mockReturnValueOnce(mockDbChain([downloadNoExtId]));
      db.update.mockReturnValue(mockDbChain());

      await expect(service.importDownload(1)).rejects.toThrow('missing client or external ID');
    });

    it('throws when adapter.getDownload returns null', async () => {
      const adapterNoDownload = {
        ...mockAdapter,
        getDownload: vi.fn().mockResolvedValue(null),
      };
      (clientService.getAdapter as Mock).mockResolvedValue(adapterNoDownload);

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      await expect(service.importDownload(1)).rejects.toThrow('not found in client');
    });

    it('throws when adapter.getDownload throws', async () => {
      const adapterThrows = {
        ...mockAdapter,
        getDownload: vi.fn().mockRejectedValue(new Error('Client connection refused')),
      };
      (clientService.getAdapter as Mock).mockResolvedValue(adapterThrows);

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      await expect(service.importDownload(1)).rejects.toThrow('Client connection refused');
    });

    it('throws when no audio files in directory', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      const readdirMock = vi.mocked(readdir);
      readdirMock.mockResolvedValue([
        { name: 'readme.txt', isFile: () => true, isDirectory: () => false },
        { name: 'cover.jpg', isFile: () => true, isDirectory: () => false },
      ] as never);

      await expect(service.importDownload(1)).rejects.toThrow('No audio files found');
    });

    it('sets download to failed when file copy fails mid-import', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      const readdirMock = vi.mocked(readdir);
      readdirMock.mockResolvedValue([
        { name: 'chapter1.mp3', isFile: () => true, isDirectory: () => false },
      ] as never);

      const cpMock = vi.mocked(cp);
      cpMock.mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));

      await expect(service.importDownload(1)).rejects.toThrow('ENOSPC');
      expect(db.update).toHaveBeenCalled();
    });

    it('throws when book not found for linked bookId', async () => {
      mockBookService.getById.mockResolvedValueOnce(null);
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));

      await expect(service.importDownload(1)).rejects.toThrow('Book 1 not found');
    });

    it('throws when download client adapter is null', async () => {
      (clientService.getAdapter as Mock).mockResolvedValue(null);

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      await expect(service.importDownload(1)).rejects.toThrow('not found');
    });
  });
  });

  describe('re-import flow — book already imported', () => {
    const importedBook = createMockDbBook({
      status: 'downloading' as const,
      path: '/audiobooks/Old Author/Old Book',
      size: 400_000_000,
    });

    beforeEach(() => {
      setupDefaults();
      mockBookService.getById.mockResolvedValue(withAuthor(importedBook));
    });

    it('deletes old files when book has existing path at different location', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      // #1589: the old folder's MANAGED files are deleted per-file (not a blanket recursive rm).
      const rmMock = vi.mocked(rm);
      expect(rmMock).toHaveBeenCalledWith(expect.stringMatching(/Old Book[\\/]chapter1\.mp3$/), { force: true });
    });

    it('preserves an unmarked (foreign) metadata.opf in the old folder during re-import cleanup (#1674)', async () => {
      // Default readFile marks metadata.opf foreign, so only audio is managed.
      vi.mocked(readdir).mockResolvedValue([
        { name: 'chapter1.mp3', isFile: () => true, isDirectory: () => false },
        { name: 'metadata.opf', isFile: () => true, isDirectory: () => false },
      ] as never);

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      const rmMock = vi.mocked(rm);
      expect(rmMock).toHaveBeenCalledWith(expect.stringMatching(/Old Book[\\/]chapter1\.mp3$/), { force: true });
      expect(rmMock).not.toHaveBeenCalledWith(expect.stringMatching(/Old Book[\\/]metadata\.opf$/), { force: true });
    });

    it('logs old path at info level during re-import', async () => {
      const log = createMockLogger();
      const svc = new ImportService(inject<Db>(db), clientService, settingsService, inject<FastifyBaseLogger>(log), undefined, mockBookService as never);

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      await svc.importDownload(1);

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ oldPath: '/audiobooks/Old Author/Old Book' }),
        'Cleaned old book managed files during re-import (foreign files preserved)',
      );
    });

    it('skips deletion when target path equals existing book path (same-path re-import)', async () => {
      const samePathBook = createMockDbBook({
        status: 'downloading' as const,
        // Match the path buildTargetPath generates.
        path: '/audiobooks/Brandon Sanderson/The Way of Kings',
      });

      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: false, minSeedTime: 0, minSeedRatio: 0 });
        if (key === 'processing') return Promise.resolve({});
        return Promise.resolve({});
      });

      mockBookService.getById.mockResolvedValueOnce(withAuthor(samePathBook));
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      // Recursive sibling cleanup is allowed; the existing target directory is protected.
      const base = '/audiobooks/Brandon Sanderson/The Way of Kings';
      const rmMock = vi.mocked(rm);
      expect(rmMock).not.toHaveBeenCalledWith(base, expect.objectContaining({ recursive: true }));
    });

    it('stages then commits an in-place re-import: backs up old audio, preserves cover, cleans siblings (same path)', async () => {
      const samePathBook = createMockDbBook({
        status: 'downloading' as const,
        path: '/audiobooks/Brandon Sanderson/The Way of Kings',
      });
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: false, minSeedTime: 0, minSeedRatio: 0 });
        if (key === 'processing') return Promise.resolve({});
        return Promise.resolve({});
      });
      vi.mocked(readdir).mockResolvedValue([
        { name: 'old - 001.mp3', isFile: () => true, isDirectory: () => false },
        { name: 'old - 002.mp3', isFile: () => true, isDirectory: () => false },
        { name: 'cover.jpg', isFile: () => true, isDirectory: () => false },
      ] as never);

      mockBookService.getById.mockResolvedValueOnce(withAuthor(samePathBook));
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      const base = '/audiobooks/Brandon Sanderson/The Way of Kings';
      const { stagingPath: STAGING, backupPath: BACKUP } = deriveImportSiblings(base);
      const renameMock = vi.mocked(rename);
      expect(renameMock).toHaveBeenCalledWith(join(base, 'old - 001.mp3'), join(BACKUP, 'old - 001.mp3'));
      expect(renameMock).toHaveBeenCalledWith(join(base, 'old - 002.mp3'), join(BACKUP, 'old - 002.mp3'));
      expect(renameMock).not.toHaveBeenCalledWith(join(base, 'cover.jpg'), join(BACKUP, 'cover.jpg'));

      const rmMock = vi.mocked(rm);
      expect(rmMock).not.toHaveBeenCalledWith(join(base, 'old - 001.mp3'), { force: true });
      expect(rmMock).not.toHaveBeenCalledWith(base, expect.objectContaining({ recursive: true }));
      expect(rmMock).toHaveBeenCalledWith(BACKUP, { recursive: true, force: true });
      expect(rmMock).toHaveBeenCalledWith(STAGING, { recursive: true, force: true });
    });

    it('continues when old file deletion fails (EACCES)', async () => {
      const rmMock = vi.mocked(rm);
      // Fail only the old-path cleanup; pre-stage sibling cleanup must still succeed.
      rmMock.mockImplementation(async (p: unknown) =>
        String(p).includes('Old Book') ? Promise.reject(new Error('EACCES: permission denied')) : undefined,
      );

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      const result = await service.importDownload(1);
      expect(result.downloadId).toBe(1);
    });

    it('does not roll back new files when old file deletion fails', async () => {
      const rmMock = vi.mocked(rm);
      // Fail only the old-path cleanup; pre-stage sibling cleanup must still succeed.
      rmMock.mockImplementation(async (p: unknown) =>
        String(p).includes('Old Book') ? Promise.reject(new Error('EACCES')) : undefined,
      );

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      expect(cp).toHaveBeenCalled();
      expect(mkdir).toHaveBeenCalled();
    });

    it('does not attempt old-folder deletion when book has no path', async () => {
      mockBookService.getById.mockResolvedValueOnce(withAuthor(mockBook)); // override re-import default
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      // Sibling cleanup may recurse; the new target may not.
      const rmMock = vi.mocked(rm);
      expect(rmMock).not.toHaveBeenCalledWith('/audiobooks/Brandon Sanderson/The Way of Kings', expect.objectContaining({ recursive: true }));
    });

    it('preserves old download record during re-import (history)', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      expect(db.delete).not.toHaveBeenCalled();
    });
  });

  describe('atomic staged re-import — data-loss prevention (#1255)', () => {
    const SAME_PATH = '/audiobooks/Brandon Sanderson/The Way of Kings';
    const { stagingPath: STAGING, backupPath: BACKUP } = deriveImportSiblings(SAME_PATH);

    function useSamePathSettings() {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: false, minSeedTime: 0, minSeedRatio: 0, minFreeSpaceGB: 0 });
        if (key === 'processing') return Promise.resolve({});
        return Promise.resolve({});
      });
    }

    function withExistingAudioAndCover() {
      vi.mocked(readdir).mockResolvedValue([
        { name: 'old.mp3', isFile: () => true, isDirectory: () => false },
        { name: 'cover.jpg', isFile: () => true, isDirectory: () => false },
      ] as never);
    }

    beforeEach(setupDefaults);

    it('AC1: a Phase-1 copy failure leaves the existing book + cover untouched (no blanket delete)', async () => {
      useSamePathSettings();
      mockBookService.getById.mockResolvedValueOnce(withAuthor(createMockDbBook({ status: 'downloading' as const, path: SAME_PATH })));
      withExistingAudioAndCover();
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      vi.mocked(cp).mockRejectedValueOnce(new Error('ENOSPC during staging'));

      await expect(service.importDownload(1)).rejects.toThrow('ENOSPC during staging');

      // Per-file pair, not a recursive-rm negative: cleanup never issues rm(target, {recursive}),
      // so that shape passes under every implementation, including one deleting file-by-file (#2534).
      expect(fsCallsPosix(vi.mocked(rm))).not.toContainEqual([TARGET_AUDIO, { force: true }]);
      expect(fsCallsPosix(vi.mocked(rmdir))).not.toContainEqual([SAME_PATH]);
      expect(rename).not.toHaveBeenCalledWith(join(SAME_PATH, 'old.mp3'), join(BACKUP, 'old.mp3'));
      expect(rm).toHaveBeenCalledWith(STAGING, { recursive: true, force: true });
    });

    it('AC2: a Phase-2 commit/swap failure rolls back, restoring the original audio', async () => {
      useSamePathSettings();
      mockBookService.getById.mockResolvedValueOnce(withAuthor(createMockDbBook({ status: 'downloading' as const, path: SAME_PATH })));
      withExistingAudioAndCover();
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      // Fail only the staged-file move into the target.
      vi.mocked(rename).mockImplementation(async (src: unknown, dst: unknown) => {
        const s = String(src); const d = String(dst);
        if (s.includes('.import-staging') && !d.includes('.import-staging') && !d.includes('.import-backup')) {
          throw new Error('EIO during swap');
        }
      });

      await expect(service.importDownload(1)).rejects.toThrow('EIO during swap');

      expect(rename).toHaveBeenCalledWith(join(BACKUP, 'old.mp3'), join(SAME_PATH, 'old.mp3'));
      expect(fsCallsPosix(vi.mocked(rm))).not.toContainEqual([TARGET_AUDIO, { force: true }]);
      expect(fsCallsPosix(vi.mocked(rmdir))).not.toContainEqual([SAME_PATH]);
      expect(rm).toHaveBeenCalledWith(STAGING, { recursive: true, force: true });
      expect(rm).toHaveBeenCalledWith(BACKUP, { recursive: true, force: true });
    });

    it('#1341: a non-file marker-path collision aborts the auto import before any destructive work', async () => {
      // A directory squats on the marker path. Preflight must fail before sibling derivation,
      // preventing cleanup from touching the adjacent backup or target (#1341).
      useSamePathSettings();
      mockBookService.getById.mockResolvedValueOnce(withAuthor(createMockDbBook({ status: 'downloading' as const, path: SAME_PATH })));
      withExistingAudioAndCover();
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      vi.mocked(stat).mockImplementation(async (p: unknown) =>
        String(p).endsWith('.import-commit-pending')
          ? ({ isFile: () => false, isDirectory: () => true } as never)
          : ({ isFile: () => false, isDirectory: () => true, size: 500_000_000 } as never));

      await expect(service.importDownload(1)).rejects.toBeInstanceOf(MarkerPathConflictError);

      expect(cp).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
      expect(writeFile).not.toHaveBeenCalledWith(`${SAME_PATH}.import-commit-pending`, expect.anything(), expect.anything());
      expect(rm).not.toHaveBeenCalledWith(STAGING, expect.objectContaining({ recursive: true }));
      expect(rm).not.toHaveBeenCalledWith(BACKUP, expect.objectContaining({ recursive: true }));
      expect(fsCallsPosix(vi.mocked(rm))).not.toContainEqual([TARGET_AUDIO, { force: true }]);
      expect(fsCallsPosix(vi.mocked(rmdir))).not.toContainEqual([SAME_PATH]);
    });

    it('#1336 window 4: a pre-flight validateSource throw with a marker on disk preserves .import-bak + the marker', async () => {
      // Recovery can fail before sibling preparation; an on-disk marker must protect the prior
      // crash backup from failure cleanup (#1290/#1336).
      useSamePathSettings();
      mockBookService.getById.mockResolvedValueOnce(withAuthor(createMockDbBook({ status: 'downloading' as const, path: SAME_PATH })));
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      // A regular-file marker passes preflight; the missing source fails validation (#1341).
      vi.mocked(stat).mockImplementation(async (p: unknown) =>
        String(p).endsWith('.import-commit-pending')
          ? ({ isFile: () => true, isDirectory: () => false } as never)
          : Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));

      await expect(service.importDownload(1)).rejects.toThrow(/Path not found/);

      expect(rm).not.toHaveBeenCalledWith(BACKUP, { recursive: true, force: true });
      expect(rm).not.toHaveBeenCalledWith(`${SAME_PATH}.import-commit-pending`, { force: true });
    });

    it('#1336 window 4: a pre-flight checkDiskSpace throw with a marker on disk preserves .import-bak + the marker', async () => {
      // Disk-space checks can fail before sibling recovery; marker-protected backups must survive.
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: false, minSeedTime: 0, minSeedRatio: 0, minFreeSpaceGB: 5 });
        if (key === 'processing') return Promise.resolve({});
        return Promise.resolve({});
      });
      mockBookService.getById.mockResolvedValueOnce(withAuthor(createMockDbBook({ status: 'downloading' as const, path: SAME_PATH })));
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());
      // Audio extension keeps the failure under test in checkDiskSpace (#1852).
      (mockAdapter.getDownload as Mock).mockResolvedValueOnce({ ...defaultDownloadItem, name: 'book.m4b' });

      // File source makes sizing use stat.size instead of the self-referential readdir mock.
      vi.mocked(stat).mockImplementation(async (p: unknown) =>
        String(p).endsWith('.import-commit-pending')
          ? ({ isFile: () => true, isDirectory: () => false } as never)
          : ({ isFile: () => true, isDirectory: () => false, size: 500_000_000 } as never));
      vi.mocked(statfs).mockRejectedValueOnce(new Error('statfs EIO'));

      await expect(service.importDownload(1)).rejects.toThrow(/Disk space check failed/);

      expect(rm).not.toHaveBeenCalledWith(BACKUP, { recursive: true, force: true });
      expect(rm).not.toHaveBeenCalledWith(`${SAME_PATH}.import-commit-pending`, { force: true });
    });

    it('F1: aborts before staging when a stale staging sibling cannot be cleared (never commits leftovers)', async () => {
      useSamePathSettings();
      mockBookService.getById.mockResolvedValueOnce(withAuthor(createMockDbBook({ status: 'downloading' as const, path: SAME_PATH })));
      withExistingAudioAndCover();
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      // Clearing staging is mandatory because commitStagedImport trusts every remaining entry (#1911).
      vi.mocked(rm).mockImplementation(async (p: unknown) =>
        String(p).endsWith('.import-staging')
          ? Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
          : undefined,
      );

      await expect(service.importDownload(1)).rejects.toThrow('EACCES');

      expect(cp).not.toHaveBeenCalled();
      expect(fsCallsPosix(vi.mocked(rm))).not.toContainEqual([TARGET_AUDIO, { force: true }]);
      expect(fsCallsPosix(vi.mocked(rmdir))).not.toContainEqual([SAME_PATH]);
    });

    const posixOf = (p: string) => p.split('\\').join('/');
    const STAGING_POSIX = posixOf(STAGING);
    const TARGET_AUDIO = `${SAME_PATH}/old.mp3`;

    /**
     * fs-spy calls with the leading path POSIX-folded. `deleteManagedBookFiles` reaches each entry
     * through `join`, so the per-file argument is backslash-spelled on Windows — which would let a
     * `not.toHaveBeenCalledWith` pass on the spelling rather than on the file surviving.
     */
    function fsCallsPosix(spy: Mock): unknown[][] {
      return spy.mock.calls.map(([p, ...rest]: unknown[]) => [posixOf(String(p)), ...rest]);
    }

    /** Drive a pre-commit copy failure with `storedPath` as the book's persisted `books.path`. */
    async function failCopyWithStoredPath(storedPath: string) {
      useSamePathSettings();
      mockBookService.getById.mockResolvedValueOnce(withAuthor(createMockDbBook({ status: 'downloading' as const, path: storedPath })));
      withExistingAudioAndCover();
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());
      vi.mocked(cp).mockRejectedValueOnce(new Error('ENOSPC during staging'));

      await expect(service.importDownload(1)).rejects.toThrow('ENOSPC during staging');
    }

    it.each([
      ['a trailing separator', `${SAME_PATH}/`],
      ['a doubled trailing separator', `${SAME_PATH}//`],
      ['backslash separators', '/audiobooks\\Brandon Sanderson\\The Way of Kings'],
    ])('#2475: a pre-commit failure preserves the operator audio when the stored path uses %s', async (_label, storedPath) => {
      await failCopyWithStoredPath(storedPath);

      // Unprotected cleanup is per-file managed delete + rmdir, never a recursive rm of the target.
      expect(fsCallsPosix(vi.mocked(rm))).not.toContainEqual([TARGET_AUDIO, { force: true }]);
      expect(fsCallsPosix(vi.mocked(rmdir))).not.toContainEqual([SAME_PATH]);
      expect(fsCallsPosix(vi.mocked(rm))).toContainEqual([STAGING_POSIX, { recursive: true, force: true }]);
    });

    it('#2475: a case-only difference still reads as two folders — the target is cleaned', async () => {
      await failCopyWithStoredPath(SAME_PATH.toLowerCase());

      expect(fsCallsPosix(vi.mocked(rm))).toContainEqual([TARGET_AUDIO, { force: true }]);
      expect(fsCallsPosix(vi.mocked(rmdir))).toContainEqual([SAME_PATH]);
    });

    it('#2475: a successful re-import from a trailing-separator stored path persists the computed target and sweeps nothing', async () => {
      useSamePathSettings();
      mockBookService.getById.mockResolvedValueOnce(withAuthor(createMockDbBook({ status: 'downloading' as const, path: `${SAME_PATH}/` })));
      withExistingAudioAndCover();
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      const result = await service.importDownload(1);

      expect(posixOf(result.targetPath)).toBe(SAME_PATH);
      const persisted = collectSetArgs(db)
        .map((a) => (typeof a.path === 'string' ? { ...a, path: posixOf(a.path) } : a));
      expect(persisted).toContainEqual(expect.objectContaining({ status: 'imported', path: SAME_PATH }));
      // The post-commit old-path sweep must recognise the stored spelling as the folder just imported.
      expect(fsCallsPosix(vi.mocked(rm))).not.toContainEqual([TARGET_AUDIO, { force: true }]);
    });

    it('AC4: a first-import copy failure cleans up its own partial (staged) files', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());
      vi.mocked(cp).mockRejectedValueOnce(new Error('ENOSPC'));

      await expect(service.importDownload(1)).rejects.toThrow('ENOSPC');

      const stagingCleanup = vi.mocked(rm).mock.calls.find(([p]) => String(p).endsWith('.import-staging'));
      expect(stagingCleanup).toBeDefined();
    });
  });

  describe('move-path re-import — post-commit ordering (#1257)', () => {
    // Default folder settings resolve to this target.
    const NEW_TARGET = '/audiobooks/Brandon Sanderson/The Way of Kings';
    const OLD_PATH = '/audiobooks/Brandon Sanderson/Old Title';
    const { stagingPath: STAGING, backupPath: BACKUP } = deriveImportSiblings(NEW_TARGET);

    /** Reject update #3 after commit; earlier writes and later failure reverts resolve. */
    function failPostCommitUpdate() {
      let updateCallCount = 0;
      db.update.mockImplementation(() => {
        updateCallCount++;
        const chain = mockDbChain();
        if (updateCallCount === 3) {
          // The guarded download transition terminates at returning().
          (chain.returning as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('constraint violation'));
        }
        return chain as never;
      });
    }

    beforeEach(setupDefaults);

    it('post-commit DB failure preserves the committed new target AND the old path, reverting the book to imported', async () => {
      mockBookService.getById.mockResolvedValueOnce(withAuthor(createMockDbBook({ status: 'downloading' as const, path: OLD_PATH })));
      db.select.mockReturnValueOnce(mockDbChain([{ ...mockDownload, bookStatusAtGrab: 'imported' }]));
      failPostCommitUpdate();

      await expect(service.importDownload(1)).rejects.toThrow('constraint violation');

      expect(rm).not.toHaveBeenCalledWith(NEW_TARGET, { recursive: true, force: true });
      expect(rm).not.toHaveBeenCalledWith(OLD_PATH, { recursive: true, force: true });
      expect(rm).toHaveBeenCalledWith(STAGING, { recursive: true, force: true });
      expect(rm).toHaveBeenCalledWith(BACKUP, { recursive: true, force: true });

      const allSetArgs = collectSetArgs(db);
      expect(allSetArgs).toContainEqual(expect.objectContaining({ clientStatus: 'failed' }));
      expect(allSetArgs).toContainEqual(expect.objectContaining({ status: 'imported' }));
      expect(allSetArgs).not.toContainEqual(expect.objectContaining({ status: 'wanted' }));
    });

    it('post-commit success still deletes the old folder (now after the DB commit) and points the book at targetPath', async () => {
      mockBookService.getById.mockResolvedValueOnce(withAuthor(createMockDbBook({ status: 'downloading' as const, path: OLD_PATH })));
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      const result = await service.importDownload(1);

      expect(result.targetPath).toBe(NEW_TARGET);
      // Old-path cleanup remains per-file (#1589).
      expect(rm).toHaveBeenCalledWith(expect.stringMatching(/Old Title[\\/]chapter1\.mp3$/), { force: true });
      const allSetArgs = collectSetArgs(db);
      expect(allSetArgs).toContainEqual(expect.objectContaining({ status: 'imported', path: NEW_TARGET }));
    });

    it('same-path re-import: post-commit DB failure does not rm the target (unchanged from #1255)', async () => {
      mockBookService.getById.mockResolvedValueOnce(withAuthor(createMockDbBook({ status: 'downloading' as const, path: NEW_TARGET })));
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      failPostCommitUpdate();

      await expect(service.importDownload(1)).rejects.toThrow('constraint violation');

      expect(rm).not.toHaveBeenCalledWith(NEW_TARGET, { recursive: true, force: true });
    });

    it('first import: pre-commit copy failure cleans the scratch target + siblings (protectTarget still false)', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());
      vi.mocked(cp).mockRejectedValueOnce(new Error('ENOSPC'));

      await expect(service.importDownload(1)).rejects.toThrow('ENOSPC');

      // Unprotected scratch target uses per-file cleanup; only its sibling is removed recursively.
      expect(rm).toHaveBeenCalledWith(expect.stringContaining(NEW_TARGET), { force: true });
      expect(rmdir).toHaveBeenCalledWith(NEW_TARGET);
      expect(rm).toHaveBeenCalledWith(STAGING, { recursive: true, force: true });
    });

    it('move re-import: pre-commit copy failure cleans the new scratch target but leaves the old path untouched', async () => {
      mockBookService.getById.mockResolvedValueOnce(withAuthor(createMockDbBook({ status: 'downloading' as const, path: OLD_PATH })));
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());
      vi.mocked(cp).mockRejectedValueOnce(new Error('ENOSPC'));

      await expect(service.importDownload(1)).rejects.toThrow('ENOSPC');

      expect(rm).toHaveBeenCalledWith(expect.stringContaining(NEW_TARGET), { force: true });
      expect(rmdir).toHaveBeenCalledWith(NEW_TARGET);
      // Old-path cleanup begins only after commit and DB persistence.
      expect(rm).not.toHaveBeenCalledWith(expect.stringContaining(OLD_PATH), expect.anything());
      expect(rmdir).not.toHaveBeenCalledWith(OLD_PATH);
    });
  });

  describe('book status recovery on import failure', () => {
    beforeEach(setupDefaults);

    it('reverts book to its imported pre-grab snapshot when an upgrade import fails', async () => {
      const importedBook = createMockDbBook({
        status: 'downloading' as const,
        path: '/audiobooks/existing',
      });
      mockBookService.getById.mockResolvedValueOnce(withAuthor(importedBook));
      db.select.mockReturnValueOnce(mockDbChain([{ ...mockDownload, bookStatusAtGrab: 'imported' }]));
      db.update.mockReturnValue(mockDbChain());

      const statMock = vi.mocked(stat);
      statMock.mockImplementation(async (p: unknown) =>
        String(p).endsWith('.import-commit-pending') ? markerEnoent() : Promise.reject(new Error('ENOENT')));

      await expect(service.importDownload(1)).rejects.toThrow();

      const updateCalls = db.update.mock.results;
      const setCalls = updateCalls
        .map((r: { value: unknown }) => ((r.value as { set: ReturnType<typeof vi.fn> }).set))
        .filter(Boolean);
      const allSetArgs = setCalls.flatMap((s: ReturnType<typeof vi.fn>) => s.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>));
      expect(allSetArgs).toContainEqual(expect.objectContaining({ status: 'imported' }));
    });

    it('reverts book to its wanted pre-grab snapshot when a first-download import fails', async () => {
      db.select.mockReturnValueOnce(mockDbChain([{ ...mockDownload, bookStatusAtGrab: 'wanted' }]));
      db.update.mockReturnValue(mockDbChain());

      const statMock = vi.mocked(stat);
      statMock.mockImplementation(async (p: unknown) =>
        String(p).endsWith('.import-commit-pending') ? markerEnoent() : Promise.reject(new Error('ENOENT')));

      await expect(service.importDownload(1)).rejects.toThrow();

      const updateCalls = db.update.mock.results;
      const setCalls = updateCalls
        .map((r: { value: unknown }) => ((r.value as { set: ReturnType<typeof vi.fn> }).set))
        .filter(Boolean);
      const allSetArgs = setCalls.flatMap((s: ReturnType<typeof vi.fn>) => s.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>));
      expect(allSetArgs).toContainEqual(expect.objectContaining({ status: 'wanted' }));
    });

    it('reverts book to imported on copy failure when book has path', async () => {
      const importedBook = createMockDbBook({
        status: 'downloading' as const,
        path: '/audiobooks/existing',
      });
      mockBookService.getById.mockResolvedValueOnce(withAuthor(importedBook));
      db.select.mockReturnValueOnce(mockDbChain([{ ...mockDownload, bookStatusAtGrab: 'imported' }]));
      db.update.mockReturnValue(mockDbChain());

      const cpMock = vi.mocked(cp);
      cpMock.mockRejectedValueOnce(new Error('ENOSPC'));

      await expect(service.importDownload(1)).rejects.toThrow('ENOSPC');

      const updateCalls = db.update.mock.results;
      const setCalls = updateCalls
        .map((r: { value: unknown }) => ((r.value as { set: ReturnType<typeof vi.fn> }).set))
        .filter(Boolean);
      const allSetArgs = setCalls.flatMap((s: ReturnType<typeof vi.fn>) => s.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>));
      expect(allSetArgs).toContainEqual(expect.objectContaining({ status: 'imported' }));
    });

  });

  describe('target path cleanup on import failure', () => {
    beforeEach(setupDefaults);

    it('preserves targetPath when DB update throws after copy (#1257 — committed version protected)', async () => {
      db.select.mockReturnValueOnce(mockDbChain([{ ...mockDownload, bookStatusAtGrab: 'wanted' }]));

      // Reject update #3, the guarded post-commit download transition.
      let updateCallCount = 0;
      db.update.mockImplementation(() => {
        updateCallCount++;
        if (updateCallCount === 3) {
          // transitionDownloadState terminates at returning().
          return { set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockRejectedValue(new Error('DB write failed')) }) }) } as never;
        }
        return mockDbChain() as never;
      });

      const rmMock = vi.mocked(rm);

      await expect(service.importDownload(1)).rejects.toThrow('DB write failed');

      // Post-commit failures protect the target; match join() output on both separators (#1257).
      expect(rmMock).not.toHaveBeenCalledWith(
        expect.stringMatching(/[\\/]audiobooks[\\/]Brandon Sanderson[\\/]The Way of Kings$/),
        { recursive: true, force: true },
      );
      expect(rmMock).toHaveBeenCalledWith(
        expect.stringMatching(/[\\/]audiobooks[\\/]Brandon Sanderson[\\/]\.The Way of Kings\.import-staging$/),
        { recursive: true, force: true },
      );

      const updateCalls = db.update.mock.results;
      const setCalls = updateCalls
        .map((r: { value: unknown }) => {
          try { return (r.value as { set: ReturnType<typeof vi.fn> }).set; } catch { return null; }
        })
        .filter(Boolean);
      const allSetArgs = setCalls!.flatMap((s: ReturnType<typeof vi.fn> | null) => s!.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>));
      expect(allSetArgs).toContainEqual(expect.objectContaining({ clientStatus: 'failed' }));
      expect(allSetArgs).toContainEqual(expect.objectContaining({ status: 'wanted' }));
    });

    it('logs warning and continues DB revert when a managed targetPath file cannot be deleted (pre-commit cleanup)', async () => {
      // Pre-commit cleanup deletes only managed files. A locked file warns while the import error
      // and DB revert continue (#1257/#1589).
      db.select.mockReturnValueOnce(mockDbChain([{ ...mockDownload, bookStatusAtGrab: 'wanted' }]));
      db.update.mockReturnValue(mockDbChain());

      vi.mocked(cp).mockRejectedValueOnce(new Error('ENOSPC during copy'));

      // Reject only force-only managed-file deletion; recursive sibling cleanup still succeeds.
      const rmMock = vi.mocked(rm);
      rmMock.mockImplementation((_p: unknown, opts: unknown) =>
        (opts as { recursive?: boolean })?.recursive
          ? Promise.resolve(undefined)
          : Promise.reject(new Error('EPERM: permission denied')));

      await expect(service.importDownload(1)).rejects.toThrow('ENOSPC during copy');

      expect(rmMock).toHaveBeenCalledWith(expect.stringContaining('audiobooks'), { force: true });
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ file: expect.stringContaining('audiobooks') }),
        expect.stringContaining('Failed to delete managed book file'),
      );

      const updateCalls = db.update.mock.results;
      const setCalls = updateCalls
        .map((r: { value: unknown }) => {
          try { return (r.value as { set: ReturnType<typeof vi.fn> }).set; } catch { return null; }
        })
        .filter(Boolean);
      const allSetArgs = setCalls!.flatMap((s: ReturnType<typeof vi.fn> | null) => s!.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>));
      expect(allSetArgs).toContainEqual(expect.objectContaining({ clientStatus: 'failed' }));
      expect(allSetArgs).toContainEqual(expect.objectContaining({ status: 'wanted' }));
    });
  });

  describe('file renaming with template (non-processing path)', () => {
    beforeEach(setupDefaults);

    it('renames audio files using fileFormat template after import', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      const readdirMock = vi.mocked(readdir);
      readdirMock.mockResolvedValue([
        { name: 'scene-release-01.mp3', isFile: () => true, isDirectory: () => false },
      ] as never);

      await service.importDownload(1);

      const renameMock = vi.mocked(rename);
      expect(renameMock).toHaveBeenCalled();
    });
  });

  describe('phase + progress callbacks (#681)', () => {
    beforeEach(setupDefaults);

    it('calls setPhase in order: copying → renaming → fetching_metadata when rename branch fires', async () => {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: false, minSeedTime: 0, minSeedRatio: 0, minFreeSpaceGB: 0 });
        if (key === 'processing') return Promise.resolve({});
        return Promise.resolve({});
      });

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      const setPhase = vi.fn().mockResolvedValue(undefined);

      await service.importDownload(1, { setPhase });

      const phaseArgs = setPhase.mock.calls.map((c) => c[0]);
      expect(phaseArgs).toEqual(['copying', 'renaming', 'fetching_metadata']);
    });

    it('omits renaming phase when fileFormat is empty (rename branch skipped)', async () => {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: false, minSeedTime: 0, minSeedRatio: 0, minFreeSpaceGB: 0 });
        if (key === 'processing') return Promise.resolve({});
        return Promise.resolve({});
      });

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      const setPhase = vi.fn().mockResolvedValue(undefined);

      await service.importDownload(1, { setPhase });

      const phaseArgs = setPhase.mock.calls.map((c) => c[0]);
      expect(phaseArgs).toEqual(['copying', 'fetching_metadata']);
    });

    it('behaves identically when callbacks are omitted (backward compatibility)', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      const result = await service.importDownload(1);
      expect(result.downloadId).toBe(1);
      expect(result.bookId).toBe(1);
    });

    it('forwards copy progress to emitProgress tagged as copying with byteCounter', async () => {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: false, minSeedTime: 0, minSeedRatio: 0, minFreeSpaceGB: 0 });
        if (key === 'processing') return Promise.resolve({});
        return Promise.resolve({});
      });

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      vi.mocked(copyToLibrary).mockImplementationOnce(async (args) => {
        args.onProgress?.(0.5, { current: 500, total: 1000 });
        args.onProgress?.(1, { current: 1000, total: 1000 });
      });

      const emitProgress = vi.fn();
      await service.importDownload(1, { emitProgress });

      expect(emitProgress).toHaveBeenCalledWith('copying', 0.5, { current: 500, total: 1000 });
      expect(emitProgress).toHaveBeenCalledWith('copying', 1, { current: 1000, total: 1000 });
    });

    it('forwards rename progress to emitProgress tagged as renaming with byteCounter and derived ratio', async () => {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: false, minSeedTime: 0, minSeedRatio: 0, minFreeSpaceGB: 0 });
        if (key === 'processing') return Promise.resolve({});
        return Promise.resolve({});
      });

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      // Isolate rename progress from real copying.
      vi.mocked(copyToLibrary).mockImplementationOnce(async () => {});
      // onProgress is positional argument 7.
      vi.mocked(renameFilesWithTemplate).mockImplementationOnce(async (...args: unknown[]) => {
        const onProgress = args[6] as ((current: number, total: number) => void) | undefined;
        onProgress?.(1, 2);
        onProgress?.(2, 2);
        return 2;
      });

      const emitProgress = vi.fn();
      await service.importDownload(1, { emitProgress });

      expect(emitProgress).toHaveBeenCalledWith('renaming', 0.5, { current: 1, total: 2 });
      expect(emitProgress).toHaveBeenCalledWith('renaming', 1, { current: 2, total: 2 });
    });

    it('passes an onProgress function into copyToLibrary only when emitProgress is provided', async () => {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: false, minSeedTime: 0, minSeedRatio: 0, minFreeSpaceGB: 0 });
        if (key === 'processing') return Promise.resolve({});
        return Promise.resolve({});
      });

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);
      const withoutCallbackArgs = vi.mocked(copyToLibrary).mock.calls[0]![0];
      expect(withoutCallbackArgs.onProgress).toBeUndefined();

      vi.mocked(copyToLibrary).mockClear();
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());
      vi.mocked(copyToLibrary).mockImplementationOnce(async () => {});

      const emitProgress = vi.fn();
      await service.importDownload(1, { emitProgress });
      const withCallbackArgs = vi.mocked(copyToLibrary).mock.calls[0]![0];
      expect(typeof withCallbackArgs.onProgress).toBe('function');
    });
  });

  describe('ffprobe path derivation', () => {
    beforeEach(setupDefaults);

    it('passes derived ffprobePath to enrichBookFromAudio when ffmpegPath is configured', async () => {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: false, minSeedTime: 0, minSeedRatio: 0 });
        if (key === 'processing') return Promise.resolve({
          outputFormat: 'm4b',
          keepOriginalBitrate: false,
          bitrate: 128,
        });
        return Promise.resolve({});
      });

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      expect(enrichBookFromAudioWithinAdmissionLock).toHaveBeenCalledWith(
        expect.any(Number), // bookId
        expect.any(String), // targetPath
        expect.anything(),  // book
        expect.anything(),  // db
        expect.anything(),  // log
        expect.anything(),  // bookService
        '/usr/bin/ffprobe', // ffprobePath derived from /usr/bin/ffmpeg
      );
    });
  });

  describe('remote path mapping integration', () => {
    let mockMappingService: RemotePathMappingService;
    let serviceWithMappings: ImportService;

    beforeEach(() => {
      setupDefaults();
      mockMappingService = inject<RemotePathMappingService>({
        getByClientId: vi.fn().mockResolvedValue([]),
      });
      serviceWithMappings = new ImportService(
        inject<Db>(db), clientService, settingsService,
        inject<FastifyBaseLogger>(createMockLogger()),
        mockMappingService,
        mockBookService as never,
      );
    });

    it('applies path mapping when a matching mapping exists', async () => {
      (mockMappingService.getByClientId as Mock).mockResolvedValue([
        { id: 1, downloadClientId: 1, remotePath: '/downloads/', localPath: 'C:\\library\\' },
      ]);

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      const statMock = vi.mocked(stat);
      statMock.mockImplementation(statDirMarkerAbsent);

      const result = await serviceWithMappings.importDownload(1);

      // Marker preflight runs first; select the first non-marker source stat (#1341).
      const statPath = statMock.mock.calls.find((c) => !String(c[0]).endsWith('.import-commit-pending'))![0] as string;
      expect(statPath).toMatch(/^C:[/\\]library[/\\]/);
      expect(statPath).not.toMatch(/^\/downloads\//);

      const cpMock = vi.mocked(cp);
      const cpSource = cpMock.mock.calls[0]![0] as string;
      expect(cpSource).toMatch(/^C:[/\\]library[/\\]/);

      expect(result.downloadId).toBe(1);
    });

    it('skips mapping when no mappings match the path', async () => {
      (mockMappingService.getByClientId as Mock).mockResolvedValue([
        { id: 1, downloadClientId: 1, remotePath: '/other/', localPath: 'D:\\other\\' },
      ]);

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      const result = await serviceWithMappings.importDownload(1);

      expect(result.downloadId).toBe(1);
    });

    it('includes ENOENT guidance suggesting path mapping when none configured', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      const statMock = vi.mocked(stat);
      const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
      enoent.code = 'ENOENT';
      statMock.mockImplementation(async (p: unknown) =>
        String(p).endsWith('.import-commit-pending') ? markerEnoent() : Promise.reject(enoent));

      await expect(serviceWithMappings.importDownload(1)).rejects.toThrow(
        /add a Remote Path Mapping/,
      );
    });

    it('includes ENOENT guidance about mapping config when mapping exists but path wrong', async () => {
      (mockMappingService.getByClientId as Mock).mockResolvedValue([
        { id: 1, downloadClientId: 1, remotePath: '/downloads/', localPath: 'C:\\library\\' },
      ]);

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      const statMock = vi.mocked(stat);
      const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
      enoent.code = 'ENOENT';
      statMock.mockImplementation(async (p: unknown) =>
        String(p).endsWith('.import-commit-pending') ? markerEnoent() : Promise.reject(enoent));

      await expect(serviceWithMappings.importDownload(1)).rejects.toThrow(
        /Check your remote path mapping configuration/,
      );
    });
  });

  /**
   * #2538 AC8–AC12 — the automatic pipeline's adoption of the #2478 containment rule, on the MAPPED
   * save path. Every service here is built with a RETAINED logger: the sibling mapping suite above
   * constructs its service with an inline `createMockLogger()` no variable holds, so AC12's log
   * assertions written against the suite-level `log` would watch a logger production never uses.
   */
  describe('automatic import source containment (#2538)', () => {
    // Verbatim `REFUSAL_MESSAGES` copy: the operator reads these off the failed download row.
    const ROOT_MESSAGE = 'Source path is a whole filesystem root — pick the folder or file that holds the book, not the entire drive';
    const INSIDE_MESSAGE = 'Source path is inside the library root — it is already managed by the library';
    const CONTAINS_MESSAGE = 'Source path contains the library root — importing a folder that holds your library would pull its own managed files back in';

    /** `join(savePath, name)` for the default fixture — what a mapping's remote side must match whole. */
    const FULL_REMOTE = '/downloads/The Way of Kings';

    let serviceLog: ReturnType<typeof createMockLogger>;

    function arm(
      mappings: Array<{ remotePath: string; localPath: string }>,
      libraryPath = '/audiobooks',
    ): ImportService {
      const settings = createMockSettingsService({ library: { path: libraryPath } });
      const mappingService = inject<RemotePathMappingService>({
        getByClientId: vi.fn().mockResolvedValue(mappings.map((m, i) => ({ id: i + 1, downloadClientId: 1, ...m }))),
      });
      serviceLog = createMockLogger();
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());
      return new ImportService(
        inject<Db>(db), clientService, settings,
        inject<FastifyBaseLogger>(serviceLog), mappingService, mockBookService as never,
      );
    }

    /**
     * `clearAllMocks` preserves implementations, so the identity `realpath` the file-level mock ships
     * has to be re-established around the two cases that override it — otherwise a resolved-path
     * override leaks forward into every suite that runs after this one.
     */
    const identityRealpath = (): void => {
      vi.mocked(realpath).mockReset();
      vi.mocked(realpath).mockImplementation(async (p: unknown) => String(p) as never);
    };

    beforeEach(() => {
      setupDefaults();
      identityRealpath();
    });

    afterEach(identityRealpath);

    // T18 — the positive control every refusal below is measured against.
    it('still imports successfully when the mapped save path is outside the library', async () => {
      const svc = arm([{ remotePath: '/downloads', localPath: '/mnt/complete' }]);

      const result = await svc.importDownload(1);

      expect(result.downloadId).toBe(1);
      expect(cp).toHaveBeenCalled();
      expect(serviceLog.error).not.toHaveBeenCalled();
    });

    // T19 — one case per refusal class, each reached through the mapped save path.
    it('refuses a mapping that lands the save path ON the library root', async () => {
      const svc = arm([{ remotePath: FULL_REMOTE, localPath: '/audiobooks' }]);

      await expect(svc.importDownload(1)).rejects.toThrow(INSIDE_MESSAGE);
    });

    it('refuses a mapping that lands the save path on a strict ANCESTOR of the library root', async () => {
      const svc = arm([{ remotePath: FULL_REMOTE, localPath: '/media' }], '/media/audiobooks');

      await expect(svc.importDownload(1)).rejects.toThrow(CONTAINS_MESSAGE);
    });

    /**
     * AC16/D3 — the knowingly-accepted regression. A strict descendant is bounded, but `copyAudioFiles`
     * enumerates the whole source tree, so `/audiobooks/Author` would still flatten already-managed
     * audio into the new book. Same defect, smaller radius; one rule at three boundaries.
     */
    it('refuses a mapping that lands the save path UNDER the library root', async () => {
      const svc = arm([{ remotePath: '/downloads', localPath: '/audiobooks' }]);

      await expect(svc.importDownload(1)).rejects.toThrow(INSIDE_MESSAGE);
    });

    /**
     * The filesystem-root class has two entry routes since #2551: what the client itself reports as
     * the save path, and a whole-path mapping whose local side is a root — `applyPathMapping` now
     * emits the root spelling ('/', 'C:/') instead of the pre-#2551 degenerate '' there.
     */
    it('refuses a client save path that is a filesystem root', async () => {
      mockAdapter.getDownload.mockResolvedValueOnce({ ...defaultDownloadItem, savePath: '/', name: '' });
      const svc = arm([]);

      await expect(svc.importDownload(1)).rejects.toThrow(ROOT_MESSAGE);
    });

    it('refuses a whole-path mapping whose local side is a filesystem root (#2551)', async () => {
      const svc = arm([{ remotePath: FULL_REMOTE, localPath: '/' }]);

      await expect(svc.importDownload(1)).rejects.toThrow(ROOT_MESSAGE);
    });

    /**
     * T20/AC9 — a refusal performs ZERO filesystem work. `readdir` is armed with a real entry first so
     * the per-file negatives have something to observe: per `import-failure-cleanup-is-per-file`, a
     * `recursive: true` negative is vacuous because `handleImportFailure` never issues one.
     */
    it('touches the filesystem not at all when refusing', async () => {
      vi.mocked(readdir).mockResolvedValue([
        { name: 'old.mp3', isFile: () => true, isDirectory: () => false },
      ] as never);
      const target = buildTargetPath('/audiobooks', '{author}/{title}', mockBook, 'Brandon Sanderson');
      const svc = arm([{ remotePath: FULL_REMOTE, localPath: '/audiobooks' }]);

      await expect(svc.importDownload(1)).rejects.toThrow(INSIDE_MESSAGE);

      // The marker preflight, the sibling derivation and the source stat all sit below the guard.
      expect(stat).not.toHaveBeenCalled();
      expect(mkdir).not.toHaveBeenCalled();
      expect(cp).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
      expect(writeFile).not.toHaveBeenCalled();
      // The two observation points `handleImportFailure` would actually hit.
      expect(rm).not.toHaveBeenCalledWith(join(target, 'old.mp3'), { force: true });
      expect(rmdir).not.toHaveBeenCalledWith(target);
      expect(rm).not.toHaveBeenCalled();
      expect(rmdir).not.toHaveBeenCalled();
    });

    // T21/AC11 — the refusal lands on the existing generic terminal, with the exact payloads.
    it('fails the download row and reverts the book to its pre-grab status', async () => {
      const svc = arm([{ remotePath: FULL_REMOTE, localPath: '/audiobooks' }]);

      await expect(svc.importDownload(1)).rejects.toThrow(INSIDE_MESSAGE);

      const setArgs = collectSetArgs(db);
      expect(setArgs).toContainEqual({
        clientStatus: 'failed',
        pipelineStage: 'idle',
        errorMessage: INSIDE_MESSAGE,
      });
      expect(setArgs).toContainEqual({ status: 'wanted', updatedAt: expect.any(Date) });
      // Absence matters as much: nothing was imported, so no path and no promotion may be written.
      expect(setArgs.some((s) => 'path' in s)).toBe(false);
      expect(setArgs.some((s) => s.status === 'imported')).toBe(false);
      expect(setArgs.some((s) => s.pipelineStage === 'imported')).toBe(false);
    });

    /**
     * T22/AC2 — the two arms of the ENOENT interaction with `validateSource`'s mapping guidance.
     * Both matter: the lexical layer must decide before any realpath, and an admissible-but-missing
     * source must still produce the operator copy it produces today.
     */
    describe('interaction with validateSource ENOENT guidance', () => {
      function armMissingOnDisk(): void {
        vi.mocked(stat).mockImplementation(async (p: unknown) =>
          String(p).endsWith('.import-commit-pending') ? markerEnoent() : Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));
        vi.mocked(realpath).mockImplementation(() =>
          Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));
      }

      it('answers the containment refusal for a source that is missing AND lexically inside the library', async () => {
        const svc = arm([{ remotePath: FULL_REMOTE, localPath: '/audiobooks' }]);
        armMissingOnDisk();

        await expect(svc.importDownload(1)).rejects.toThrow(INSIDE_MESSAGE);
      });

      it('still answers the mapping-configuration guidance for a missing but admissible source', async () => {
        const svc = arm([{ remotePath: '/downloads', localPath: '/mnt/complete' }]);
        armMissingOnDisk();

        await expect(svc.importDownload(1)).rejects.toThrow(/Check your remote path mapping configuration/);
      });

      it('still answers the add-a-mapping guidance when no mapping is configured', async () => {
        const svc = arm([]);
        armMissingOnDisk();

        await expect(svc.importDownload(1)).rejects.toThrow(/add a Remote Path Mapping/);
      });
    });

    /**
     * T23 — this suite fully mocks `node:fs/promises`, so a real symlink is unusable here; overriding
     * the identity `realpath` is the only way to pin that `runImportCommit` consults the RESOLVED
     * form. The real-link proof lives in `import-source-containment.test.ts`, the route suite and
     * `import-orchestration.helpers.test.ts`.
     */
    it('refuses a lexically-innocent save path whose realpath is the library root', async () => {
      const svc = arm([]);
      // Fold before comparing: the save path arrives platform-spelled (`join` backslashes it on
      // Windows), and an exact-string predicate silently never matches there.
      vi.mocked(realpath).mockImplementation(async (p: unknown) =>
        (String(p).split('\\').join('/') === FULL_REMOTE ? '/audiobooks' : String(p)));

      await expect(svc.importDownload(1)).rejects.toThrow(INSIDE_MESSAGE);
    });

    /**
     * T24/AC12 — exactly two error logs, neither folded into the other. The new one names the paths
     * (the refusal message carries none and 'Resolved save path' is debug-level); the pre-existing
     * terminal one closes the lifecycle unchanged.
     */
    it('emits the path-naming refusal log and the unchanged terminal log, and nothing else', async () => {
      const svc = arm([{ remotePath: FULL_REMOTE, localPath: '/audiobooks' }]);

      await expect(svc.importDownload(1)).rejects.toThrow(INSIDE_MESSAGE);

      // Exact values, not expect.any(String): a matcher that accepts any string cannot tell a
      // correct savePath from `undefined`, and reading the mis-mapping off this log is the point.
      // `originalPath` is the pre-mapping join output, so it is platform-spelled — fold the actual.
      const refusal = vi.mocked(serviceLog.error).mock.calls
        .find((c) => c[1] === 'Refusing automatic import — source path fails library containment');
      expect(refusal).toBeDefined();
      const fields = refusal![0] as Record<string, unknown>;
      expect({ ...fields, originalPath: String(fields.originalPath).split('\\').join('/') }).toMatchObject({
        downloadId: 1,
        bookId: 1,
        originalPath: FULL_REMOTE,
        savePath: '/audiobooks',
        libraryRoot: '/audiobooks',
        reason: 'source_inside_library',
      });
      expect(serviceLog.error).toHaveBeenCalledWith(
        expect.objectContaining({ elapsedMs: expect.any(Number) }),
        'Import failed',
      );
      expect(serviceLog.error).toHaveBeenCalledTimes(2);
    });
  });

  describe('import atomicity failures (#235 Tier 1)', () => {
    beforeEach(setupDefaults);

    it('preserves committed files when DB update throws after copy (#237, updated by #1257)', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));

      let updateCallCount = 0;
      db.update.mockImplementation(() => {
        updateCallCount++;
        const chain = mockDbChain();
        if (updateCallCount === 3) {
          // transitionDownloadState terminates at returning().
          (chain.returning as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB constraint violation'));
        }
        return chain;
      });

      await expect(service.importDownload(1)).rejects.toThrow('DB constraint violation');

      expect(cp).toHaveBeenCalled();

      // The committed target becomes protected before the DB transition (#1257).
      const rmMock = vi.mocked(rm);
      expect(rmMock).not.toHaveBeenCalledWith(
        '/audiobooks/Brandon Sanderson/The Way of Kings',
        { recursive: true, force: true },
      );

      const updateCalls = db.update.mock.results;
      const setCalls = updateCalls
        .map((r: { value: unknown }) => ((r.value as { set: ReturnType<typeof vi.fn> }).set))
        .filter(Boolean);
      const allSetArgs = setCalls.flatMap((s: ReturnType<typeof vi.fn>) => s.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>));
      expect(allSetArgs).toContainEqual(expect.objectContaining({ clientStatus: 'failed' }));
    });

    it('logs warn (not error) when re-import rm() fails on old path', async () => {
      const importedBook = createMockDbBook({
        status: 'downloading' as const,
        path: '/audiobooks/Old Author/Old Book',
      });
      mockBookService.getById.mockResolvedValueOnce(withAuthor(importedBook));

      const log = createMockLogger();
      const svc = new ImportService(inject<Db>(db), clientService, settingsService, inject<FastifyBaseLogger>(log), undefined, mockBookService as never);

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      // Reject only old-path per-file deletes; sibling cleanup succeeds and failure stays a warning (#1589).
      const rmMock = vi.mocked(rm);
      rmMock.mockImplementation((p: unknown, opts: unknown) =>
        (String(p).includes('Old Book') && !(opts as { recursive?: boolean })?.recursive)
          ? Promise.reject(new Error('EACCES: permission denied'))
          : Promise.resolve(undefined));

      const result = await svc.importDownload(1);

      expect(result.downloadId).toBe(1);

      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ file: expect.stringContaining('Old Book') }),
        expect.stringContaining('Failed to delete managed book file'),
      );
      expect(log.error).not.toHaveBeenCalledWith(
        expect.objectContaining({ oldPath: '/audiobooks/Old Author/Old Book' }),
        expect.any(String),
      );
    });

    it('import succeeds when enrichBookFromAudio throws (#554 — enrichment isolated)', async () => {
      const log = createMockLogger();
      const svc = new ImportService(inject<Db>(db), clientService, settingsService, inject<FastifyBaseLogger>(log), undefined, mockBookService as never);

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      const enrichMock = vi.mocked(enrichBookFromAudioWithinAdmissionLock);
      enrichMock.mockRejectedValueOnce(new Error('Enrichment exploded'));

      const result = await svc.importDownload(1);

      expect(result.downloadId).toBe(1);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: 'Enrichment exploded', type: 'Error' }) }),
        expect.stringContaining('enrichment threw'),
      );
      expect(log.error).not.toHaveBeenCalled();
    });
  });

  describe('audio-only copy filtering', () => {
    beforeEach(setupDefaults);

    it('directory import only copies audio files, skips .nzb/.sfv/.nfo', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      const readdirMock = vi.mocked(readdir);
      readdirMock.mockResolvedValue([
        { name: 'chapter1.mp3', isFile: () => true, isDirectory: () => false },
        { name: 'chapter2.m4b', isFile: () => true, isDirectory: () => false },
        { name: 'release.nzb', isFile: () => true, isDirectory: () => false },
        { name: 'checksum.sfv', isFile: () => true, isDirectory: () => false },
        { name: 'info.nfo', isFile: () => true, isDirectory: () => false },
        { name: 'cover.jpg', isFile: () => true, isDirectory: () => false },
      ] as never);

      await service.importDownload(1);

      const cpMock = vi.mocked(cp);
      const copiedFiles = cpMock.mock.calls.map(call => call[0] as string);

      expect(copiedFiles.some(p => p.endsWith('chapter1.mp3'))).toBe(true);
      expect(copiedFiles.some(p => p.endsWith('chapter2.m4b'))).toBe(true);
      expect(copiedFiles.some(p => p.endsWith('.nzb'))).toBe(false);
      expect(copiedFiles.some(p => p.endsWith('.sfv'))).toBe(false);
      expect(copiedFiles.some(p => p.endsWith('.nfo'))).toBe(false);
      expect(copiedFiles.some(p => p.endsWith('.jpg'))).toBe(false);
    });

    it('single non-audio file import throws', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      const statMock = vi.mocked(stat);
      statMock.mockResolvedValue({ isFile: () => true, isDirectory: () => false, size: 1024 } as never);

      mockAdapter.getDownload.mockResolvedValueOnce({
        id: 'ext-1',
        name: 'release.nzb',
        progress: 100,
        status: 'completed',
        savePath: '/downloads',
        size: 1024,
        downloaded: 1024,
        uploaded: 0,
        ratio: 0,
        seeders: 0,
        leechers: 0,
        addedAt: now,
        completedAt: now,
      });

      await expect(service.importDownload(1)).rejects.toThrow('not a supported audio format');
    });
  });



  describe('disk space check', () => {
    beforeEach(setupDefaults);

    function setupDiskCheckMocks(overrides?: { minFreeSpaceGB?: number }) {
      return createMockSettingsService({
        import: { minSeedTime: 0, minFreeSpaceGB: overrides?.minFreeSpaceGB ?? 5 },
        processing: {
          },
      });
    }

    function setupImportMocks() {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());
    }

    it('import proceeds when free space >= threshold + estimated output size', async () => {
      const customSettings = setupDiskCheckMocks({ minFreeSpaceGB: 5 });
      const svc = new ImportService(inject<Db>(db), clientService, customSettings, inject<FastifyBaseLogger>(log), undefined, mockBookService as never);
      setupImportMocks();

      // 100 GB free exceeds the 5 GB threshold plus 500 MB source.
      vi.mocked(statfs).mockResolvedValueOnce({ bavail: BigInt(100_000_000_000), bsize: BigInt(1) } as never);

      const result = await svc.importDownload(1);
      expect(result.downloadId).toBe(1);
    });

    it('import aborts when free space < threshold + estimated output size', async () => {
      const customSettings = setupDiskCheckMocks({ minFreeSpaceGB: 5 });
      const svc = new ImportService(inject<Db>(db), clientService, customSettings, inject<FastifyBaseLogger>(log), undefined, mockBookService as never);
      setupImportMocks();

      vi.mocked(statfs).mockResolvedValueOnce({ bavail: BigInt(1_000_000_000), bsize: BigInt(1) } as never);

      await expect(svc.importDownload(1)).rejects.toThrow('insufficient disk space');
    });

    it('free space at exactly threshold + estimated size proceeds (>= boundary)', async () => {
      const customSettings = setupDiskCheckMocks({ minFreeSpaceGB: 5 });
      const svc = new ImportService(inject<Db>(db), clientService, customSettings, inject<FastifyBaseLogger>(log), undefined, mockBookService as never);
      setupImportMocks();

      const exactlyEnough = BigInt(5) * BigInt(1024 ** 3) + BigInt(500_000_000);
      vi.mocked(statfs).mockResolvedValueOnce({ bavail: exactlyEnough, bsize: BigInt(1) } as never);

      const result = await svc.importDownload(1);
      expect(result.downloadId).toBe(1);
    });

    it('estimated output uses sourceSize * 1 (no processing multiplier)', async () => {
      // Zero skips the check, so use a 1 GB threshold.
      const customSettings = setupDiskCheckMocks({ minFreeSpaceGB: 1 });
      const svc = new ImportService(inject<Db>(db), clientService, customSettings, inject<FastifyBaseLogger>(log), undefined, mockBookService as never);
      setupImportMocks();

      // Free 2 GB exceeds the required 1 GB + 500 MB only with multiplier 1.
      vi.mocked(statfs).mockResolvedValueOnce({ bavail: BigInt(2_000_000_000), bsize: BigInt(1) } as never);

      const result = await svc.importDownload(1);
      expect(result.downloadId).toBe(1);
    });

    it('statfs failure aborts import with clear error', async () => {
      const customSettings = setupDiskCheckMocks({ minFreeSpaceGB: 5 });
      const svc = new ImportService(inject<Db>(db), clientService, customSettings, inject<FastifyBaseLogger>(log), undefined, mockBookService as never);
      setupImportMocks();

      vi.mocked(statfs).mockReset();
      vi.mocked(statfs).mockRejectedValueOnce(new Error('ENOENT: no such file'));

      await expect(svc.importDownload(1)).rejects.toThrow('Disk space check failed');
    });

    it('disk space check skipped when minFreeSpaceGB=0', async () => {
      const customSettings = setupDiskCheckMocks({ minFreeSpaceGB: 0 });
      const svc = new ImportService(inject<Db>(db), clientService, customSettings, inject<FastifyBaseLogger>(log), undefined, mockBookService as never);
      setupImportMocks();

      const result = await svc.importDownload(1);
      expect(result.downloadId).toBe(1);
      expect(statfs).not.toHaveBeenCalled();
    });

    it('download set to failed with descriptive errorMessage on disk-space abort', async () => {
      const customSettings = setupDiskCheckMocks({ minFreeSpaceGB: 5 });
      const svc = new ImportService(inject<Db>(db), clientService, customSettings, inject<FastifyBaseLogger>(log), undefined, mockBookService as never);
      setupImportMocks();

      vi.mocked(statfs).mockResolvedValueOnce({ bavail: BigInt(1_000_000_000), bsize: BigInt(1) } as never);

      await expect(svc.importDownload(1)).rejects.toThrow();

      const updateSetCalls = db.update.mock.results
        .map((r: { value: unknown }) => ((r.value as { set: ReturnType<typeof vi.fn> }).set))
        .flatMap((s: ReturnType<typeof vi.fn>) => s.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>));

      expect(updateSetCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            clientStatus: 'failed',
            pipelineStage: 'idle',
            errorMessage: expect.stringContaining('insufficient disk space'),
          }),
        ]),
      );
    });

    it('book status reverted per existing recovery logic on disk-space abort', async () => {
      const customSettings = setupDiskCheckMocks({ minFreeSpaceGB: 5 });
      const svc = new ImportService(inject<Db>(db), clientService, customSettings, inject<FastifyBaseLogger>(log), undefined, mockBookService as never);
      setupImportMocks();

      vi.mocked(statfs).mockResolvedValueOnce({ bavail: BigInt(1_000_000_000), bsize: BigInt(1) } as never);

      await expect(svc.importDownload(1)).rejects.toThrow();

      const updateSetCalls = db.update.mock.results
        .map((r: { value: unknown }) => ((r.value as { set: ReturnType<typeof vi.fn> }).set))
        .flatMap((s: ReturnType<typeof vi.fn>) => s.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>));

      expect(updateSetCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: 'wanted' }),
        ]),
      );
    });

  });


  describe('getImportContext', () => {
    beforeEach(setupDefaults);

    it('returns download and book context for side effect dispatch', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));

      const ctx = await service.getImportContext(1);

      expect(ctx.downloadId).toBe(1);
      expect(ctx.downloadTitle).toBe('The Way of Kings');
      expect(ctx.bookId).toBe(1);
      expect(ctx.bookTitle).toBe('The Way of Kings');
      expect(ctx.authorName).toBe('Brandon Sanderson');
    });

    it('throws when download not found', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));
      await expect(service.getImportContext(999)).rejects.toThrow('not found');
    });

    it('throws when download has no linked book', async () => {
      db.select.mockReturnValueOnce(mockDbChain([{ ...mockDownload, bookId: null }]));
      await expect(service.getImportContext(1)).rejects.toThrow('no linked book');
    });

    it('returns infoHash from the download record', async () => {
      db.select.mockReturnValueOnce(mockDbChain([{ ...mockDownload, infoHash: 'hash-abc' }]));
      const ctx = await service.getImportContext(1);
      expect(ctx.infoHash).toBe('hash-abc');
    });

    it('returns guid from the download record', async () => {
      db.select.mockReturnValueOnce(mockDbChain([{ ...mockDownload, guid: 'guid-xyz' }]));
      const ctx = await service.getImportContext(1);
      expect(ctx.guid).toBe('guid-xyz');
    });

    it('returns null for infoHash when download has no infoHash (usenet)', async () => {
      db.select.mockReturnValueOnce(mockDbChain([{ ...mockDownload, infoHash: null, guid: 'usenet-guid' }]));
      const ctx = await service.getImportContext(1);
      expect(ctx.infoHash).toBeNull();
    });

    it('returns null for guid when download has no guid (torrent)', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      const ctx = await service.getImportContext(1);
      expect(ctx.guid).toBeNull();
    });
  });

  describe('lastGrab identifier tracking', () => {
    beforeEach(() => {
      setupDefaults();
      vi.mocked(statfs).mockResolvedValue({ bavail: BigInt(100_000_000_000), bsize: BigInt(1) } as never);
    });

    it('populates lastGrabGuid and lastGrabInfoHash from download on import', async () => {
      const downloadWithGuid = { ...mockDownload, guid: 'guid-abc', infoHash: 'hash-123' };
      db.select.mockReturnValueOnce(mockDbChain([downloadWithGuid]));
      const chain = mockDbChain();
      db.update.mockReturnValue(chain);

      await service.importDownload(1);

      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      const bookUpdate = setCalls.find((c) => c.status === 'imported' && 'lastGrabGuid' in c);
      expect(bookUpdate).toBeDefined();
      expect(bookUpdate!.lastGrabGuid).toBe('guid-abc');
      expect(bookUpdate!.lastGrabInfoHash).toBe('hash-123');
    });

    it('sets lastGrabGuid to null when download.guid is null', async () => {
      const downloadNoGuid = { ...mockDownload, guid: null, infoHash: 'hash-123' };
      db.select.mockReturnValueOnce(mockDbChain([downloadNoGuid]));
      const chain = mockDbChain();
      db.update.mockReturnValue(chain);

      await service.importDownload(1);

      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      const bookUpdate = setCalls.find((c) => c.status === 'imported' && 'lastGrabGuid' in c);
      expect(bookUpdate).toBeDefined();
      expect(bookUpdate!.lastGrabGuid).toBeNull();
      expect(bookUpdate!.lastGrabInfoHash).toBe('hash-123');
    });

    it('sets lastGrabInfoHash to null when download.infoHash is null', async () => {
      const downloadNoHash = { ...mockDownload, guid: 'guid-abc', infoHash: null };
      db.select.mockReturnValueOnce(mockDbChain([downloadNoHash]));
      const chain = mockDbChain();
      db.update.mockReturnValue(chain);

      await service.importDownload(1);

      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      const bookUpdate = setCalls.find((c) => c.status === 'imported' && 'lastGrabGuid' in c);
      expect(bookUpdate).toBeDefined();
      expect(bookUpdate!.lastGrabGuid).toBe('guid-abc');
      expect(bookUpdate!.lastGrabInfoHash).toBeNull();
    });
  });
});

describe('ImportService consolidation (issue #79)', () => {
  let db: ReturnType<typeof createMockDb>;
  let log: ReturnType<typeof createMockLogger>;
  let clientService: ReturnType<typeof createMockDownloadClientService>;
  let settingsService: ReturnType<typeof createMockSettingsService>;

  function makeBookWithNarrators(narrators: string[]) {
    return {
      ...createMockDbBook({ id: 1 }),
      authors: [createMockDbAuthor()],
      narrators: narrators.map((name, i) => ({ id: i + 1, name, slug: name.toLowerCase().replace(/\s+/g, '-'), createdAt: now, updatedAt: now })),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    log = createMockLogger();
    clientService = createMockDownloadClientService();
    settingsService = createMockSettingsService();
  });

  // The ", "-join narrator pin moved to src/server/utils/tag-projection.test.ts with #2480: the
  // context no longer carries a narrator projection, and the tag write reads the row directly.
  it('getImportContext() returns authorName from junction position-0 author', async () => {
    const bookSvc = { getById: vi.fn().mockResolvedValue(makeBookWithNarrators(['Kate Reading', 'Michael Kramer'])) };
    const svc = new ImportService(inject<Db>(db), clientService, settingsService, inject<FastifyBaseLogger>(log), undefined, bookSvc as never);

    db.select.mockReturnValueOnce(mockDbChain([mockDownload]));

    const ctx = await svc.getImportContext(1);
    expect(ctx.authorName).toBe('Brandon Sanderson');
    expect(ctx.book.narrators.map(n => n.name)).toEqual(['Kate Reading', 'Michael Kramer']);
  });

  describe('logging improvements (#229)', () => {
    let service: ImportService;
    let mockBookService: { getById: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };

    function withAuthor(book: Record<string, unknown>) {
      return {
        ...book,
        authors: [createMockDbAuthor()],
        narrators: [],
      };
    }

    beforeEach(() => {
      vi.clearAllMocks();
      db = createMockDb();
      log = createMockLogger();
      clientService = createMockDownloadClientService();
      settingsService = createMockSettingsService();
      mockBookService = { getById: vi.fn().mockResolvedValue(withAuthor(mockBook)), update: vi.fn().mockResolvedValue(undefined) };
      service = new ImportService(inject<Db>(db), clientService, settingsService, inject<FastifyBaseLogger>(log), undefined, mockBookService as never);

      vi.mocked(stat).mockImplementation(statDirMarkerAbsent);
      vi.mocked(readdir).mockResolvedValue([
        { name: 'chapter1.mp3', isFile: () => true, isDirectory: () => false },
      ] as never);
      vi.mocked(statfs).mockResolvedValue({ bavail: BigInt(100_000_000_000), bsize: BigInt(1) } as never);
    });

    it('resolveSavePath result logged at debug with { downloadId, resolvedPath, originalPath }', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ downloadId: 1, resolvedPath: expect.any(String), originalPath: expect.any(String) }),
        'Resolved save path',
      );
    });

    it('import pipeline success log includes elapsedMs field', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ elapsedMs: expect.any(Number) }),
        'Import completed successfully',
      );
    });

    it('import pipeline failure log includes elapsedMs field', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());
      vi.mocked(stat).mockRejectedValueOnce(new Error('ENOENT'));

      await expect(service.importDownload(1)).rejects.toThrow();

      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ elapsedMs: expect.any(Number) }),
        'Import failed',
      );
    });

    it('intermediate logs include bookTitle between start and completion', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ bookTitle: 'The Way of Kings' }),
        'Built target path',
      );
    });

    it('verifyCopy success logged at debug by ImportService with { sourceSize, targetSize }', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ sourceSize: expect.any(Number), targetSize: expect.any(Number) }),
        'Copy verified',
      );
    });

    it('buildTargetPath result logged at debug by ImportService', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ targetPath: expect.any(String) }),
        'Built target path',
      );
    });

    it('validateSource success logged at debug with { fileCount, sourceSize }', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ fileCount: expect.any(Number), sourceSize: expect.any(Number) }),
        'Validated source',
      );
    });

    it('checkDiskSpace success logged at debug with { freeGB, requiredGB }', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ freeGB: expect.any(Number), requiredGB: expect.any(Number) }),
        'Disk space check passed',
      );
    });

    it('torrent removal log includes { externalId, clientType, deleteFiles }', async () => {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: true, minSeedTime: 0, minSeedRatio: 0 });
        return Promise.resolve({});
      });

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ externalId: 'ext-1', clientType: 'qbittorrent', deleteFiles: true }),
        'Torrent removed from client after import',
      );
    });
  });

  describe('seed ratio gating (handleTorrentRemoval)', () => {
    let service: ImportService;
    let mockBookService: { getById: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      vi.clearAllMocks();
      db = createMockDb();
      log = createMockLogger();
      clientService = createMockDownloadClientService();
      settingsService = createMockSettingsService();
      mockBookService = { getById: vi.fn().mockResolvedValue({ ...createMockDbBook({ status: 'downloading' as const }), authors: [createMockDbAuthor()], narrators: [] }), update: vi.fn().mockResolvedValue(undefined) };
      service = new ImportService(inject<Db>(db), clientService, settingsService, inject<FastifyBaseLogger>(log), undefined, mockBookService as never);
      vi.mocked(stat).mockImplementation(statDirMarkerAbsent);
      vi.mocked(readdir).mockResolvedValue([
        { name: 'chapter1.mp3', isFile: () => true, isDirectory: () => false },
      ] as never);
      vi.mocked(statfs).mockResolvedValue({ bavail: BigInt(100_000_000_000), bsize: BigInt(1) } as never);
    });

    it('skips torrent removal when ratio below configured minSeedRatio', async () => {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: true, minSeedTime: 0, minSeedRatio: 1.0 });
        return Promise.resolve({});
      });
      // resolveSavePath reads first; the ratio gate reads second.
      mockAdapter.getDownload
        .mockResolvedValueOnce(defaultDownloadItem)
        .mockResolvedValueOnce({ ...defaultDownloadItem, ratio: 0.5 });

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      expect(mockAdapter.removeDownload).not.toHaveBeenCalled();
    });

    it('removes torrent when ratio at threshold (strictly-less-than: at boundary = remove)', async () => {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: true, minSeedTime: 0, minSeedRatio: 1.0 });
        return Promise.resolve({});
      });
      mockAdapter.getDownload
        .mockResolvedValueOnce(defaultDownloadItem)
        .mockResolvedValueOnce({ ...defaultDownloadItem, ratio: 1.0 });

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      expect(mockAdapter.removeDownload).toHaveBeenCalledWith('ext-1', true);
      // Successful removal must not null outputPath (#1293).
      const setCalls = (db.update().set as ReturnType<typeof vi.fn>).mock.calls;
      const outputPathClear = setCalls.find((call: unknown[]) => call[0] && typeof call[0] === 'object' && 'outputPath' in (call[0] as Record<string, unknown>));
      expect(outputPathClear).toBeUndefined();
    });

    it('skips removal when minSeedTime met but minSeedRatio not met', async () => {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: true, minSeedTime: 30, minSeedRatio: 1.0 }); // 30 min; completed 1 h ago
        return Promise.resolve({});
      });
      mockAdapter.getDownload
        .mockResolvedValueOnce(defaultDownloadItem)
        .mockResolvedValueOnce({ ...defaultDownloadItem, ratio: 0.3 });

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      expect(mockAdapter.removeDownload).not.toHaveBeenCalled();
    });

    it('removes torrent when both minSeedTime and minSeedRatio met', async () => {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: true, minSeedTime: 30, minSeedRatio: 1.0 });
        return Promise.resolve({});
      });
      mockAdapter.getDownload
        .mockResolvedValueOnce(defaultDownloadItem)
        .mockResolvedValueOnce({ ...defaultDownloadItem, ratio: 1.5 });

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      expect(mockAdapter.removeDownload).toHaveBeenCalledWith('ext-1', true);
    });

    it('sets pendingCleanup when removal skipped due to ratio', async () => {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: true, minSeedTime: 0, minSeedRatio: 1.0 });
        return Promise.resolve({});
      });
      mockAdapter.getDownload
        .mockResolvedValueOnce(defaultDownloadItem)
        .mockResolvedValueOnce({ ...defaultDownloadItem, ratio: 0.5 });

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      const setCalls = (db.update().set as ReturnType<typeof vi.fn>).mock.calls;
      const pendingCall = setCalls.find((call: unknown[]) => call[0] && typeof call[0] === 'object' && 'pendingCleanup' in (call[0] as Record<string, unknown>));
      expect(pendingCall).toBeDefined();
      expect((pendingCall![0] as Record<string, unknown>).pendingCleanup).toBeInstanceOf(Date);
    });

    it('logs message when removal skipped due to ratio', async () => {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: true, minSeedTime: 0, minSeedRatio: 1.0 });
        return Promise.resolve({});
      });
      mockAdapter.getDownload
        .mockResolvedValueOnce(defaultDownloadItem)
        .mockResolvedValueOnce({ ...defaultDownloadItem, ratio: 0.5 });

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ downloadId: 1 }),
        expect.stringContaining('seed'),
      );
    });

    it('handles getDownload returning null gracefully', async () => {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: true, minSeedTime: 0, minSeedRatio: 1.0 });
        return Promise.resolve({});
      });
      // resolveSavePath reads first; the ratio gate receives null.
      mockAdapter.getDownload
        .mockResolvedValueOnce(defaultDownloadItem)
        .mockResolvedValueOnce(null);

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      const result = await service.importDownload(1);
      expect(result.downloadId).toBe(1);
      expect(mockAdapter.removeDownload).not.toHaveBeenCalled();
      // Unavailable torrent ratio defers without clearing outputPath (#1293).
      const setCalls = (db.update().set as ReturnType<typeof vi.fn>).mock.calls;
      const pendingCall = setCalls.find((call: unknown[]) => call[0] && typeof call[0] === 'object' && 'pendingCleanup' in (call[0] as Record<string, unknown>));
      expect(pendingCall).toBeDefined();
      expect((pendingCall![0] as Record<string, unknown>).pendingCleanup).toBeInstanceOf(Date);
      expect('outputPath' in (pendingCall![0] as Record<string, unknown>)).toBe(false);
    });

    // Unavailable ratio defers torrents only; seed ratio is meaningless for Usenet (#1298).
    it('proceeds with usenet removal when ratio unfetchable (does not defer)', async () => {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: true, minSeedTime: 0, minSeedRatio: 1.0 });
        return Promise.resolve({});
      });
      // resolveSavePath reads first; the ratio gate receives null.
      mockAdapter.getDownload
        .mockResolvedValueOnce(defaultDownloadItem)
        .mockResolvedValueOnce(null);

      db.select.mockReturnValueOnce(mockDbChain([{ ...mockDownload, protocol: 'usenet' }]));
      db.update.mockReturnValue(mockDbChain());

      const result = await service.importDownload(1);
      expect(result.downloadId).toBe(1);
      expect(mockAdapter.removeDownload).toHaveBeenCalledWith('ext-1', true);
      const setCalls = (db.update().set as ReturnType<typeof vi.fn>).mock.calls;
      const pendingCall = setCalls.find((call: unknown[]) => call[0] && typeof call[0] === 'object' && 'pendingCleanup' in (call[0] as Record<string, unknown>));
      expect(pendingCall).toBeUndefined();
    });

    it('proceeds with usenet removal when live ratio available (sanity)', async () => {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: true, minSeedTime: 0, minSeedRatio: 1.0 });
        return Promise.resolve({});
      });
      mockAdapter.getDownload
        .mockResolvedValueOnce(defaultDownloadItem)
        .mockResolvedValueOnce({ ...defaultDownloadItem, ratio: 0.5 });

      db.select.mockReturnValueOnce(mockDbChain([{ ...mockDownload, protocol: 'usenet' }]));
      db.update.mockReturnValue(mockDbChain());

      const result = await service.importDownload(1);
      expect(result.downloadId).toBe(1);
      expect(mockAdapter.removeDownload).toHaveBeenCalledWith('ext-1', true);
    });

    it('handles getDownload throwing — error logged, import succeeds', async () => {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: true, minSeedTime: 0, minSeedRatio: 1.0 });
        return Promise.resolve({});
      });
      // resolveSavePath reads first; the ratio gate throws second.
      mockAdapter.getDownload
        .mockResolvedValueOnce(defaultDownloadItem)
        .mockRejectedValueOnce(new Error('Connection refused'));

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.update.mockReturnValue(mockDbChain());

      const result = await service.importDownload(1);
      expect(result.downloadId).toBe(1);
      expect(log.error).toHaveBeenCalled();
    });
  });

  describe('cleanupDeferredImports', () => {
    let service: ImportService;
    const deferredImport = { ...mockDownload, id: 10, status: 'imported' as const, pendingCleanup: new Date() };

    beforeEach(() => {
      vi.clearAllMocks();
      db = createMockDb();
      log = createMockLogger();
      clientService = createMockDownloadClientService();
      settingsService = createMockSettingsService();
      service = new ImportService(inject<Db>(db), clientService, settingsService, inject<FastifyBaseLogger>(log));
    });

    it('removes torrent from client when seed time + ratio now met, clears pendingCleanup', async () => {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'import') return Promise.resolve({ deleteAfterImport: true, minSeedTime: 30, minSeedRatio: 1.0 });
        return Promise.resolve({});
      });
      mockAdapter.getDownload.mockResolvedValueOnce({ ratio: 1.5 });
      db.select.mockReturnValueOnce(mockDbChain([deferredImport]));
      db.update.mockReturnValue(mockDbChain());

      await service.cleanupDeferredImports();

      expect(mockAdapter.removeDownload).toHaveBeenCalledWith('ext-1', true);
      const setCalls = (db.update().set as ReturnType<typeof vi.fn>).mock.calls;
      const clearCall = setCalls.find((call: unknown[]) => call[0] && typeof call[0] === 'object' && (call[0] as Record<string, unknown>).pendingCleanup === null);
      expect(clearCall).toBeDefined();
      // Deferred cleanup clears pendingCleanup without nulling outputPath (#1293).
      expect('outputPath' in (clearCall![0] as Record<string, unknown>)).toBe(false);
    });

    it('skips removal when ratio still below threshold, pendingCleanup left for next cycle', async () => {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'import') return Promise.resolve({ deleteAfterImport: true, minSeedTime: 0, minSeedRatio: 1.0 });
        return Promise.resolve({});
      });
      mockAdapter.getDownload.mockResolvedValueOnce({ ratio: 0.3 });
      db.select.mockReturnValueOnce(mockDbChain([deferredImport]));
      db.update.mockReturnValue(mockDbChain());

      await service.cleanupDeferredImports();

      expect(mockAdapter.removeDownload).not.toHaveBeenCalled();
    });

    it('logs and preserves pendingCleanup on adapter error (retry next cycle)', async () => {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'import') return Promise.resolve({ deleteAfterImport: true, minSeedTime: 0, minSeedRatio: 1.0 });
        return Promise.resolve({});
      });
      mockAdapter.getDownload.mockResolvedValueOnce({ ratio: 1.5 });
      mockAdapter.removeDownload.mockRejectedValueOnce(new Error('Connection refused'));
      db.select.mockReturnValueOnce(mockDbChain([deferredImport]));
      db.update.mockReturnValue(mockDbChain());

      await service.cleanupDeferredImports();

      expect(log.error).toHaveBeenCalled();
      const setCalls = (db.update().set as ReturnType<typeof vi.fn>).mock.calls;
      const clearCall = setCalls.find((call: unknown[]) => call[0] && typeof call[0] === 'object' && (call[0] as Record<string, unknown>).pendingCleanup === null);
      expect(clearCall).toBeUndefined();
    });

    it('adapter not found → logs warning, preserves pendingCleanup for retry', async () => {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'import') return Promise.resolve({ deleteAfterImport: true, minSeedTime: 0, minSeedRatio: 0 });
        return Promise.resolve({});
      });
      (clientService.getAdapter as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
      db.select.mockReturnValueOnce(mockDbChain([deferredImport]));
      db.update.mockReturnValue(mockDbChain());

      await service.cleanupDeferredImports();

      expect(mockAdapter.removeDownload).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ downloadId: deferredImport.id }),
        expect.stringContaining('adapter not found'),
      );
      const setCalls = (db.update().set as ReturnType<typeof vi.fn>).mock.calls;
      const clearCall = setCalls.find((call: unknown[]) => call[0] && typeof call[0] === 'object' && (call[0] as Record<string, unknown>).pendingCleanup === null);
      expect(clearCall).toBeUndefined();
    });

    it('no-op when no imported downloads have pendingCleanup set', async () => {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'import') return Promise.resolve({ deleteAfterImport: true, minSeedTime: 0, minSeedRatio: 0 });
        return Promise.resolve({});
      });
      db.select.mockReturnValueOnce(mockDbChain([]));

      await service.cleanupDeferredImports();

      expect(mockAdapter.removeDownload).not.toHaveBeenCalled();
    });
  });

  describe('import transaction (#554)', () => {
    let service: ImportService;
    let mockBookSvc: { getById: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };

    function withAuthor554(book: Record<string, unknown>) {
      return { ...book, authors: [createMockDbAuthor()], narrators: [] };
    }

    beforeEach(() => {
      vi.clearAllMocks();
      db = createMockDb();
      log = createMockLogger();
      clientService = createMockDownloadClientService();
      settingsService = createMockSettingsService();
      mockBookSvc = { getById: vi.fn().mockResolvedValue(withAuthor554(createMockDbBook({ status: 'downloading' as const }))), update: vi.fn().mockResolvedValue(undefined) };
      service = new ImportService(inject<Db>(db), clientService, settingsService, inject<FastifyBaseLogger>(log), undefined, mockBookSvc as never);
      vi.mocked(stat).mockImplementation(statDirMarkerAbsent);
      vi.mocked(readdir).mockResolvedValue([{ name: 'ch1.mp3', isFile: () => true, isDirectory: () => false }] as never);
    });

    describe('happy path', () => {
      it('wraps direct DB mutations in db.transaction()', async () => {
        db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
        db.update.mockReturnValue(mockDbChain());

        await service.importDownload(1);

        expect(db.transaction).toHaveBeenCalledTimes(1);
        expect(db.transaction).toHaveBeenCalledWith(expect.any(Function));
      });

      it('enrichment runs after transaction commit', async () => {
        db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
        db.update.mockReturnValue(mockDbChain());

        const callOrder: string[] = [];
        db.transaction.mockImplementation(async (cb: (tx: typeof db) => Promise<unknown>) => {
          const result = await cb(db);
          callOrder.push('transaction-done');
          return result;
        });
        vi.mocked(enrichBookFromAudioWithinAdmissionLock).mockImplementation(async () => {
          callOrder.push('enrich');
          return { enriched: true };
        });

        await service.importDownload(1);

        expect(callOrder.indexOf('transaction-done')).toBeLessThan(callOrder.indexOf('enrich'));
      });
    });

    describe('partial failure / rollback', () => {
      it('book update failure inside transaction triggers handleImportFailure', async () => {
        db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
        let updateCallCount = 0;
        db.update.mockImplementation(() => {
          updateCallCount++;
          if (updateCallCount === 2) {
            return mockDbChain([], { error: new Error('DB write failed') });
          }
          return mockDbChain();
        });

        await expect(service.importDownload(1)).rejects.toThrow();
        expect(rm).toHaveBeenCalled();
      });
    });

    describe('enrichment isolation', () => {
      it('enrichment returning { enriched: false } → warning logged, import stays successful', async () => {
        db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
        db.update.mockReturnValue(mockDbChain());
        vi.mocked(enrichBookFromAudioWithinAdmissionLock).mockResolvedValueOnce({ enriched: false, error: 'scan failed' });

        const result = await service.importDownload(1);

        expect(result.downloadId).toBe(1);
        expect(log.warn).toHaveBeenCalledWith(
          expect.objectContaining({ error: 'scan failed' }),
          expect.stringContaining('enrichment'),
        );
      });

      it('enrichment throwing unexpectedly → caught, import still succeeds', async () => {
        db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
        db.update.mockReturnValue(mockDbChain());
        vi.mocked(enrichBookFromAudioWithinAdmissionLock).mockRejectedValueOnce(new Error('unexpected crash'));

        const result = await service.importDownload(1);

        expect(result.downloadId).toBe(1);
        expect(log.warn).toHaveBeenCalledWith(
          expect.objectContaining({ error: expect.objectContaining({ message: 'unexpected crash', type: 'Error' }) }),
          expect.stringContaining('enrichment threw'),
        );
        // Recursive sibling cleanup is expected; failure cleanup must not remove the committed target.
        expect(rm).not.toHaveBeenCalledWith('/audiobooks/Brandon Sanderson/The Way of Kings', expect.objectContaining({ recursive: true }));
      });
    });

    describe('filesystem isolation', () => {
      it('filesystem ops execute before the transaction', async () => {
        db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
        db.update.mockReturnValue(mockDbChain());

        const callOrder: string[] = [];
        vi.mocked(cp).mockImplementation(async () => { callOrder.push('cp'); });
        db.transaction.mockImplementation(async (cb: (tx: typeof db) => Promise<unknown>) => {
          callOrder.push('transaction');
          return cb(db);
        });

        await service.importDownload(1);

        const cpIndex = callOrder.indexOf('cp');
        const txIndex = callOrder.indexOf('transaction');
        expect(cpIndex).toBeLessThan(txIndex);
      });
    });
  });
});

/**
 * mockDbChain cannot evaluate SQL. A migrated DB proves shared eligibility rejects a
 * pre-existing external_id = '' without a data migration (#1861).
 */
const PROD_DRIZZLE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'drizzle');

describe('ImportService.getEligibleDownloads — externalId truthiness alignment (#1861 AC3)', () => {
  async function migratedDb() {
    const client = createClient({ url: ':memory:' });
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: PROD_DRIZZLE });
    return db as unknown as Db;
  }

  function svc(db: Db) {
    return new ImportService(db, {} as never, {} as never, inject<FastifyBaseLogger>(createMockLogger()), undefined, undefined);
  }

  async function seedBook(db: Db): Promise<number> {
    const [row] = await db.insert(books).values({ publicId: 'bk_seam0000000000000', title: 'Seam Book', status: 'wanted' }).returning({ id: books.id });
    return row!.id;
  }

  it('excludes completed rows with externalId null OR pre-existing empty string, and includes a tracked real-id row', async () => {
    const db = await migratedDb();
    const bookId = await seedBook(db);
    const completed = { clientStatus: 'completed' as const, pipelineStage: 'idle' as const, progress: 1, completedAt: new Date(), bookId };
    const [nullRow] = await db.insert(downloads).values({ publicId: 'dl_null', title: 'Null id', externalId: null, ...completed }).returning({ id: downloads.id });
    const [emptyRow] = await db.insert(downloads).values({ publicId: 'dl_empty', title: 'Empty id (pre-existing)', externalId: '', ...completed }).returning({ id: downloads.id });
    const [realRow] = await db.insert(downloads).values({ publicId: 'dl_real', title: 'Tracked', externalId: 'ext-1', ...completed }).returning({ id: downloads.id });

    const eligible = await svc(db).getEligibleDownloads();
    const ids = eligible.map((e) => e.id);

    expect(ids).toEqual([realRow!.id]);
    expect(ids).not.toContain(nullRow!.id);
    expect(ids).not.toContain(emptyRow!.id);
  });

  it('excludes an eligible-looking row missing completedAt or bookId (import-specific guards retained)', async () => {
    const db = await migratedDb();
    const bookId = await seedBook(db);
    await db.insert(downloads).values({ publicId: 'dl_nocompleted', title: 'No completedAt', externalId: 'ext-2', clientStatus: 'completed', pipelineStage: 'idle', progress: 1, bookId, completedAt: null });
    await db.insert(downloads).values({ publicId: 'dl_nobook', title: 'No book', externalId: 'ext-3', clientStatus: 'completed', pipelineStage: 'idle', progress: 1, bookId: null, completedAt: new Date() });

    const eligible = await svc(db).getEligibleDownloads();
    expect(eligible).toHaveLength(0);
  });
});

/**
 * #2488 AC7 — `handleTorrentRemoval` is private and reachable only through `importDownload`, and
 * the point of these cases is that a real adapter REFUSES a blank stored external id. A mock
 * adapter told to reject proves the caller's `catch` and nothing about the adapter
 * ([[degrading-adapter-invisible-to-mock-suite]]), so this describe drives the real
 * TransmissionClient over MSW instead.
 */
describe('ImportService import-time torrent removal over the real TransmissionClient (#2488)', () => {
  const server = useMswServer();
  const RPC_URL = 'http://localhost:9091/transmission/rpc';
  const VALID = 'aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00';
  const BLANK = '   ';

  const torrent = {
    hashString: VALID,
    name: 'The Way of Kings',
    status: 6,
    percentDone: 1,
    totalSize: 500_000_000,
    downloadedEver: 500_000_000,
    uploadedEver: 1_000_000_000,
    uploadRatio: 2,
    peersSendingToUs: 1,
    peersGettingFromUs: 0,
    eta: 0,
    downloadDir: '/downloads',
    addedDate: 1_700_000_000,
    doneDate: 1_700_003_600,
    errorString: '',
    leftUntilDone: 0,
  };

  let db: ReturnType<typeof createMockDb>;
  let log: ReturnType<typeof createMockLogger>;
  let settingsService: ReturnType<typeof createMockSettingsService>;
  let service: ImportService;
  let client: TransmissionClient;
  let removals: string[];
  let updateChain: ReturnType<typeof mockDbChain>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    log = createMockLogger();
    settingsService = createMockSettingsService();
    removals = [];
    client = new TransmissionClient({
      host: 'localhost', port: 9091, username: 'admin', password: 'password', useSsl: false,
    });

    const clientService = inject<DownloadClientService>({
      getAdapter: vi.fn().mockResolvedValue(client),
      getById: vi.fn().mockResolvedValue({ id: 1, name: 'Transmission', type: 'transmission', enabled: true }),
    });
    const bookService = {
      getById: vi.fn().mockResolvedValue({ ...mockBook, authors: [mockAuthor], narrators: [] }),
      update: vi.fn().mockResolvedValue(undefined),
    };
    service = new ImportService(inject<Db>(db), clientService, settingsService, inject<FastifyBaseLogger>(log), undefined, bookService as never);

    vi.mocked(rm).mockResolvedValue(undefined);
    vi.mocked(rename).mockResolvedValue(undefined);
    vi.mocked(cp).mockResolvedValue(undefined);
    vi.mocked(stat).mockImplementation(async (p: unknown) =>
      String(p).endsWith('.import-commit-pending')
        ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
        : ({ isFile: () => false, isDirectory: () => true, size: 500_000_000 } as never));
    vi.mocked(readdir).mockResolvedValue([
      { name: 'chapter1.mp3', isFile: () => true, isDirectory: () => false },
    ] as never);
    vi.mocked(statfs).mockResolvedValue({ bavail: BigInt(100_000_000_000), bsize: BigInt(1) } as never);

    server.use(
      http.post(RPC_URL, async ({ request }) => {
        const body = await request.json() as { method: string; arguments?: Record<string, unknown> };
        if (body.method === 'torrent-remove') {
          for (const t of transmissionSelects(body.arguments?.ids, [torrent])) removals.push(t.hashString);
          return HttpResponse.json({ result: 'success', arguments: {} });
        }
        return HttpResponse.json({
          result: 'success',
          arguments: { torrents: transmissionSelects(body.arguments?.ids, [torrent]) },
        });
      }),
    );
  });

  function seed(externalId: string, importSettings: Record<string, unknown>) {
    const settingsGet = settingsService.get as Mock;
    settingsGet.mockImplementation((key: string) => {
      if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });
      if (key === 'import') return Promise.resolve(importSettings);
      return Promise.resolve({});
    });
    db.select.mockReturnValueOnce(mockDbChain([{ ...mockDownload, externalId }]));
    updateChain = mockDbChain();
    db.update.mockReturnValue(updateChain);
  }

  function writtenPayloads() {
    return (updateChain.set as Mock).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
  }

  /**
   * The reachability boundary AC7's immediate-removal bullet turns on: `resolveSavePath`
   * (`src/server/utils/download-path.ts:22`) throws on a `null` read, and it runs BEFORE the
   * import body, so a blank-id row aborts there and `handleTorrentRemoval` is never reached at
   * all. Unchanged by the guard — the pre-#2488 adapter's `ids: ['   ']` matched nothing and
   * produced the same `null` — so this pins existing behavior rather than adding any.
   */
  it('aborts a blank-id import at save-path resolution, never reaching the removal stage', async () => {
    seed(BLANK, { deleteAfterImport: true, minSeedTime: 0, minSeedRatio: 0, minFreeSpaceGB: 0 });

    await expect(service.importDownload(1)).rejects.toThrow(/not found in client/);

    expect(removals).toEqual([]);
    expect(writtenPayloads().some((p) => 'pendingCleanup' in p)).toBe(false);
    expect(log.error).not.toHaveBeenCalledWith(expect.anything(), 'Failed to remove torrent after import');
  });

  it('control: the same harness imports a valid id and deletes the torrent with its files', async () => {
    seed(VALID, { deleteAfterImport: true, minSeedTime: 0, minSeedRatio: 0, minFreeSpaceGB: 0 });

    const result = await service.importDownload(1);

    expect(result.downloadId).toBe(1);
    expect(removals).toEqual([VALID]);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: VALID, clientType: 'transmission', deleteFiles: true }),
      'Torrent removed from client after import',
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  /**
   * AC7's second arm reached where it IS reachable. With `minSeedRatio > 0` the ratio read runs
   * first; a row the client cannot resolve yields `live-state-unavailable`, which defers and sets
   * `pendingCleanup` for the next cycle rather than failing the import.
   */
  it('defers and sets pendingCleanup when the ratio gate cannot resolve the row', async () => {
    seed(VALID, { deleteAfterImport: true, minSeedTime: 0, minSeedRatio: 1.0, minFreeSpaceGB: 0 });
    // Resolve the save path, then answer the ratio read as a torrent the client no longer holds.
    let reads = 0;
    server.use(
      http.post(RPC_URL, async ({ request }) => {
        const body = await request.json() as { method: string; arguments?: Record<string, unknown> };
        if (body.method === 'torrent-remove') {
          for (const t of transmissionSelects(body.arguments?.ids, [torrent])) removals.push(t.hashString);
          return HttpResponse.json({ result: 'success', arguments: {} });
        }
        const held = reads++ === 0 ? [torrent] : [];
        return HttpResponse.json({
          result: 'success',
          arguments: { torrents: transmissionSelects(body.arguments?.ids, held) },
        });
      }),
    );

    await service.importDownload(1);

    expect(removals).toEqual([]);
    expect(writtenPayloads()).toContainEqual(
      expect.objectContaining({ pendingCleanup: expect.any(Date) }),
    );
    expect(log.info).toHaveBeenCalledWith(
      { downloadId: 1 },
      'Skipping torrent removal — cannot fetch current state, deferring',
    );
  });

  it('control: a satisfied ratio removes instead of deferring', async () => {
    seed(VALID, { deleteAfterImport: true, minSeedTime: 0, minSeedRatio: 1.0, minFreeSpaceGB: 0 });

    await service.importDownload(1);

    expect(removals).toEqual([VALID]);
    expect(writtenPayloads().some((p) => 'pendingCleanup' in p)).toBe(false);
  });
});
