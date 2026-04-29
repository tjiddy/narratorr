import type { Author, Narrator, BookWithAuthor, BookMetadata, AuthorMetadata } from '../lib/api/books.js';
import type { Download } from '../lib/api/activity.js';
import type { DownloadClient } from '../lib/api/download-clients.js';
import type { Indexer } from '../lib/api/indexers.js';
import type { Notifier } from '../lib/api/notifiers.js';
import type { Settings } from '../lib/api/settings.js';
import { createMockSettings as _createMockSettings, type DeepPartial } from '../../shared/schemas/settings/create-mock-settings.fixtures.js';
import type { RemotePathMapping } from '../lib/api/remote-path-mappings.js';

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

export function createMockNarrator(overrides?: Partial<Narrator>): Narrator {
  const id = overrides?.id ?? nextId++;
  return {
    id,
    name: 'Michael Kramer',
    slug: 'michael-kramer',
    ...overrides,
  };
}

export function createMockBook(overrides?: Partial<BookWithAuthor>): BookWithAuthor {
  const id = overrides?.id ?? nextId++;
  return {
    id,
    title: 'The Way of Kings',
    authors: [createMockAuthor({ id: 1 })],
    narrators: [createMockNarrator({ id: 1 })],
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
    monitorForUpgrades: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

export function createMockSettings(overrides?: DeepPartial<Settings>): Settings {
  return _createMockSettings(overrides);
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
    source: null,
    sourceIndexerId: null,
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

export function createMockRemotePathMapping(overrides?: Partial<RemotePathMapping>): RemotePathMapping {
  const id = overrides?.id ?? nextId++;
  return {
    id,
    downloadClientId: 1,
    remotePath: '/downloads/complete/',
    localPath: 'C:\\downloads\\',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
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

export function createMockDownload(overrides?: Partial<Download>): Download {
  const id = overrides?.id ?? nextId++;
  return {
    id,
    title: 'Test Audiobook',
    protocol: 'torrent',
    status: 'queued',
    progress: 0,
    addedAt: '2024-06-01T00:00:00Z',
    completedAt: null,
    seeders: null,
    bookId: null,
    indexerName: null,
    ...overrides,
  };
}

export function createMockBookMetadata(overrides?: Partial<BookMetadata>): BookMetadata {
  return {
    asin: 'B003P2WO5E',
    title: 'The Way of Kings',
    authors: [{ name: 'Brandon Sanderson', asin: 'B001IGFHW6' }],
    narrators: ['Michael Kramer', 'Kate Reading'],
    series: [{ name: 'The Stormlight Archive', position: 1 }],
    description: 'An epic fantasy novel',
    coverUrl: 'https://example.com/cover.jpg',
    duration: 2700,
    genres: ['Fantasy', 'Epic', 'Adventure'],
    ...overrides,
  };
}

export function createMockAuthorMetadata(overrides?: Partial<AuthorMetadata>): AuthorMetadata {
  return {
    asin: 'B001IGFHW6',
    name: 'Brandon Sanderson',
    description: 'American author of epic fantasy',
    imageUrl: 'https://example.com/author.jpg',
    genres: ['Fantasy', 'Science Fiction'],
    ...overrides,
  };
}
