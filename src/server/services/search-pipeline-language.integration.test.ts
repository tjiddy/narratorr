import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { SearchResult } from '../../core/index.js';
import type { BlacklistService } from './blacklist.service.js';
import type { SettingsService } from './settings.service.js';
import type { IndexerService } from './indexer.service.js';
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
import { enrichmentCache } from '../utils/enrichment-cache.js';
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

function createMockIndexerService(apiUrls: string[] = []): IndexerService {
  const hostPort = new Set<string>();
  const hostname = new Set<string>();
  for (const url of apiUrls) {
    try {
      const parsed = new URL(url);
      const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
      hostPort.add(`${parsed.hostname.toLowerCase()}:${port}`);
      hostname.add(parsed.hostname.toLowerCase());
    } catch { /* skip un-parseable */ }
  }
  return {
    getLanAllowlist: vi.fn().mockResolvedValue({ hostPort, hostname }),
  } as unknown as IndexerService;
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
    // The enrichment cache is a process-wide singleton; clear it so a release
    // re-used across tests (same downloadUrl) is re-fetched, not served from a
    // prior test's cached outcome (#1315).
    enrichmentCache.clear();
  });

  it('drops all three Fairy Tale German releases with language-mismatch when NZB fetch fails — #1148 UAT', async () => {
    // Real UAT reproduction: NZB fetch fails (SSRF block on Prowlarr URL — #1149).
    // Three German releases: naked-drop, lowercase mojibake, uppercase mojibake.
    // All three must end up with language === 'german' via title fallback and
    // drop with reason: 'language-mismatch' (not 'language-undetermined').
    mockFetchWithSsrfRedirect.mockRejectedValue(
      new Error('Refused: address 192.168.0.22 is in the blocked range'),
    );

    const log = createMockLogger();
    const blacklist = createMockBlacklist();
    const settings = createMockSettings(['english']);

    const releases: SearchResult[] = [
      {
        title: 'Stephen King - Fairy Tale (Ungekrzt)',
        protocol: 'usenet',
        indexer: 'NZBgeek',
        downloadUrl: 'http://nzb.test/1',
        newsgroup: 'alt.binaries.audiobooks',
        size: 1.57 * 1024 * 1024 * 1024,
      },
      {
        title: 'Stephen King - Fairy Tale (ungekÃ¼rzt)',
        protocol: 'usenet',
        indexer: 'NZBgeek',
        downloadUrl: 'http://nzb.test/2',
        newsgroup: 'alt.binaries.audiobooks',
        size: 1.57 * 1024 * 1024 * 1024,
      },
      {
        title: 'Stephen King - Fairy Tale (UngekÃ¼rzt)',
        protocol: 'usenet',
        indexer: 'NZBgeek',
        downloadUrl: 'http://nzb.test/3',
        newsgroup: 'alt.binaries.audiobooks',
        size: 1.57 * 1024 * 1024 * 1024,
      },
    ];

    const indexerService = createMockIndexerService(['http://192.168.0.22:9696/']);
    const output = await postProcessSearchResults(releases, 3600, blacklist, settings, indexerService, log);

    expect(output.results).toHaveLength(0);
    for (const release of releases) {
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          title: release.title,
          reason: 'language-mismatch',
          detectedLanguage: 'german',
          dropped: true,
        }),
        'Language filter dropped result',
      );
      expect(log.debug).not.toHaveBeenCalledWith(
        expect.objectContaining({
          title: release.title,
          reason: 'language-undetermined',
        }),
        expect.any(String),
      );
    }
  });

  it('invokes IndexerService.getLanAllowlist exactly once per postProcessSearchResults call (#1149)', async () => {
    // The LAN allowlist is the shared cost: one DB read per search, not one per release.
    const nzbXml = `<nzb><file poster="t" date="1" subject="t"><groups><group>alt.binaries.audiobooks</group></groups><segments><segment bytes="1" number="1">id@e</segment></segments></file></nzb>`;
    mockFetchWithSsrfRedirect.mockResolvedValue(new Response(nzbXml, { status: 200 }));

    const log = createMockLogger();
    const blacklist = createMockBlacklist();
    const settings = createMockSettings(['english']);
    const indexerService = createMockIndexerService(['http://192.168.0.22:9696/']);

    const releases: SearchResult[] = [
      { title: 'A', protocol: 'usenet', indexer: 'NZBgeek', downloadUrl: 'http://192.168.0.22:9696/1', newsgroup: 'alt.binaries.audiobooks' },
      { title: 'B', protocol: 'usenet', indexer: 'NZBgeek', downloadUrl: 'http://192.168.0.22:9696/2', newsgroup: 'alt.binaries.audiobooks' },
      { title: 'C', protocol: 'usenet', indexer: 'NZBgeek', downloadUrl: 'http://192.168.0.22:9696/3', newsgroup: 'alt.binaries.audiobooks' },
    ];

    await postProcessSearchResults(releases, 3600, blacklist, settings, indexerService, log);

    expect(indexerService.getLanAllowlist).toHaveBeenCalledTimes(1);
  });

  it('with no indexers configured (empty allowlist), the fetch still SSRF-refuses LAN URLs and the title fallback runs', async () => {
    // Regression guard: empty allowlist must not degrade to permissive — the
    // SSRF helper still refuses the LAN URL, and language detection falls
    // back to the title-after-fetch-fail signal (#1148).
    mockFetchWithSsrfRedirect.mockRejectedValue(
      new Error('Refused: address 192.168.0.22 is in the blocked range'),
    );

    const log = createMockLogger();
    const blacklist = createMockBlacklist();
    const settings = createMockSettings(['english']);
    const indexerService = createMockIndexerService();

    const release: SearchResult = {
      title: 'Stephen King - Fairy Tale (Ungekrzt)',
      protocol: 'usenet',
      indexer: 'NZBgeek',
      downloadUrl: 'http://192.168.0.22:9696/nzb',
      newsgroup: 'alt.binaries.audiobooks',
      size: 1.57 * 1024 * 1024 * 1024,
    };

    const output = await postProcessSearchResults([release], 3600, blacklist, settings, indexerService, log);

    expect(output.results).toHaveLength(0);
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Stephen King - Fairy Tale (Ungekrzt)',
        reason: 'language-mismatch',
        detectedLanguage: 'german',
      }),
      'Language filter dropped result',
    );
  });

  it('with the allowlist supplied, the same Fairy Tale UAT release enriches via the real NZB body and is dropped via the primary signal (#1149)', async () => {
    // Companion to the #1148 UAT case above: with the allowlist, the NZB fetch
    // succeeds against the LAN-IP Prowlarr, the body is parsed, and the
    // German language is set from newsgroup/nzbName — not via the catch-path
    // title fallback.
    const nzbXml = `<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
      <head><meta type="name">Fairy.Tale.German.Hoerbuch.rar</meta></head>
      <file poster="t" date="1" subject="Fairy.Tale.German.Hoerbuch.rar">
        <groups><group>alt.binaries.audiobooks</group></groups>
        <segments><segment bytes="1" number="1">id@e</segment></segments>
      </file>
    </nzb>`;
    mockFetchWithSsrfRedirect.mockResolvedValueOnce(new Response(nzbXml, { status: 200 }));

    const log = createMockLogger();
    const blacklist = createMockBlacklist();
    const settings = createMockSettings(['english']);
    const indexerService = createMockIndexerService(['http://192.168.0.22:9696/']);

    const release: SearchResult = {
      title: 'Stephen King – Fairy Tale (Hörbuch)',
      protocol: 'usenet',
      indexer: 'NZBgeek',
      downloadUrl: 'http://192.168.0.22:9696/nzb',
      newsgroup: 'alt.binaries.audiobooks',
      size: 1.57 * 1024 * 1024 * 1024,
    };

    const output = await postProcessSearchResults([release], 3600, blacklist, settings, indexerService, log);

    expect(output.results).toHaveLength(0);
    expect(release.nzbName).toBe('Fairy.Tale.German.Hoerbuch.rar');
    expect(release.language).toBe('german');
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

    const indexerService = createMockIndexerService();
    const output = await postProcessSearchResults([fairyTale], 3600, blacklist, settings, indexerService, log);

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
