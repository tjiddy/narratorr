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
    authorId: 1 as number | null,
    narrator: 'Michael Kramer' as string | null,
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
    createdAt: now,
    updatedAt: now,
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
