import type { Author, BookWithAuthor } from '../lib/api/books.js';
import type { DownloadClient } from '../lib/api/download-clients.js';
import type { Indexer } from '../lib/api/indexers.js';
import type { Notifier } from '../lib/api/notifiers.js';
import type { Settings } from '../lib/api/settings.js';

let nextId = 1;

export function createMockAuthor(overrides?: Partial<Author>): Author {
  const id = overrides?.id ?? nextId++;
  return {
    id,
    name: 'Brandon Sanderson',
    slug: 'brandon-sanderson',
    ...overrides,
  };
}

export function createMockBook(overrides?: Partial<BookWithAuthor>): BookWithAuthor {
  const id = overrides?.id ?? nextId++;
  return {
    id,
    title: 'The Way of Kings',
    authorId: 1,
    narrator: 'Michael Kramer',
    description: '<p>An epic fantasy novel.</p>',
    coverUrl: 'https://example.com/cover.jpg',
    asin: 'B003P2WO5E',
    isbn: null,
    seriesName: 'The Stormlight Archive',
    seriesPosition: 1,
    duration: 52320,
    publishedDate: '2010-08-31',
    genres: ['Fantasy', 'Epic'],
    status: 'wanted',
    path: null,
    size: null,
    enrichmentStatus: 'pending',
    audioCodec: null,
    audioBitrate: null,
    audioSampleRate: null,
    audioChannels: null,
    audioBitrateMode: null,
    audioFileFormat: null,
    audioFileCount: null,
    audioTotalSize: null,
    audioDuration: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    author: createMockAuthor({ id: 1 }),
    ...overrides,
  };
}

export function createMockSettings(overrides?: Partial<Settings>): Settings {
  return {
    library: { path: '/audiobooks', folderFormat: '{author}/{title}' },
    search: { enabled: true, intervalMinutes: 360, autoGrab: false },
    import: { deleteAfterImport: false, minSeedTime: 60 },
    general: { logLevel: 'info' },
    metadata: { audibleRegion: 'us' },
    ...overrides,
  };
}

export function createMockIndexer(overrides?: Partial<Indexer>): Indexer {
  const id = overrides?.id ?? nextId++;
  return {
    id,
    name: 'My ABB',
    type: 'abb',
    enabled: true,
    priority: 50,
    settings: { hostname: 'audiobookbay.lu', pageLimit: 2 },
    createdAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

export function createMockDownloadClient(overrides?: Partial<DownloadClient>): DownloadClient {
  const id = overrides?.id ?? nextId++;
  return {
    id,
    name: 'My qBittorrent',
    type: 'qbittorrent',
    enabled: true,
    priority: 50,
    settings: { host: 'localhost', port: 8080, username: 'admin', password: 'pass', useSsl: false },
    createdAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

export function createMockNotifier(overrides?: Partial<Notifier>): Notifier {
  const id = overrides?.id ?? nextId++;
  return {
    id,
    name: 'My Webhook',
    type: 'webhook',
    enabled: true,
    events: ['on_grab', 'on_import'],
    settings: { url: 'https://example.com/hook', method: 'POST' },
    createdAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}
