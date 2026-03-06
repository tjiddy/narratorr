import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import { ImportService, buildTargetPath } from './import.service.js';
import { sanitizePath } from '@narratorr/core/utils';
import type { DownloadClientService } from './download-client.service.js';
import type { SettingsService } from './settings.service.js';
import type { NotifierService } from './notifier.service.js';
import type { RemotePathMappingService } from './remote-path-mapping.service.js';
import type { TaggingService } from './tagging.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@narratorr/db';

// Mock node:fs/promises
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  cp: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 1024 }),
  readdir: vi.fn().mockResolvedValue([]),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));

// Mock enrichment-utils — delegates to real impl by default, override per-test for throw scenarios
const realEnrichBookFromAudio = vi.hoisted(() => {
  let realFn: ((...args: unknown[]) => Promise<unknown>) | null = null;
  return {
    setReal: (fn: (...args: unknown[]) => Promise<unknown>) => { realFn = fn; },
    call: (...args: unknown[]) => realFn ? realFn(...args) : Promise.resolve({ enriched: false }),
  };
});

vi.mock('./enrichment-utils.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, (...args: unknown[]) => Promise<unknown>>;
  realEnrichBookFromAudio.setReal(actual.enrichBookFromAudio);
  return {
    enrichBookFromAudio: vi.fn().mockImplementation((...args: unknown[]) => realEnrichBookFromAudio.call(...args)),
  };
});

// Mock audio scanner
vi.mock('@narratorr/core/utils/audio-scanner', () => ({
  scanAudioDirectory: vi.fn().mockResolvedValue(null),
}));

// Mock audio processor
vi.mock('@narratorr/core/utils/audio-processor', () => ({
  processAudioFiles: vi.fn().mockResolvedValue({ success: true, outputFiles: [] }),
}));

import { mkdir, cp, stat, readdir, writeFile, rename, rm } from 'node:fs/promises';
import { scanAudioDirectory } from '@narratorr/core/utils/audio-scanner';
import { processAudioFiles } from '@narratorr/core/utils/audio-processor';
import { enrichBookFromAudio } from './enrichment-utils.js';

import { createMockDbBook, createMockDbAuthor } from '../__tests__/factories.js';

const now = new Date();

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
  status: 'completed' as const,
  progress: 1,
  externalId: 'ext-1',
  errorMessage: null,
  addedAt: now,
  completedAt: new Date(Date.now() - 3600_000), // 1 hour ago
};

const mockAdapter = {
  getDownload: vi.fn().mockResolvedValue({
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
  }),
  removeDownload: vi.fn().mockResolvedValue(undefined),
};

function createMockDownloadClientService(): DownloadClientService {
  return inject<DownloadClientService>({
    getAdapter: vi.fn().mockResolvedValue(mockAdapter),
  });
}

function createMockSettingsService(): SettingsService {
  return inject<SettingsService>({
    get: vi.fn().mockImplementation((key: string) => {
      if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });
      if (key === 'import') return Promise.resolve({ deleteAfterImport: false, minSeedTime: 0 });
      if (key === 'processing') return Promise.resolve({ enabled: false, ffmpegPath: '', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only' });
      return Promise.resolve({});
    }),
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
    // Empty series segment should be removed
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
    const result = buildTargetPath('/audiobooks', '{author}/{title} [{narrator}]', { title: 'Book', narrator: 'John Smith' }, 'Author');
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
    const result = buildTargetPath('/audiobooks', '{author}/{title} [{narratorLastFirst}]', { title: 'Book', narrator: 'Michael Kramer' }, 'Author');
    expect(result).toMatch(/Kramer, Michael/);
  });

  it('renders {narratorLastFirst} for multiple narrators', () => {
    const result = buildTargetPath('/audiobooks', '{author}/{title} [{narratorLastFirst}]', { title: 'Book', narrator: 'Michael Kramer, Kate Reading' }, 'Author');
    expect(result).toMatch(/Kramer, Michael & Reading, Kate/);
  });
});

