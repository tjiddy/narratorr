/**
 * Server-side mock factories for DB row shapes.
 * Timestamps are Date objects (matching Drizzle ORM output).
 */

const now = new Date('2024-01-01T00:00:00Z');

export function createMockDbAuthor(overrides?: Record<string, unknown>) {
  return {
    id: 1,
    name: 'Brandon Sanderson',
    slug: 'brandon-sanderson',
    asin: null as string | null,
    imageUrl: null as string | null,
    bio: null as string | null,
    monitored: false,
    lastCheckedAt: null as Date | null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createMockDbBook(overrides?: Record<string, unknown>) {
  return {
    id: 1,
    title: 'The Way of Kings',
    description: 'An epic fantasy' as string | null,
    coverUrl: null as string | null,
    goodreadsId: null as string | null,
    audibleId: null as string | null,
    asin: null as string | null,
    isbn: null as string | null,
    seriesName: null as string | null,
    seriesPosition: null as number | null,
    duration: null as number | null,
    publishedDate: null as string | null,
    genres: null as string[] | null,
    status: 'wanted' as const,
    enrichmentStatus: 'pending' as const,
    path: null as string | null,
    size: null as number | null,
    audioCodec: null as string | null,
    audioBitrate: null as number | null,
    audioSampleRate: null as number | null,
    audioChannels: null as number | null,
    audioBitrateMode: null as string | null,
    audioFileFormat: null as string | null,
    audioFileCount: null as number | null,
    audioTotalSize: null as number | null,
    audioDuration: null as number | null,
    monitorForUpgrades: false,
    importListId: null as number | null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createMockDbImportList(overrides?: Record<string, unknown>) {
  return {
    id: 1,
    name: 'My ABS List',
    type: 'abs' as const,
    enabled: true,
    settings: { serverUrl: 'http://abs.local', apiKey: 'test-key', libraryId: 'lib-1' },
    syncIntervalMinutes: 1440,
    lastRunAt: null as Date | null,
    nextRunAt: null as Date | null,
    lastSyncError: null as string | null,
    createdAt: now,
    ...overrides,
  };
}

export function createMockDbIndexer(overrides?: Record<string, unknown>) {
  return {
    id: 1,
    name: 'AudioBookBay',
    type: 'abb' as const,
    enabled: true,
    priority: 50,
    settings: { hostname: 'audiobookbay.lu', pageLimit: 2 },
    source: null as string | null,
    sourceIndexerId: null as number | null,
    createdAt: now,
    ...overrides,
  };
}

export function createMockDbDownloadClient(overrides?: Record<string, unknown>) {
  return {
    id: 1,
    name: 'qBittorrent',
    type: 'qbittorrent' as const,
    enabled: true,
    priority: 50,
    settings: { host: 'localhost', port: 8080, username: 'admin', password: 'pass', useSsl: false },
    createdAt: now,
    ...overrides,
  };
}

export function createMockDbRemotePathMapping(overrides?: Record<string, unknown>) {
  return {
    id: 1,
    downloadClientId: 1,
    remotePath: '/downloads/complete/',
    localPath: 'C:\\downloads\\',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createMockDbBookEvent(overrides?: Record<string, unknown>) {
  return {
    id: 1,
    bookId: 1 as number | null,
    downloadId: null as number | null,
    bookTitle: 'The Way of Kings',
    authorName: 'Brandon Sanderson' as string | null,
    narratorName: null as string | null,
    eventType: 'grabbed' as const,
    source: 'auto' as const,
    reason: null as Record<string, unknown> | null,
    createdAt: now,
    ...overrides,
  };
}

export function createMockDbRecyclingBinEntry(overrides?: Record<string, unknown>) {
  return {
    id: 1,
    bookId: 1 as number | null,
    title: 'The Way of Kings',
    authorName: ['Brandon Sanderson'] as string[] | null,
    authorAsin: null as string | null,
    narrator: ['Michael Kramer'] as string[] | null,
    description: 'An epic fantasy' as string | null,
    coverUrl: null as string | null,
    asin: null as string | null,
    isbn: null as string | null,
    seriesName: null as string | null,
    seriesPosition: null as number | null,
    duration: null as number | null,
    publishedDate: null as string | null,
    genres: null as string[] | null,
    monitorForUpgrades: false,
    originalPath: '/audiobooks/Brandon Sanderson/The Way of Kings',
    recyclePath: './config/recycle/1',
    deletedAt: now,
    ...overrides,
  };
}

export function createMockDbNotifier(overrides?: Record<string, unknown>) {
  return {
    id: 1,
    name: 'Test Webhook',
    type: 'webhook' as const,
    enabled: true,
    events: ['on_grab', 'on_import'] as string[],
    settings: { url: 'https://example.com/hook' },
    createdAt: now,
    ...overrides,
  };
}
