import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { SearchResult } from '../../core/index.js';
import type { BlacklistService } from './blacklist.service.js';
import type { SettingsService } from './settings.service.js';
import type * as NetworkServiceModule from '../../core/utils/network-service.js';
import { postProcessSearchResults } from './search-pipeline.js';

// Mock the network boundary (not enrichUsenetLanguages itself) so the real
// enrichment + filterByLanguage pipeline runs end-to-end. This is the wire-up
// evidence the spec for #1142 calls for.
const mockDispatcher = { close: vi.fn().mockResolvedValue(undefined) };

vi.mock('../../core/utils/network-service.js', async (importActual) => {
  const actual = await importActual<typeof NetworkServiceModule>();
  return {
    ...actual,
    fetchWithSsrfRedirect: vi.fn(),
    createSsrfSafeDispatcher: vi.fn(() => mockDispatcher),
  };
});

import { fetchWithSsrfRedirect } from '../../core/utils/network-service.js';
const mockFetchWithSsrfRedirect = vi.mocked(fetchWithSsrfRedirect);

function createMockLogger(): FastifyBaseLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    silent: vi.fn(),
    level: 'info',
  } as unknown as FastifyBaseLogger;
}

function createMockBlacklist(): BlacklistService {
  return {
    getBlacklistedIdentifiers: vi.fn().mockResolvedValue({
      blacklistedHashes: new Set<string>(),
      blacklistedGuids: new Set<string>(),
    }),
  } as unknown as BlacklistService;
}

function createMockSettings(allowedLanguages: string[]): SettingsService {
  const qualityDefaults = {
    grabFloor: 0,
    minSeeders: 0,
    protocolPreference: 'none',
    maxDownloadSize: 0,
    rejectWords: '',
    requiredWords: '',
  };
  const metadataDefaults = { audibleRegion: 'us', languages: allowedLanguages };
  return {
    get: vi.fn().mockImplementation((cat: string) => {
      if (cat === 'quality') return Promise.resolve(qualityDefaults);
      if (cat === 'metadata') return Promise.resolve(metadataDefaults);
      return Promise.resolve({});
    }),
  } as unknown as SettingsService;
}

describe('#1142 postProcessSearchResults — Fairy Tale UAT (title-based language detection)', () => {
  beforeEach(() => {
    mockFetchWithSsrfRedirect.mockReset();
  });

  it('drops the Fairy Tale (Ungekrzt) release with language-mismatch when allowed languages = [english]', async () => {
    // Real-world failure shape: NZB meta name lacks any German marker, newsgroup
    // is generic, but the user-facing title carries the (Ungekrzt) marker.
    const nzbXml = `<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
      <head><meta type="name">Fairy.Tale.part01.rar</meta></head>
      <file poster="t" date="1" subject="Fairy.Tale.part01.rar">
        <groups><group>alt.binaries.audiobooks</group></groups>
        <segments><segment bytes="1" number="1">id@e</segment></segments>
      </file>
    </nzb>`;
    mockFetchWithSsrfRedirect.mockResolvedValueOnce(
      new Response(nzbXml, { status: 200 }),
    );

    const log = createMockLogger();
    const blacklist = createMockBlacklist();
    const settings = createMockSettings(['english']);

    const fairyTale: SearchResult = {
      title: 'Stephen King – Fairy Tale (Ungekrzt)',
      protocol: 'usenet',
      indexer: 'NZBgeek',
      downloadUrl: 'http://nzb.test/fairytale',
      newsgroup: 'alt.binaries.audiobooks',
      size: 1.57 * 1024 * 1024 * 1024,
    };

    const output = await postProcessSearchResults([fairyTale], 3600, blacklist, settings, log);

    expect(output.results).toHaveLength(0);
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Stephen King – Fairy Tale (Ungekrzt)',
        reason: 'language-mismatch',
        detectedLanguage: 'german',
        dropped: true,
      }),
      'Language filter dropped result',
    );
    // Negative assertion: must NOT fall into the language-undetermined branch.
    expect(log.debug).not.toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Stephen King – Fairy Tale (Ungekrzt)',
        reason: 'language-undetermined',
      }),
      expect.any(String),
    );
  });
});