describe('ImportService', () => {
  let db: ReturnType<typeof createMockDb>;
  let log: ReturnType<typeof createMockLogger>;
  let clientService: ReturnType<typeof createMockDownloadClientService>;
  let settingsService: ReturnType<typeof createMockSettingsService>;
  let service: ImportService;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    log = createMockLogger();
    clientService = createMockDownloadClientService();
    settingsService = createMockSettingsService();
    service = new ImportService(inject<Db>(db), clientService, settingsService, inject<FastifyBaseLogger>(log));

    // Default: stat returns a directory for source, then directory for target (size verification)
    const statMock = vi.mocked(stat);
    statMock.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 500_000_000 } as never);

    // readdir returns one audio file
    const readdirMock = vi.mocked(readdir);
    readdirMock.mockResolvedValue([
      { name: 'chapter1.mp3', isFile: () => true, isDirectory: () => false },
    ] as never);
  });

  describe('importDownload', () => {
    it('imports a completed download successfully', async () => {
      // First select: get download
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      // Second select: get book with author
      db.select.mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));
      // update calls: set importing, then update book, then update download to imported
      db.update.mockReturnValue(mockDbChain());

      const result = await service.importDownload(1);

      expect(result.downloadId).toBe(1);
      expect(result.bookId).toBe(1);
      expect(result.targetPath).toMatch(/audiobooks/);
      expect(mkdir).toHaveBeenCalled();
      expect(cp).toHaveBeenCalled();
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
      db.select.mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      // Make stat throw to simulate file not found
      const statMock = vi.mocked(stat);
      statMock.mockRejectedValueOnce(new Error('ENOENT'));

      // The second update (setting importing) succeeds, then stat fails
      await expect(service.importDownload(1)).rejects.toThrow();
    });

    it('handles torrent removal when deleteAfterImport is true', async () => {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: true, minSeedTime: 0 });
        return Promise.resolve({});
      });

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      expect(mockAdapter.removeDownload).toHaveBeenCalledWith('ext-1', true);
    });

    it('swallows adapter error during torrent removal (import still succeeds)', async () => {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: true, minSeedTime: 0 });
        return Promise.resolve({});
      });

      mockAdapter.removeDownload.mockRejectedValueOnce(new Error('Connection refused'));

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      // Should NOT throw — error is logged but swallowed
      const result = await service.importDownload(1);

      expect(result.downloadId).toBe(1);
      expect(mockAdapter.removeDownload).toHaveBeenCalled();
    });

    it('skips torrent removal when minSeedTime not elapsed', async () => {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: true, minSeedTime: 120 }); // 2 hours
        return Promise.resolve({});
      });

      // Download completed 1 hour ago, min seed time is 2 hours
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      expect(mockAdapter.removeDownload).not.toHaveBeenCalled();
    });
  });

  describe('processCompletedDownloads', () => {
    it('returns empty array when no completed downloads', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));

      const results = await service.processCompletedDownloads();
      expect(results).toEqual([]);
    });

    it('skips downloads with no linked book', async () => {
      db.select.mockReturnValueOnce(mockDbChain([{ ...mockDownload, bookId: null }]));

      const results = await service.processCompletedDownloads();
      expect(results).toEqual([]);
    });
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
      db.select.mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());
    }

    /** Extract the enrichment update (the one with audioCodec) from db.update calls. */
    function getEnrichmentUpdate(): Record<string, unknown> | undefined {
      const updateCalls = db.update.mock.results;
      const setCalls = updateCalls
        .map(r => (r.value as { set: ReturnType<typeof vi.fn> }).set)
        .filter(Boolean);
      const allSetArgs = setCalls.flatMap(s => s.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>));
      return allSetArgs.find(a => a.audioCodec);
    }

    it('converts duration from seconds to minutes when writing to books.duration', async () => {
      setupImportMocks();
      const mockScan = vi.mocked(scanAudioDirectory);
      mockScan.mockResolvedValueOnce(mockScanResult);

      await service.importDownload(1);

      const enrichmentCall = getEnrichmentUpdate();
      expect(enrichmentCall).toBeDefined();
      expect(enrichmentCall!.duration).toBe(120); // 7200 seconds / 60 = 120 minutes
      expect(enrichmentCall!.audioDuration).toBe(7200); // stays in seconds
    });

    it('does not overwrite existing narrator', async () => {
      const bookWithNarrator = { ...mockBook, narrator: 'Existing Narrator' };
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: bookWithNarrator, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      const mockScan = vi.mocked(scanAudioDirectory);
      mockScan.mockResolvedValueOnce(mockScanResult);

      await service.importDownload(1);

      const enrichmentCall = getEnrichmentUpdate();
      expect(enrichmentCall).toBeDefined();
      expect(enrichmentCall!.narrator).toBeUndefined(); // should not overwrite
    });

    it('does not overwrite existing duration', async () => {
      const bookWithDuration = { ...mockBook, duration: 150 };
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: bookWithDuration, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      const mockScan = vi.mocked(scanAudioDirectory);
      mockScan.mockResolvedValueOnce(mockScanResult);

      await service.importDownload(1);

      const enrichmentCall = getEnrichmentUpdate();
      expect(enrichmentCall).toBeDefined();
      expect(enrichmentCall!.duration).toBeUndefined(); // should not overwrite
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

      expect(writeFile).toHaveBeenCalled();
      const writeCall = vi.mocked(writeFile).mock.calls[0];
      expect(writeCall[0]).toMatch(/cover\.png$/);
      expect(writeCall[1]).toBe(coverData);

      const enrichmentCall = getEnrichmentUpdate();
      expect(enrichmentCall!.coverUrl).toBe('/api/books/1/cover');
    });

    it('does not save cover when book already has coverUrl', async () => {
      const bookWithCover = { ...mockBook, coverUrl: 'https://example.com/cover.jpg' };
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: bookWithCover, author: mockAuthor }]));
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

      expect(writeFile).not.toHaveBeenCalled();
    });

    it('continues gracefully when scanner returns null', async () => {
      setupImportMocks();
      const mockScan = vi.mocked(scanAudioDirectory);
      mockScan.mockResolvedValueOnce(null);

      const result = await service.importDownload(1);
      expect(result.downloadId).toBe(1);
      // Should complete without error
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
      db.select.mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      await expect(service.importDownload(1)).rejects.toThrow('missing client or external ID');
    });

    it('throws when download has no externalId', async () => {
      const downloadNoExtId = { ...mockDownload, externalId: null };
      db.select.mockReturnValueOnce(mockDbChain([downloadNoExtId]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));
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
      db.select.mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));
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
      db.select.mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      await expect(service.importDownload(1)).rejects.toThrow('Client connection refused');
    });

    it('throws when no audio files in directory', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      // readdir returns no audio files
      const readdirMock = vi.mocked(readdir);
      readdirMock.mockResolvedValue([
        { name: 'readme.txt', isFile: () => true, isDirectory: () => false },
        { name: 'cover.jpg', isFile: () => true, isDirectory: () => false },
      ] as never);

      await expect(service.importDownload(1)).rejects.toThrow('No audio files found');
    });

    it('sets download to failed when file copy fails mid-import', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      // readdir returns audio file
      const readdirMock = vi.mocked(readdir);
      readdirMock.mockResolvedValue([
        { name: 'chapter1.mp3', isFile: () => true, isDirectory: () => false },
      ] as never);

      // cp throws mid-copy
      const cpMock = vi.mocked(cp);
      cpMock.mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));

      await expect(service.importDownload(1)).rejects.toThrow('ENOSPC');
      // Download should be set to failed
      expect(db.update).toHaveBeenCalled();
    });

    it('throws when book not found for linked bookId', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([]));  // book not found

      await expect(service.importDownload(1)).rejects.toThrow('Book 1 not found');
    });

    it('throws when download client adapter is null', async () => {
      (clientService.getAdapter as Mock).mockResolvedValue(null);

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      await expect(service.importDownload(1)).rejects.toThrow('not found');
    });
  });

  describe('upgrade flow — book already imported', () => {
    const importedBook = createMockDbBook({
      status: 'downloading' as const,
      path: '/audiobooks/Old Author/Old Book',
      size: 400_000_000,
    });

    it('deletes old files when book has existing path at different location', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: importedBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      const rmMock = vi.mocked(rm);
      expect(rmMock).toHaveBeenCalledWith('/audiobooks/Old Author/Old Book', { recursive: true, force: true });
    });

    it('logs old path at info level during upgrade', async () => {
      const log = createMockLogger();
      const svc = new ImportService(inject<Db>(db), clientService, settingsService, inject<FastifyBaseLogger>(log));

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: importedBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      await svc.importDownload(1);

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ oldPath: '/audiobooks/Old Author/Old Book' }),
        'Deleted old book files during upgrade',
      );
    });

    it('skips deletion when target path equals existing book path (same-path upgrade)', async () => {
      // Book with path that matches what buildTargetPath will generate
      const samePathBook = createMockDbBook({
        status: 'downloading' as const,
        // buildTargetPath generates: /audiobooks/{author}/{title} — mock it to match
        path: '/audiobooks/Brandon Sanderson/The Way of Kings',
      });

      // Override settings to produce a known target path
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: false, minSeedTime: 0 });
        if (key === 'processing') return Promise.resolve({ enabled: false });
        return Promise.resolve({});
      });

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: samePathBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      const rmMock = vi.mocked(rm);
      expect(rmMock).not.toHaveBeenCalled();
    });

    it('continues when old file deletion fails (EACCES)', async () => {
      const rmMock = vi.mocked(rm);
      rmMock.mockRejectedValueOnce(new Error('EACCES: permission denied'));

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: importedBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      // Should NOT throw — import still succeeds
      const result = await service.importDownload(1);
      expect(result.downloadId).toBe(1);
    });

    it('does not roll back new files when old file deletion fails', async () => {
      const rmMock = vi.mocked(rm);
      rmMock.mockRejectedValueOnce(new Error('EACCES'));

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: importedBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      // cp was called (new files exist) and import completed
      expect(cp).toHaveBeenCalled();
      expect(mkdir).toHaveBeenCalled();
    });

    it('does not attempt deletion when book has no path', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      const rmMock = vi.mocked(rm);
      expect(rmMock).not.toHaveBeenCalled();
    });

    it('preserves old download record during upgrade (history)', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: importedBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      // Old download record should NOT be deleted — only status updated
      expect(db.delete).not.toHaveBeenCalled();
    });
  });

  describe('book status recovery on import failure', () => {
    it('reverts book to imported when import fails and book has a path', async () => {
      const importedBook = createMockDbBook({
        status: 'downloading' as const,
        path: '/audiobooks/existing',
      });

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: importedBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      // Make stat throw to trigger failure
      const statMock = vi.mocked(stat);
      statMock.mockRejectedValueOnce(new Error('ENOENT'));

      await expect(service.importDownload(1)).rejects.toThrow();

      // Check that one of the update calls set book status to 'imported'
      const updateCalls = db.update.mock.results;
      const setCalls = updateCalls
        .map(r => (r.value as { set: ReturnType<typeof vi.fn> }).set)
        .filter(Boolean);
      const allSetArgs = setCalls.flatMap(s => s.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>));
      expect(allSetArgs).toContainEqual(expect.objectContaining({ status: 'imported' }));
    });

    it('reverts book to wanted when import fails and book has no path', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      const statMock = vi.mocked(stat);
      statMock.mockRejectedValueOnce(new Error('ENOENT'));

      await expect(service.importDownload(1)).rejects.toThrow();

      const updateCalls = db.update.mock.results;
      const setCalls = updateCalls
        .map(r => (r.value as { set: ReturnType<typeof vi.fn> }).set)
        .filter(Boolean);
      const allSetArgs = setCalls.flatMap(s => s.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>));
      expect(allSetArgs).toContainEqual(expect.objectContaining({ status: 'wanted' }));
    });

    it('reverts book to imported on copy failure when book has path', async () => {
      const importedBook = createMockDbBook({
        status: 'downloading' as const,
        path: '/audiobooks/existing',
      });

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: importedBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      const cpMock = vi.mocked(cp);
      cpMock.mockRejectedValueOnce(new Error('ENOSPC'));

      await expect(service.importDownload(1)).rejects.toThrow('ENOSPC');

      const updateCalls = db.update.mock.results;
      const setCalls = updateCalls
        .map(r => (r.value as { set: ReturnType<typeof vi.fn> }).set)
        .filter(Boolean);
      const allSetArgs = setCalls.flatMap(s => s.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>));
      expect(allSetArgs).toContainEqual(expect.objectContaining({ status: 'imported' }));
    });

    it('reverts book to imported on audio processing failure when book has path', async () => {
      const importedBook = createMockDbBook({
        status: 'downloading' as const,
        path: '/audiobooks/existing',
      });

      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: false, minSeedTime: 0 });
        if (key === 'processing') return Promise.resolve({
          enabled: true, ffmpegPath: '/usr/bin/ffmpeg', outputFormat: 'm4b',
          keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only',
        });
        return Promise.resolve({});
      });

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: importedBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      const mockProcess = vi.mocked(processAudioFiles);
      mockProcess.mockResolvedValue({ success: false, error: 'ffmpeg crashed' });

      await expect(service.importDownload(1)).rejects.toThrow('Audio processing failed');

      const updateCalls = db.update.mock.results;
      const setCalls = updateCalls
        .map(r => (r.value as { set: ReturnType<typeof vi.fn> }).set)
        .filter(Boolean);
      const allSetArgs = setCalls.flatMap(s => s.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>));
      // Should have both the 'failed' status from processing error AND 'imported' from recovery
      expect(allSetArgs).toContainEqual(expect.objectContaining({ status: 'imported' }));
    });
  });

  describe('target path cleanup on import failure', () => {
    it('removes targetPath when DB update throws after copy', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));

      // First two updates succeed (book status='importing', download status='importing')
      // Then fail on the book update (status='imported', path=targetPath)
      let updateCallCount = 0;
      db.update.mockImplementation(() => {
        updateCallCount++;
        if (updateCallCount === 3) {
          // 3rd update: book status='imported' — this is the one that should fail
          return { set: vi.fn().mockReturnValue({ where: vi.fn().mockRejectedValue(new Error('DB write failed')) }) } as never;
        }
        return mockDbChain() as never;
      });

      const rmMock = vi.mocked(rm);

      await expect(service.importDownload(1)).rejects.toThrow('DB write failed');

      // Verify rm was called on the target path
      expect(rmMock).toHaveBeenCalledWith(
        expect.stringContaining('audiobooks'),
        { recursive: true, force: true },
      );

      // Verify DB revert still happened (download set to failed, book set to wanted)
      const updateCalls = db.update.mock.results;
      const setCalls = updateCalls
        .map(r => {
          try { return (r.value as { set: ReturnType<typeof vi.fn> }).set; } catch { return null; }
        })
        .filter(Boolean);
      const allSetArgs = setCalls!.flatMap(s => s!.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>));
      expect(allSetArgs).toContainEqual(expect.objectContaining({ status: 'failed' }));
      expect(allSetArgs).toContainEqual(expect.objectContaining({ status: 'wanted' }));
    });

    it('logs warning and continues DB revert when rm(targetPath) throws', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));

      let updateCallCount = 0;
      db.update.mockImplementation(() => {
        updateCallCount++;
        if (updateCallCount === 3) {
          return { set: vi.fn().mockReturnValue({ where: vi.fn().mockRejectedValue(new Error('DB write failed')) }) } as never;
        }
        return mockDbChain() as never;
      });

      // Make rm throw
      const rmMock = vi.mocked(rm);
      rmMock.mockRejectedValueOnce(new Error('EPERM: permission denied'));

      await expect(service.importDownload(1)).rejects.toThrow('DB write failed');

      // Verify cleanup was attempted
      expect(rmMock).toHaveBeenCalledWith(
        expect.stringContaining('audiobooks'),
        { recursive: true, force: true },
      );

      // Verify cleanup failure was logged at warn level
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ targetPath: expect.stringContaining('audiobooks') }),
        expect.stringContaining('Failed to clean up target path'),
      );

      // Verify DB revert still proceeded despite rm failure
      const updateCalls = db.update.mock.results;
      const setCalls = updateCalls
        .map(r => {
          try { return (r.value as { set: ReturnType<typeof vi.fn> }).set; } catch { return null; }
        })
        .filter(Boolean);
      const allSetArgs = setCalls!.flatMap(s => s!.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>));
      expect(allSetArgs).toContainEqual(expect.objectContaining({ status: 'failed' }));
      expect(allSetArgs).toContainEqual(expect.objectContaining({ status: 'wanted' }));
    });
  });

  describe('file renaming with template (non-processing path)', () => {
    it('renames audio files using fileFormat template after import', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      // readdir returns audio files for the rename step (second call after containsAudioFiles)
      const readdirMock = vi.mocked(readdir);
      readdirMock.mockResolvedValue([
        { name: 'scene-release-01.mp3', isFile: () => true, isDirectory: () => false },
      ] as never);

      await service.importDownload(1);

      const renameMock = vi.mocked(rename);
      expect(renameMock).toHaveBeenCalled();
    });
  });

  describe('audio processing integration', () => {
    function setupImportWithProcessing(processingEnabled: boolean) {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: false, minSeedTime: 0 });
        if (key === 'processing') return Promise.resolve({
          enabled: processingEnabled,
          ffmpegPath: '/usr/bin/ffmpeg',
          outputFormat: 'm4b',
          keepOriginalBitrate: false,
          bitrate: 128,
          mergeBehavior: 'multi-file-only',
        });
        return Promise.resolve({});
      });

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());
    }

    it('calls audio processor when processing enabled and multi-file import', async () => {
      setupImportWithProcessing(true);
      const mockProcess = vi.mocked(processAudioFiles);
      mockProcess.mockResolvedValue({ success: true, outputFiles: ['/audiobooks/out.m4b'] });

      await service.importDownload(1);

      expect(mockProcess).toHaveBeenCalledWith(
        expect.stringMatching(/audiobooks/),
        expect.objectContaining({ ffmpegPath: '/usr/bin/ffmpeg', outputFormat: 'm4b' }),
        expect.objectContaining({ author: 'Brandon Sanderson', title: 'The Way of Kings' }),
      );
    });

    it('skips audio processor when processing disabled', async () => {
      setupImportWithProcessing(false);
      const mockProcess = vi.mocked(processAudioFiles);

      await service.importDownload(1);

      expect(mockProcess).not.toHaveBeenCalled();
    });

    it('sets book status to failed on processor error', async () => {
      setupImportWithProcessing(true);
      const mockProcess = vi.mocked(processAudioFiles);
      mockProcess.mockResolvedValue({ success: false, error: 'ffmpeg crashed' });

      await expect(service.importDownload(1)).rejects.toThrow('Audio processing failed: ffmpeg crashed');

      // Verify book was set to 'failed' status
      const updateCalls = db.update.mock.results;
      const setCalls = updateCalls
        .map(r => (r.value as { set: ReturnType<typeof vi.fn> }).set)
        .filter(Boolean);
      const allSetArgs = setCalls.flatMap(s => s.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>));
      expect(allSetArgs).toContainEqual(expect.objectContaining({ status: 'failed' }));
    });

    it('fires on_failure notification on processor error', async () => {
      const mockNotifier = {
        notify: vi.fn().mockResolvedValue(undefined),
      };
      const serviceWithNotifier = new ImportService(
        inject<Db>(db), clientService, settingsService,
        inject<FastifyBaseLogger>(createMockLogger()),
        inject<NotifierService>(mockNotifier),
      );

      setupImportWithProcessing(true);
      const mockProcess = vi.mocked(processAudioFiles);
      mockProcess.mockResolvedValue({ success: false, error: 'ffmpeg crashed' });

      await expect(serviceWithNotifier.importDownload(1)).rejects.toThrow();

      expect(mockNotifier.notify).toHaveBeenCalledWith('on_failure', expect.objectContaining({
        error: expect.objectContaining({ stage: 'import' }),
      }));
    });

    it('passes undefined bitrate when keepOriginalBitrate is true', async () => {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: false, minSeedTime: 0 });
        if (key === 'processing') return Promise.resolve({
          enabled: true,
          ffmpegPath: '/usr/bin/ffmpeg',
          outputFormat: 'm4b',
          keepOriginalBitrate: true,
          bitrate: 128,
          mergeBehavior: 'multi-file-only',
        });
        return Promise.resolve({});
      });

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      const mockProcess = vi.mocked(processAudioFiles);
      mockProcess.mockResolvedValue({ success: true, outputFiles: ['/audiobooks/out.m4b'] });

      await service.importDownload(1);

      expect(mockProcess).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ bitrate: undefined }),
        expect.any(Object),
      );
    });

    it('proceeds to enrichment after successful processing', async () => {
      setupImportWithProcessing(true);
      const mockProcess = vi.mocked(processAudioFiles);
      mockProcess.mockResolvedValue({ success: true, outputFiles: ['/audiobooks/out.m4b'] });

      const result = await service.importDownload(1);

      expect(result.downloadId).toBe(1);
      // scanAudioDirectory is called during enrichment
      expect(scanAudioDirectory).toHaveBeenCalled();
    });
  });

  describe('remote path mapping integration', () => {
    let mockMappingService: RemotePathMappingService;
    let serviceWithMappings: ImportService;

    beforeEach(() => {
      mockMappingService = inject<RemotePathMappingService>({
        getByClientId: vi.fn().mockResolvedValue([]),
      });
      serviceWithMappings = new ImportService(
        inject<Db>(db), clientService, settingsService,
        inject<FastifyBaseLogger>(createMockLogger()),
        undefined,
        mockMappingService,
      );
    });

    it('applies path mapping when a matching mapping exists', async () => {
      (mockMappingService.getByClientId as Mock).mockResolvedValue([
        { id: 1, downloadClientId: 1, remotePath: '/downloads/', localPath: 'C:\\library\\' },
      ]);

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      const statMock = vi.mocked(stat);
      statMock.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 500_000_000 } as never);

      const result = await serviceWithMappings.importDownload(1);

      // stat should receive the mapped path, not the original /downloads/ path
      const statPath = statMock.mock.calls[0][0] as string;
      expect(statPath).toMatch(/^C:[/\\]library[/\\]/);
      expect(statPath).not.toMatch(/^\/downloads\//);

      // cp should also receive the mapped source path
      const cpMock = vi.mocked(cp);
      const cpSource = cpMock.mock.calls[0][0] as string;
      expect(cpSource).toMatch(/^C:[/\\]library[/\\]/);

      expect(result.downloadId).toBe(1);
    });

    it('skips mapping when no mappings match the path', async () => {
      (mockMappingService.getByClientId as Mock).mockResolvedValue([
        { id: 1, downloadClientId: 1, remotePath: '/other/', localPath: 'D:\\other\\' },
      ]);

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      const result = await serviceWithMappings.importDownload(1);

      // Should still work — original path used
      expect(result.downloadId).toBe(1);
    });

    it('includes ENOENT guidance suggesting path mapping when none configured', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      const statMock = vi.mocked(stat);
      const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
      enoent.code = 'ENOENT';
      statMock.mockRejectedValueOnce(enoent);

      await expect(serviceWithMappings.importDownload(1)).rejects.toThrow(
        /add a Remote Path Mapping/,
      );
    });

    it('includes ENOENT guidance about mapping config when mapping exists but path wrong', async () => {
      (mockMappingService.getByClientId as Mock).mockResolvedValue([
        { id: 1, downloadClientId: 1, remotePath: '/downloads/', localPath: 'C:\\library\\' },
      ]);

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      const statMock = vi.mocked(stat);
      const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
      enoent.code = 'ENOENT';
      statMock.mockRejectedValueOnce(enoent);

      await expect(serviceWithMappings.importDownload(1)).rejects.toThrow(
        /Check your remote path mapping configuration/,
      );
    });
  });

  describe('import atomicity failures (#235 Tier 1)', () => {
    it('cleans up copied files when DB update throws after copy (#237)', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));

      // First update (set importing) succeeds, then book update at step 8 throws
      let updateCallCount = 0;
      db.update.mockImplementation(() => {
        updateCallCount++;
        const chain = mockDbChain();
        if (updateCallCount === 3) {
          (chain.where as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB constraint violation'));
        }
        return chain;
      });

      await expect(service.importDownload(1)).rejects.toThrow('DB constraint violation');

      // Verify cp was called (files were copied)
      expect(cp).toHaveBeenCalled();

      // Fixed in #237 — rm IS now called on targetPath to clean up orphaned files
      const rmMock = vi.mocked(rm);
      expect(rmMock).toHaveBeenCalledWith(
        expect.stringContaining('audiobooks'),
        { recursive: true, force: true },
      );

      // Verify catch block still reverts download to 'failed'
      const updateCalls = db.update.mock.results;
      const setCalls = updateCalls
        .map(r => (r.value as { set: ReturnType<typeof vi.fn> }).set)
        .filter(Boolean);
      const allSetArgs = setCalls.flatMap(s => s.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>));
      expect(allSetArgs).toContainEqual(expect.objectContaining({ status: 'failed' }));
    });

    it('logs warn (not error) when upgrade rm() fails on old path', async () => {
      const importedBook = createMockDbBook({
        status: 'downloading' as const,
        path: '/audiobooks/Old Author/Old Book',
      });

      const log = createMockLogger();
      const svc = new ImportService(inject<Db>(db), clientService, settingsService, inject<FastifyBaseLogger>(log));

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: importedBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      // rm rejects for old path cleanup
      const rmMock = vi.mocked(rm);
      rmMock.mockRejectedValueOnce(new Error('EACCES: permission denied'));

      const result = await svc.importDownload(1);

      // Import still succeeds
      expect(result.downloadId).toBe(1);

      // Logged at warn level, not error
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ oldPath: '/audiobooks/Old Author/Old Book' }),
        expect.stringContaining('Failed to delete old book files'),
      );
      expect(log.error).not.toHaveBeenCalledWith(
        expect.objectContaining({ oldPath: '/audiobooks/Old Author/Old Book' }),
        expect.any(String),
      );
    });

    it('reverts download and book status when enrichBookFromAudio throws', async () => {
      const log = createMockLogger();
      const svc = new ImportService(inject<Db>(db), clientService, settingsService, inject<FastifyBaseLogger>(log));

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      // Make enrichBookFromAudio throw (simulating a scenario where internal catch is absent)
      const enrichMock = vi.mocked(enrichBookFromAudio);
      enrichMock.mockRejectedValueOnce(new Error('Enrichment exploded'));

      await expect(svc.importDownload(1)).rejects.toThrow('Enrichment exploded');

      // Verify download reverted to 'failed'
      const updateCalls = db.update.mock.results;
      const setCalls = updateCalls
        .map(r => (r.value as { set: ReturnType<typeof vi.fn> }).set)
        .filter(Boolean);
      const allSetArgs = setCalls.flatMap(s => s.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>));
      expect(allSetArgs).toContainEqual(expect.objectContaining({ status: 'failed' }));
      // Book reverted to 'wanted' (no path)
      expect(allSetArgs).toContainEqual(expect.objectContaining({ status: 'wanted' }));
      // Error logged
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ downloadId: 1 }),
        'Import failed',
      );
    });
  });

  describe('audio-only copy filtering', () => {
    it('directory import only copies audio files, skips .nzb/.sfv/.nfo', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));
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

      // Should have copied only the two audio files
      expect(copiedFiles.some(p => p.endsWith('chapter1.mp3'))).toBe(true);
      expect(copiedFiles.some(p => p.endsWith('chapter2.m4b'))).toBe(true);
      // Should NOT have copied non-audio files
      expect(copiedFiles.some(p => p.endsWith('.nzb'))).toBe(false);
      expect(copiedFiles.some(p => p.endsWith('.sfv'))).toBe(false);
      expect(copiedFiles.some(p => p.endsWith('.nfo'))).toBe(false);
      expect(copiedFiles.some(p => p.endsWith('.jpg'))).toBe(false);
    });

    it('single non-audio file import throws', async () => {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      // stat returns a file (not directory)
      const statMock = vi.mocked(stat);
      statMock.mockResolvedValue({ isFile: () => true, isDirectory: () => false, size: 1024 } as never);

      // Adapter returns a single .nzb file
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

  describe('tag embedding during import', () => {
    function createServiceWithTagging(taggingService: TaggingService, overrideSettings?: SettingsService) {
      return new ImportService(
        inject<Db>(db),
        clientService,
        overrideSettings ?? settingsService,
        inject<FastifyBaseLogger>(log),
        undefined,
        undefined,
        taggingService,
      );
    }

    function setupSuccessfulImport() {
      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());
    }

    it('calls tagging service when enabled and ffmpeg configured', async () => {
      const mockTagging = inject<TaggingService>({
        tagBook: vi.fn().mockResolvedValue({ bookId: 1, tagged: 1, skipped: 0, failed: 0, warnings: [] }),
      });
      const tagSettings = inject<SettingsService>({
        get: vi.fn().mockImplementation((key: string) => {
          if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });
          if (key === 'import') return Promise.resolve({ deleteAfterImport: false, minSeedTime: 0 });
          if (key === 'processing') return Promise.resolve({ enabled: false, ffmpegPath: '/usr/bin/ffmpeg' });
          if (key === 'tagging') return Promise.resolve({ enabled: true, mode: 'overwrite', embedCover: false });
          return Promise.resolve({});
        }),
      });

      const svc = createServiceWithTagging(mockTagging, tagSettings);
      setupSuccessfulImport();

      await svc.importDownload(1);

      expect(mockTagging.tagBook).toHaveBeenCalledWith(
        1,
        expect.any(String),
        expect.objectContaining({ title: mockBook.title }),
        '/usr/bin/ffmpeg',
        'overwrite',
        false,
      );
    });

    it('skips tagging when disabled in settings', async () => {
      const mockTagging = inject<TaggingService>({
        tagBook: vi.fn().mockResolvedValue({ bookId: 1, tagged: 0, skipped: 0, failed: 0, warnings: [] }),
      });
      const tagSettings = inject<SettingsService>({
        get: vi.fn().mockImplementation((key: string) => {
          if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });
          if (key === 'import') return Promise.resolve({ deleteAfterImport: false, minSeedTime: 0 });
          if (key === 'processing') return Promise.resolve({ enabled: false, ffmpegPath: '/usr/bin/ffmpeg' });
          if (key === 'tagging') return Promise.resolve({ enabled: false, mode: 'overwrite', embedCover: false });
          return Promise.resolve({});
        }),
      });

      const svc = createServiceWithTagging(mockTagging, tagSettings);
      setupSuccessfulImport();

      await svc.importDownload(1);

      expect(mockTagging.tagBook).not.toHaveBeenCalled();
    });

    it('continues import when tagging fails', async () => {
      const mockTagging = inject<TaggingService>({
        tagBook: vi.fn().mockRejectedValue(new Error('ffmpeg crashed')),
      });
      const tagSettings = inject<SettingsService>({
        get: vi.fn().mockImplementation((key: string) => {
          if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });
          if (key === 'import') return Promise.resolve({ deleteAfterImport: false, minSeedTime: 0 });
          if (key === 'processing') return Promise.resolve({ enabled: false, ffmpegPath: '/usr/bin/ffmpeg' });
          if (key === 'tagging') return Promise.resolve({ enabled: true, mode: 'overwrite', embedCover: false });
          return Promise.resolve({});
        }),
      });

      const svc = createServiceWithTagging(mockTagging, tagSettings);
      setupSuccessfulImport();

      // Should not throw — tagging failure is non-blocking
      const result = await svc.importDownload(1);
      expect(result.downloadId).toBe(1);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 1 }),
        expect.stringContaining('Tag embedding failed'),
      );
    });
  });

  describe('event history producers', () => {
    let eventHistory: { create: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      eventHistory = { create: vi.fn().mockResolvedValue({ id: 1 }) };
    });

    it('records imported event on successful import', async () => {
      const svc = new ImportService(
        inject<Db>(db), clientService, settingsService,
        inject<FastifyBaseLogger>(log), undefined, undefined,
        undefined, inject<EventHistoryService>(eventHistory),
      );

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      await svc.importDownload(1);

      expect(eventHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          bookId: 1,
          bookTitle: 'The Way of Kings',
          authorName: 'Brandon Sanderson',
          downloadId: 1,
          eventType: 'imported',
          source: 'auto',
          reason: expect.objectContaining({ targetPath: expect.any(String), fileCount: expect.any(Number) }),
        }),
      );
    });

    it('records upgraded event when book already has a path', async () => {
      const importedBook = createMockDbBook({
        status: 'downloading' as const,
        path: '/audiobooks/Brandon Sanderson/The Way of Kings',
      });

      const svc = new ImportService(
        inject<Db>(db), clientService, settingsService,
        inject<FastifyBaseLogger>(log), undefined, undefined,
        undefined, inject<EventHistoryService>(eventHistory),
      );

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: importedBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      await svc.importDownload(1);

      expect(eventHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          bookId: 1,
          bookTitle: 'The Way of Kings',
          eventType: 'upgraded',
          source: 'auto',
          reason: expect.objectContaining({ targetPath: expect.any(String) }),
        }),
      );
    });

    it('records import_failed event on import failure', async () => {
      const svc = new ImportService(
        inject<Db>(db), clientService, settingsService,
        inject<FastifyBaseLogger>(log), undefined, undefined,
        undefined, inject<EventHistoryService>(eventHistory),
      );

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      // Make stat throw to trigger import failure
      const statMock = vi.mocked(stat);
      statMock.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      await expect(svc.importDownload(1)).rejects.toThrow();

      expect(eventHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          bookId: 1,
          bookTitle: 'The Way of Kings',
          eventType: 'import_failed',
          source: 'auto',
          reason: expect.objectContaining({ error: expect.any(String) }),
        }),
      );
    });
  });
});
