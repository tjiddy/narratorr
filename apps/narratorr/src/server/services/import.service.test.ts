import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import { ImportService, buildTargetPath } from './import.service.js';
import { sanitizePath } from '@narratorr/core/utils';
import type { DownloadClientService } from './download-client.service.js';
import type { SettingsService } from './settings.service.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@narratorr/db';

// Mock node:fs/promises
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  cp: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 1024 }),
  readdir: vi.fn().mockResolvedValue([]),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

// Mock audio scanner
vi.mock('@narratorr/core/utils/audio-scanner', () => ({
  scanAudioDirectory: vi.fn().mockResolvedValue(null),
}));

import { mkdir, cp, stat, readdir, writeFile } from 'node:fs/promises';
import { scanAudioDirectory } from '@narratorr/core/utils/audio-scanner';

const now = new Date();

const mockBook = {
  id: 1,
  title: 'The Way of Kings',
  authorId: 1,
  narrator: null,
  description: null,
  coverUrl: null,
  goodreadsId: null,
  audibleId: null,
  asin: null,
  isbn: null,
  seriesName: 'The Stormlight Archive',
  seriesPosition: 1,
  duration: null,
  publishedDate: null,
  genres: null,
  status: 'downloading' as const,
  enrichmentStatus: 'pending' as const,
  path: null,
  size: null,
  createdAt: now,
  updatedAt: now,
};

const mockAuthor = {
  id: 1,
  name: 'Brandon Sanderson',
  slug: 'brandon-sanderson',
  asin: null,
  imageUrl: null,
  bio: null,
  monitored: false,
  lastCheckedAt: null,
  createdAt: now,
  updatedAt: now,
};

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
      if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}' });
      if (key === 'import') return Promise.resolve({ deleteAfterImport: false, minSeedTime: 0 });
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
});

describe('ImportService', () => {
  let db: ReturnType<typeof createMockDb>;
  let clientService: ReturnType<typeof createMockDownloadClientService>;
  let settingsService: ReturnType<typeof createMockSettingsService>;
  let service: ImportService;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    clientService = createMockDownloadClientService();
    settingsService = createMockSettingsService();
    service = new ImportService(inject<Db>(db), clientService, settingsService, inject<FastifyBaseLogger>(createMockLogger()));

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
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}' });
        if (key === 'import') return Promise.resolve({ deleteAfterImport: true, minSeedTime: 0 });
        return Promise.resolve({});
      });

      db.select.mockReturnValueOnce(mockDbChain([mockDownload]));
      db.select.mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));
      db.update.mockReturnValue(mockDbChain());

      await service.importDownload(1);

      expect(mockAdapter.removeDownload).toHaveBeenCalledWith('ext-1', true);
    });

    it('skips torrent removal when minSeedTime not elapsed', async () => {
      const settingsGet = settingsService.get as ReturnType<typeof vi.fn>;
      settingsGet.mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}' });
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
});
