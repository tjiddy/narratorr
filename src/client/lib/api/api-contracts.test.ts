/**
 * API wrapper contract tests — verifies each API method calls fetchApi
 * with the correct URL path, HTTP method, and request body shape.
 *
 * These are contract tests, not integration tests. They catch drift
 * in URL paths, HTTP methods, or body shapes without needing a server.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetchApi = vi.fn().mockResolvedValue({});

vi.mock('./client.js', () => ({
  fetchApi: (...args: unknown[]) => mockFetchApi(...args),
  ApiError: class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, body: unknown) {
      super(`HTTP ${status}`);
      this.status = status;
      this.body = body;
    }
  },
}));

import { activityApi } from './activity.js';
import { authApi } from './auth.js';
import { blacklistApi } from './blacklist.js';
import { booksApi } from './books.js';
import { downloadClientsApi } from './download-clients.js';
import { filesystemApi } from './filesystem.js';
import { indexersApi } from './indexers.js';
import { libraryScanApi } from './library-scan.js';
import { notifiersApi } from './notifiers.js';
import { prowlarrApi } from './prowlarr.js';
import { remotePathMappingsApi } from './remote-path-mappings.js';
import { searchApi } from './search.js';
import { settingsApi } from './settings.js';
import { systemApi } from './system.js';

beforeEach(() => {
  mockFetchApi.mockClear();
  mockFetchApi.mockResolvedValue({});
});

describe('activityApi', () => {
  it('getActivity → GET /activity', async () => {
    await activityApi.getActivity();
    expect(mockFetchApi).toHaveBeenCalledWith('/activity');
  });

  it('getActiveDownloads → GET /activity/active', async () => {
    await activityApi.getActiveDownloads();
    expect(mockFetchApi).toHaveBeenCalledWith('/activity/active');
  });

  it('getActivityCounts → GET /activity/counts', async () => {
    await activityApi.getActivityCounts();
    expect(mockFetchApi).toHaveBeenCalledWith('/activity/counts');
  });

  it('cancelDownload → DELETE /activity/:id', async () => {
    await activityApi.cancelDownload(5);
    expect(mockFetchApi).toHaveBeenCalledWith('/activity/5', expect.objectContaining({ method: 'DELETE' }));
  });

  it('retryDownload → POST /activity/:id/retry', async () => {
    await activityApi.retryDownload(3);
    expect(mockFetchApi).toHaveBeenCalledWith('/activity/3/retry', expect.objectContaining({ method: 'POST' }));
  });
});

describe('authApi', () => {
  it('getStatus → GET /auth/status', async () => {
    await authApi.getStatus();
    expect(mockFetchApi).toHaveBeenCalledWith('/auth/status');
  });

  it('login → POST /auth/login with credentials', async () => {
    await authApi.login('admin', 'pass123');
    expect(mockFetchApi).toHaveBeenCalledWith('/auth/login', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'pass123' }),
    }));
  });

  it('logout → POST /auth/logout', async () => {
    await authApi.logout();
    expect(mockFetchApi).toHaveBeenCalledWith('/auth/logout', expect.objectContaining({ method: 'POST' }));
  });

  it('setup → POST /auth/setup with credentials', async () => {
    await authApi.setup('newuser', 'newpass');
    expect(mockFetchApi).toHaveBeenCalledWith('/auth/setup', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ username: 'newuser', password: 'newpass' }),
    }));
  });

  it('getAuthConfig → GET /auth/config', async () => {
    await authApi.getAuthConfig();
    expect(mockFetchApi).toHaveBeenCalledWith('/auth/config');
  });

  it('updateAuthConfig → PUT /auth/config with data', async () => {
    await authApi.updateAuthConfig({ mode: 'forms', localBypass: true });
    expect(mockFetchApi).toHaveBeenCalledWith('/auth/config', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ mode: 'forms', localBypass: true }),
    }));
  });

  it('changePassword → PUT /auth/password with passwords', async () => {
    await authApi.changePassword('old', 'new');
    expect(mockFetchApi).toHaveBeenCalledWith('/auth/password', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ currentPassword: 'old', newPassword: 'new' }),
    }));
  });

  it('changePassword with new username includes newUsername', async () => {
    await authApi.changePassword('old', 'new', 'newadmin');
    expect(mockFetchApi).toHaveBeenCalledWith('/auth/password', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ currentPassword: 'old', newPassword: 'new', newUsername: 'newadmin' }),
    }));
  });

  it('regenerateApiKey → POST /auth/api-key/regenerate', async () => {
    await authApi.regenerateApiKey();
    expect(mockFetchApi).toHaveBeenCalledWith('/auth/api-key/regenerate', expect.objectContaining({ method: 'POST' }));
  });
});

describe('blacklistApi', () => {
  it('getBlacklist → GET /blacklist', async () => {
    await blacklistApi.getBlacklist();
    expect(mockFetchApi).toHaveBeenCalledWith('/blacklist');
  });

  it('addToBlacklist → POST /blacklist with entry', async () => {
    const entry = { infoHash: 'abc', title: 'Bad Book', reason: 'spam' as const };
    await blacklistApi.addToBlacklist(entry);
    expect(mockFetchApi).toHaveBeenCalledWith('/blacklist', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(entry),
    }));
  });

  it('removeFromBlacklist → DELETE /blacklist/:id', async () => {
    await blacklistApi.removeFromBlacklist(7);
    expect(mockFetchApi).toHaveBeenCalledWith('/blacklist/7', expect.objectContaining({ method: 'DELETE' }));
  });
});

describe('booksApi', () => {
  it('getBooks → GET /books', async () => {
    await booksApi.getBooks();
    expect(mockFetchApi).toHaveBeenCalledWith('/books');
  });

  it('getBooks with status filter → GET /books?status=...', async () => {
    await booksApi.getBooks('missing');
    expect(mockFetchApi).toHaveBeenCalledWith('/books?status=missing');
  });

  it('getBookById → GET /books/:id', async () => {
    await booksApi.getBookById(42);
    expect(mockFetchApi).toHaveBeenCalledWith('/books/42');
  });

  it('addBook → POST /books with payload', async () => {
    const data = { title: 'Test Book', authorName: 'Author' };
    await booksApi.addBook(data);
    expect(mockFetchApi).toHaveBeenCalledWith('/books', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(data),
    }));
  });

  it('deleteBook → DELETE /books/:id', async () => {
    await booksApi.deleteBook(5);
    expect(mockFetchApi).toHaveBeenCalledWith('/books/5', expect.objectContaining({ method: 'DELETE' }));
  });

  it('deleteBook with deleteFiles → DELETE /books/:id?deleteFiles=true', async () => {
    await booksApi.deleteBook(5, { deleteFiles: true });
    expect(mockFetchApi).toHaveBeenCalledWith('/books/5?deleteFiles=true', expect.objectContaining({ method: 'DELETE' }));
  });

  it('deleteMissingBooks → DELETE /books/missing', async () => {
    await booksApi.deleteMissingBooks();
    expect(mockFetchApi).toHaveBeenCalledWith('/books/missing', expect.objectContaining({ method: 'DELETE' }));
  });

  it('getBookFiles → GET /books/:id/files', async () => {
    await booksApi.getBookFiles(10);
    expect(mockFetchApi).toHaveBeenCalledWith('/books/10/files');
  });

  it('searchMetadata → GET /metadata/search?q=...', async () => {
    await booksApi.searchMetadata('tolkien');
    expect(mockFetchApi).toHaveBeenCalledWith('/metadata/search?q=tolkien');
  });

  it('searchMetadata encodes query', async () => {
    await booksApi.searchMetadata('hello world');
    expect(mockFetchApi).toHaveBeenCalledWith('/metadata/search?q=hello%20world');
  });

  it('updateBook → PUT /books/:id with data', async () => {
    const data = { title: 'Updated' };
    await booksApi.updateBook(3, data);
    expect(mockFetchApi).toHaveBeenCalledWith('/books/3', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify(data),
    }));
  });

  it('renameBook → POST /books/:id/rename', async () => {
    await booksApi.renameBook(8);
    expect(mockFetchApi).toHaveBeenCalledWith('/books/8/rename', expect.objectContaining({ method: 'POST' }));
  });
});

describe('downloadClientsApi', () => {
  it('getClients → GET /download-clients', async () => {
    await downloadClientsApi.getClients();
    expect(mockFetchApi).toHaveBeenCalledWith('/download-clients');
  });

  it('createClient → POST /download-clients with data', async () => {
    const data = { name: 'qBit', type: 'qbittorrent' as const, enabled: true, priority: 50, settings: {} };
    await downloadClientsApi.createClient(data);
    expect(mockFetchApi).toHaveBeenCalledWith('/download-clients', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(data),
    }));
  });

  it('updateClient → PUT /download-clients/:id', async () => {
    const data = { name: 'Updated' };
    await downloadClientsApi.updateClient(1, data);
    expect(mockFetchApi).toHaveBeenCalledWith('/download-clients/1', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify(data),
    }));
  });

  it('deleteClient → DELETE /download-clients/:id', async () => {
    await downloadClientsApi.deleteClient(2);
    expect(mockFetchApi).toHaveBeenCalledWith('/download-clients/2', expect.objectContaining({ method: 'DELETE' }));
  });

  it('testClient → POST /download-clients/:id/test', async () => {
    await downloadClientsApi.testClient(3);
    expect(mockFetchApi).toHaveBeenCalledWith('/download-clients/3/test', expect.objectContaining({ method: 'POST' }));
  });

  it('testClientConfig → POST /download-clients/test with data', async () => {
    const data = { name: 'Test', type: 'qbittorrent' as const, enabled: true, priority: 50, settings: { host: 'localhost' } };
    await downloadClientsApi.testClientConfig(data);
    expect(mockFetchApi).toHaveBeenCalledWith('/download-clients/test', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(data),
    }));
  });

  it('getClientCategories → POST /download-clients/:id/categories', async () => {
    await downloadClientsApi.getClientCategories(4);
    expect(mockFetchApi).toHaveBeenCalledWith('/download-clients/4/categories', expect.objectContaining({ method: 'POST' }));
  });

  it('getClientCategoriesFromConfig → POST /download-clients/categories with data', async () => {
    const data = { name: 'Test', type: 'qbittorrent' as const, enabled: true, priority: 50, settings: {} };
    await downloadClientsApi.getClientCategoriesFromConfig(data);
    expect(mockFetchApi).toHaveBeenCalledWith('/download-clients/categories', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(data),
    }));
  });
});

describe('filesystemApi', () => {
  it('browseDirectory → GET /filesystem/browse?path=...', async () => {
    await filesystemApi.browseDirectory('/home/user');
    expect(mockFetchApi).toHaveBeenCalledWith('/filesystem/browse?path=%2Fhome%2Fuser');
  });
});

describe('indexersApi', () => {
  it('getIndexers → GET /indexers', async () => {
    await indexersApi.getIndexers();
    expect(mockFetchApi).toHaveBeenCalledWith('/indexers');
  });

  it('createIndexer → POST /indexers with data', async () => {
    const data = { name: 'NZBGeek', type: 'newznab' as const, enabled: true, priority: 50, settings: {} };
    await indexersApi.createIndexer(data);
    expect(mockFetchApi).toHaveBeenCalledWith('/indexers', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(data),
    }));
  });

  it('deleteIndexer → DELETE /indexers/:id', async () => {
    await indexersApi.deleteIndexer(5);
    expect(mockFetchApi).toHaveBeenCalledWith('/indexers/5', expect.objectContaining({ method: 'DELETE' }));
  });

  it('testIndexer → POST /indexers/:id/test', async () => {
    await indexersApi.testIndexer(2);
    expect(mockFetchApi).toHaveBeenCalledWith('/indexers/2/test', expect.objectContaining({ method: 'POST' }));
  });

  it('testIndexerConfig → POST /indexers/test with data', async () => {
    const data = { name: 'Test', type: 'abb' as const, enabled: true, priority: 50, settings: {} };
    await indexersApi.testIndexerConfig(data);
    expect(mockFetchApi).toHaveBeenCalledWith('/indexers/test', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(data),
    }));
  });
});

describe('libraryScanApi', () => {
  it('rescanLibrary → POST /library/rescan', async () => {
    await libraryScanApi.rescanLibrary();
    expect(mockFetchApi).toHaveBeenCalledWith('/library/rescan', expect.objectContaining({ method: 'POST' }));
  });

  it('scanSingleBook → POST /library/import/scan-single with path', async () => {
    await libraryScanApi.scanSingleBook('/audio/book');
    expect(mockFetchApi).toHaveBeenCalledWith('/library/import/scan-single', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ path: '/audio/book' }),
    }));
  });

  it('importSingleBook → POST /library/import/single with item', async () => {
    const item = { path: '/audio/book', title: 'Book', authorName: 'Author' };
    await libraryScanApi.importSingleBook(item);
    expect(mockFetchApi).toHaveBeenCalledWith('/library/import/single', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(item),
    }));
  });

  it('scanDirectory → POST /library/import/scan with path', async () => {
    await libraryScanApi.scanDirectory('/audio');
    expect(mockFetchApi).toHaveBeenCalledWith('/library/import/scan', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ path: '/audio' }),
    }));
  });

  it('confirmImport → POST /library/import/confirm with books and mode', async () => {
    const books = [{ path: '/audio/book', title: 'Book' }];
    await libraryScanApi.confirmImport(books, 'copy');
    expect(mockFetchApi).toHaveBeenCalledWith('/library/import/confirm', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ books, mode: 'copy' }),
    }));
  });

  it('startMatchJob → POST /library/import/match with candidates', async () => {
    const books = [{ path: '/audio', title: 'Book', author: 'Auth' }];
    await libraryScanApi.startMatchJob(books);
    expect(mockFetchApi).toHaveBeenCalledWith('/library/import/match', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ books }),
    }));
  });

  it('getMatchJob → GET /library/import/match/:jobId', async () => {
    await libraryScanApi.getMatchJob('abc123');
    expect(mockFetchApi).toHaveBeenCalledWith('/library/import/match/abc123');
  });

  it('cancelMatchJob → DELETE /library/import/match/:jobId', async () => {
    await libraryScanApi.cancelMatchJob('abc123');
    expect(mockFetchApi).toHaveBeenCalledWith('/library/import/match/abc123', expect.objectContaining({ method: 'DELETE' }));
  });
});

describe('notifiersApi', () => {
  it('getNotifiers → GET /notifiers', async () => {
    await notifiersApi.getNotifiers();
    expect(mockFetchApi).toHaveBeenCalledWith('/notifiers');
  });

  it('createNotifier → POST /notifiers with data', async () => {
    const data = { name: 'Discord', type: 'discord' as const, enabled: true, events: ['on_grab'], settings: {} };
    await notifiersApi.createNotifier(data);
    expect(mockFetchApi).toHaveBeenCalledWith('/notifiers', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(data),
    }));
  });

  it('deleteNotifier → DELETE /notifiers/:id', async () => {
    await notifiersApi.deleteNotifier(3);
    expect(mockFetchApi).toHaveBeenCalledWith('/notifiers/3', expect.objectContaining({ method: 'DELETE' }));
  });

  it('testNotifier → POST /notifiers/:id/test', async () => {
    await notifiersApi.testNotifier(1);
    expect(mockFetchApi).toHaveBeenCalledWith('/notifiers/1/test', expect.objectContaining({ method: 'POST' }));
  });

  it('testNotifierConfig → POST /notifiers/test with data', async () => {
    const data = { name: 'Test', type: 'webhook' as const, enabled: true, events: [], settings: {} };
    await notifiersApi.testNotifierConfig(data);
    expect(mockFetchApi).toHaveBeenCalledWith('/notifiers/test', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(data),
    }));
  });
});

describe('prowlarrApi', () => {
  it('testConnection → POST /prowlarr/test with url and apiKey', async () => {
    await prowlarrApi.testConnection('https://prowlarr.local', 'key123');
    expect(mockFetchApi).toHaveBeenCalledWith('/prowlarr/test', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ url: 'https://prowlarr.local', apiKey: 'key123' }),
    }));
  });

  it('getConfig → GET /prowlarr/config', async () => {
    await prowlarrApi.getConfig();
    expect(mockFetchApi).toHaveBeenCalledWith('/prowlarr/config');
  });

  it('saveConfig → PUT /prowlarr/config with config', async () => {
    const config = { url: 'https://prowlarr.local', apiKey: 'key', syncMode: 'addOnly' as const, categories: [3030] };
    await prowlarrApi.saveConfig(config);
    expect(mockFetchApi).toHaveBeenCalledWith('/prowlarr/config', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify(config),
    }));
  });

  it('preview → POST /prowlarr/preview', async () => {
    await prowlarrApi.preview();
    expect(mockFetchApi).toHaveBeenCalledWith('/prowlarr/preview', expect.objectContaining({ method: 'POST' }));
  });

  it('sync → POST /prowlarr/sync with request', async () => {
    const request = { items: [{ prowlarrId: 1, action: 'new', selected: true }] };
    await prowlarrApi.sync(request);
    expect(mockFetchApi).toHaveBeenCalledWith('/prowlarr/sync', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(request),
    }));
  });
});

describe('remotePathMappingsApi', () => {
  it('getMappings → GET /remote-path-mappings', async () => {
    await remotePathMappingsApi.getMappings();
    expect(mockFetchApi).toHaveBeenCalledWith('/remote-path-mappings');
  });

  it('getMappingsByClientId → GET /remote-path-mappings?downloadClientId=...', async () => {
    await remotePathMappingsApi.getMappingsByClientId(2);
    expect(mockFetchApi).toHaveBeenCalledWith('/remote-path-mappings?downloadClientId=2');
  });

  it('createMapping → POST /remote-path-mappings with data', async () => {
    const data = { downloadClientId: 1, remotePath: '/remote', localPath: '/local' };
    await remotePathMappingsApi.createMapping(data);
    expect(mockFetchApi).toHaveBeenCalledWith('/remote-path-mappings', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(data),
    }));
  });

  it('updateMapping → PUT /remote-path-mappings/:id with data', async () => {
    const data = { remotePath: '/new-remote' };
    await remotePathMappingsApi.updateMapping(5, data);
    expect(mockFetchApi).toHaveBeenCalledWith('/remote-path-mappings/5', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify(data),
    }));
  });

  it('deleteMapping → DELETE /remote-path-mappings/:id', async () => {
    await remotePathMappingsApi.deleteMapping(3);
    expect(mockFetchApi).toHaveBeenCalledWith('/remote-path-mappings/3', expect.objectContaining({ method: 'DELETE' }));
  });
});

describe('searchApi', () => {
  it('search → GET /search?q=... with query', async () => {
    await searchApi.search('tolkien');
    expect(mockFetchApi).toHaveBeenCalledWith('/search?q=tolkien');
  });

  it('search with context → GET /search?q=...&author=...&title=...', async () => {
    await searchApi.search('hobbit', { author: 'Tolkien', title: 'The Hobbit' });
    expect(mockFetchApi).toHaveBeenCalledWith(expect.stringContaining('/search?'));
    const url = mockFetchApi.mock.calls[0][0] as string;
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('q')).toBe('hobbit');
    expect(params.get('author')).toBe('Tolkien');
    expect(params.get('title')).toBe('The Hobbit');
  });

  it('grab → POST /search/grab with params', async () => {
    const params = { downloadUrl: 'https://example.com/dl', title: 'Book', protocol: 'torrent' as const, bookId: 1 };
    await searchApi.grab(params);
    expect(mockFetchApi).toHaveBeenCalledWith('/search/grab', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(params),
    }));
  });
});

describe('settingsApi', () => {
  it('getSettings → GET /settings', async () => {
    await settingsApi.getSettings();
    expect(mockFetchApi).toHaveBeenCalledWith('/settings');
  });

  it('updateSettings → PUT /settings with data', async () => {
    const data = { library: { path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{title}' } };
    await settingsApi.updateSettings(data);
    expect(mockFetchApi).toHaveBeenCalledWith('/settings', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify(data),
    }));
  });

  it('probeFfmpeg → POST /settings/ffmpeg-probe with path', async () => {
    await settingsApi.probeFfmpeg('/usr/bin/ffmpeg');
    expect(mockFetchApi).toHaveBeenCalledWith('/settings/ffmpeg-probe', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ path: '/usr/bin/ffmpeg' }),
    }));
  });
});

describe('systemApi', () => {
  it('getStatus → GET /system/status', async () => {
    await systemApi.getStatus();
    expect(mockFetchApi).toHaveBeenCalledWith('/system/status');
  });

  it('triggerSearch → POST /system/tasks/search', async () => {
    await systemApi.triggerSearch();
    expect(mockFetchApi).toHaveBeenCalledWith('/system/tasks/search', expect.objectContaining({ method: 'POST' }));
  });
});

// ============================================================================
// Response pass-through assertions
// Verifies wrapper methods return fetchApi's resolved value without transformation
// ============================================================================

describe('response pass-through', () => {
  it('activityApi.getActivity returns fetchApi response', async () => {
    const data = [{ id: 1, title: 'Test', status: 'downloading' }];
    mockFetchApi.mockResolvedValue(data);
    const result = await activityApi.getActivity();
    expect(result).toBe(data);
  });

  it('authApi.login returns fetchApi response', async () => {
    const data = { success: true };
    mockFetchApi.mockResolvedValue(data);
    const result = await authApi.login('user', 'pass');
    expect(result).toBe(data);
  });

  it('blacklistApi.addToBlacklist returns fetchApi response', async () => {
    const data = { id: 1, infoHash: 'abc', title: 'Book', blacklistedAt: '2026-01-01' };
    mockFetchApi.mockResolvedValue(data);
    const result = await blacklistApi.addToBlacklist({ infoHash: 'abc', title: 'Book' });
    expect(result).toBe(data);
  });

  it('booksApi.getBooks returns fetchApi response', async () => {
    const data = [{ id: 1, title: 'Book' }];
    mockFetchApi.mockResolvedValue(data);
    const result = await booksApi.getBooks();
    expect(result).toBe(data);
  });

  it('downloadClientsApi.createClient returns fetchApi response', async () => {
    const data = { id: 1, name: 'qBit', type: 'qbittorrent' };
    mockFetchApi.mockResolvedValue(data);
    const result = await downloadClientsApi.createClient({ name: 'qBit', type: 'qbittorrent', enabled: true, priority: 50, settings: {} });
    expect(result).toBe(data);
  });

  it('filesystemApi.browseDirectory returns fetchApi response', async () => {
    const data = { dirs: ['/home'], parent: '/' };
    mockFetchApi.mockResolvedValue(data);
    const result = await filesystemApi.browseDirectory('/');
    expect(result).toBe(data);
  });

  it('indexersApi.testIndexerConfig returns fetchApi response', async () => {
    const data = { success: true };
    mockFetchApi.mockResolvedValue(data);
    const result = await indexersApi.testIndexerConfig({ name: 'T', type: 'abb', enabled: true, priority: 50, settings: {} });
    expect(result).toBe(data);
  });

  it('libraryScanApi.scanDirectory returns fetchApi response', async () => {
    const data = { discoveries: [], totalFolders: 0, skippedDuplicates: 0 };
    mockFetchApi.mockResolvedValue(data);
    const result = await libraryScanApi.scanDirectory('/audio');
    expect(result).toBe(data);
  });

  it('notifiersApi.getNotifiers returns fetchApi response', async () => {
    const data = [{ id: 1, name: 'Discord' }];
    mockFetchApi.mockResolvedValue(data);
    const result = await notifiersApi.getNotifiers();
    expect(result).toBe(data);
  });

  it('prowlarrApi.preview returns fetchApi response', async () => {
    const data = [{ action: 'new', name: 'NZBGeek' }];
    mockFetchApi.mockResolvedValue(data);
    const result = await prowlarrApi.preview();
    expect(result).toBe(data);
  });

  it('remotePathMappingsApi.getMappings returns fetchApi response', async () => {
    const data = [{ id: 1, remotePath: '/r', localPath: '/l' }];
    mockFetchApi.mockResolvedValue(data);
    const result = await remotePathMappingsApi.getMappings();
    expect(result).toBe(data);
  });

  it('searchApi.search returns fetchApi response', async () => {
    const data = { results: [], durationUnknown: false, unsupportedResults: { count: 0, titles: [] } };
    mockFetchApi.mockResolvedValue(data);
    const result = await searchApi.search('test');
    expect(result).toBe(data);
  });

  it('settingsApi.getSettings returns fetchApi response', async () => {
    const data = { library: { path: '/audio' } };
    mockFetchApi.mockResolvedValue(data);
    const result = await settingsApi.getSettings();
    expect(result).toBe(data);
  });

  it('systemApi.getStatus returns fetchApi response', async () => {
    const data = { version: '1.0', status: 'ok' };
    mockFetchApi.mockResolvedValue(data);
    const result = await systemApi.getStatus();
    expect(result).toBe(data);
  });
});
