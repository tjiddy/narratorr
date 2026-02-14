import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockDb, createMockLogger, mockDbChain } from '../__tests__/helpers.js';
import { ImportService, sanitizePath, buildTargetPath } from './import.service.js';
import type { DownloadClientService } from './download-client.service.js';
import type { SettingsService } from './settings.service.js';

// Mock node:fs/promises
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  cp: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 1024 }),
  readdir: vi.fn().mockResolvedValue([]),
}));

import { mkdir, cp, stat, readdir } from 'node:fs/promises';

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
  return {
    getAdapter: vi.fn().mockResolvedValue(mockAdapter),
  } as unknown as DownloadClientService;
}

function createMockSettingsService(): SettingsService {
  return {
    get: vi.fn().mockImplementation((key: string) => {
      if (key === 'library') return Promise.resolve({ path: '/audiobooks', folderFormat: '{author}/{title}' });
      if (key === 'import') return Promise.resolve({ deleteAfterImport: false, minSeedTime: 0 });
      return Promise.resolve({});
    }),
  } as unknown as SettingsService;
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
    service = new ImportService(db as any, clientService, settingsService, createMockLogger() as any);

    // Default: stat returns a directory for source, then directory for target (size verification)
    const statMock = stat as unknown as ReturnType<typeof vi.fn>;
    statMock.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 500_000_000 });

    // readdir returns one audio file
    const readdirMock = readdir as unknown as ReturnType<typeof vi.fn>;
    readdirMock.mockResolvedValue([
      { name: 'chapter1.mp3', isFile: () => true, isDirectory: () => false },
    ]);
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
      const statMock = stat as unknown as ReturnType<typeof vi.fn>;
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
});
