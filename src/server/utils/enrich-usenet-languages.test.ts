import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { SearchResult } from '@core/indexers/types.js';
import type * as NetworkServiceModule from '@core/utils/network-service.js';
import { BoundedSemaphore } from '@core/utils/bounded-semaphore.js';
import { enrichUsenetLanguages } from './enrich-usenet-languages.js';

const mockDispatcher = { close: vi.fn().mockResolvedValue(undefined) };

vi.mock('@core/utils/network-service.js', async (importActual) => {
  const actual = await importActual<typeof NetworkServiceModule>();
  return {
    ...actual,
    fetchWithSsrfRedirect: vi.fn(),
    createSsrfSafeDispatcher: vi.fn(() => mockDispatcher),
  };
});

import { fetchWithSsrfRedirect, createSsrfSafeDispatcher } from '@core/utils/network-service.js';
import { enrichmentCache } from './enrichment-cache.js';
const mockFetchWithSsrfRedirect = vi.mocked(fetchWithSsrfRedirect);
const mockCreateSsrfSafeDispatcher = vi.mocked(createSsrfSafeDispatcher);

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

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    title: 'Test Book',
    protocol: 'torrent',
    indexer: 'test',
    seeders: 10,
    size: 500 * 1024 * 1024,
    downloadUrl: 'magnet:?xt=urn:btih:aaa',
    ...overrides,
  };
}

describe('enrichUsenetLanguages', () => {
  let logger: FastifyBaseLogger;

  beforeEach(() => {
    logger = createMockLogger();
    mockFetchWithSsrfRedirect.mockReset();
    // The process-wide cache must start cold for fetch-count assertions.
    enrichmentCache.clear();
  });

  describe('newsgroup short-circuit', () => {
    it('detects language from existing newsgroup field without NZB fetch', async () => {
      const results = [
        makeResult({ protocol: 'usenet', newsgroup: 'alt.binaries.german.hoerbuecher', downloadUrl: 'http://nzb.test/1' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.language).toBe('german');
      expect(mockFetchWithSsrfRedirect).not.toHaveBeenCalled();
    });

    it('sets language to "german" from newsgroup alt.binaries.german.hoerbuecher without fetch', async () => {
      const results = [
        makeResult({ protocol: 'usenet', newsgroup: 'alt.binaries.german.hoerbuecher', downloadUrl: 'http://nzb.test/1' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.language).toBe('german');
    });

    it('falls through to NZB fetch for generic newsgroup (alt.binaries.audiobooks) and populates nzbName', async () => {
      const nzbXml = `<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
        <head><meta type="name">Stephen King-H?rbuch-Pack.part01.rar</meta></head>
        <file poster="test" date="123" subject="test">
          <groups><group>alt.binaries.audiobooks</group></groups>
          <segments><segment bytes="100" number="1">id@example</segment></segments>
        </file>
      </nzb>`;
      mockFetchWithSsrfRedirect.mockResolvedValueOnce(
        new Response(nzbXml, { status: 200 }),
      );

      const results = [
        makeResult({ protocol: 'usenet', newsgroup: 'alt.binaries.mp3.audiobooks', downloadUrl: 'http://nzb.test/1' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledWith(
        'http://nzb.test/1',
        expect.objectContaining({ dispatcher: mockDispatcher, timeoutMs: 5000 }),
      );
      expect(results[0]!.nzbName).toBe('Stephen King-H?rbuch-Pack.part01.rar');
      expect(results[0]!.language).toBe('german');
    });

    it('fetches NZB when newsgroup is absent and downloadUrl is present', async () => {
      const nzbXml = `<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
        <file poster="test" date="123" subject="test">
          <groups><group>alt.binaries.french</group></groups>
          <segments><segment bytes="100" number="1">id@example</segment></segments>
        </file>
      </nzb>`;
      mockFetchWithSsrfRedirect.mockResolvedValueOnce(
        new Response(nzbXml, { status: 200 }),
      );

      const results = [
        makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.language).toBe('french');
      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledTimes(1);
      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledWith(
        'http://nzb.test/1',
        expect.objectContaining({ dispatcher: mockDispatcher, timeoutMs: 5000 }),
      );
    });
  });

  describe('NZB fetch and language detection', () => {
    it('fetches NZB, extracts groups, detects language and sets on result', async () => {
      const nzbXml = `<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
        <file poster="test" date="123" subject="test">
          <groups><group>alt.binaries.sounds.mp3.german.hoerbuecher</group></groups>
          <segments><segment bytes="100" number="1">id@example</segment></segments>
        </file>
      </nzb>`;
      mockFetchWithSsrfRedirect.mockResolvedValueOnce(
        new Response(nzbXml, { status: 200 }),
      );

      const results = [
        makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.language).toBe('german');
    });

    it('skips results that already have language set', async () => {
      const results = [
        makeResult({ protocol: 'usenet', language: 'english', downloadUrl: 'http://nzb.test/1' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.language).toBe('english');
      expect(mockFetchWithSsrfRedirect).not.toHaveBeenCalled();
    });

    it('skips results without downloadUrl', async () => {
      const { downloadUrl: _downloadUrl, ...resultNoUrl } = makeResult({ protocol: 'usenet' });
      const results: SearchResult[] = [resultNoUrl];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.language).toBeUndefined();
      expect(mockFetchWithSsrfRedirect).not.toHaveBeenCalled();
    });

    it('skips torrent results regardless of language state', async () => {
      const results = [
        makeResult({ protocol: 'torrent', downloadUrl: 'magnet:?xt=urn:btih:aaa' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.language).toBeUndefined();
      expect(mockFetchWithSsrfRedirect).not.toHaveBeenCalled();
    });

    it('leaves language undefined when NZB fetch returns 404', async () => {
      mockFetchWithSsrfRedirect.mockResolvedValueOnce(
        new Response('Not Found', { status: 404 }),
      );

      const results = [
        makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.language).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Test Book', status: 404 }),
        expect.any(String),
      );
    });

    it('leaves language undefined when NZB fetch times out', async () => {
      mockFetchWithSsrfRedirect.mockRejectedValueOnce(new Error('The operation was aborted'));

      const results = [
        makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.language).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Test Book',
          error: expect.objectContaining({ message: 'The operation was aborted' }),
        }),
        expect.any(String),
      );
    });

    it('leaves language undefined when NZB contains invalid XML', async () => {
      mockFetchWithSsrfRedirect.mockResolvedValueOnce(
        new Response('not xml <><><', { status: 200 }),
      );

      const results = [
        makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.language).toBeUndefined();
    });

    it('leaves language undefined for NZB with only generic groups', async () => {
      const nzbXml = `<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
        <file poster="test" date="123" subject="test">
          <groups><group>alt.binaries.mp3.audiobooks</group></groups>
          <segments><segment bytes="100" number="1">id@example</segment></segments>
        </file>
      </nzb>`;
      mockFetchWithSsrfRedirect.mockResolvedValueOnce(
        new Response(nzbXml, { status: 200 }),
      );

      const results = [
        makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.language).toBeUndefined();
    });

    it('sets language to "german" for NZB with german.hoerbuecher group', async () => {
      const nzbXml = `<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
        <file poster="test" date="123" subject="test">
          <groups><group>alt.binaries.sounds.mp3.german.hoerbuecher</group></groups>
          <segments><segment bytes="100" number="1">id@example</segment></segments>
        </file>
      </nzb>`;
      mockFetchWithSsrfRedirect.mockResolvedValueOnce(
        new Response(nzbXml, { status: 200 }),
      );

      const results = [
        makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.language).toBe('german');
    });

    it('normalizes detected language through normalizeLanguage()', async () => {
      const results = [
        makeResult({ protocol: 'usenet', newsgroup: 'alt.binaries.FRENCH', downloadUrl: 'http://nzb.test/1' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.language).toBe('french');
    });
  });

  describe('concurrency and parallelism', () => {
    it('runs NZB fetches in parallel up to concurrency limit', async () => {
      let fetchCount = 0;
      mockFetchWithSsrfRedirect.mockImplementation(async () => {
        fetchCount++;
        await new Promise(r => setTimeout(r, 10));
        return new Response(`<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
          <file poster="t" date="1" subject="t">
            <groups><group>alt.binaries.german</group></groups>
            <segments><segment bytes="1" number="1">id@e</segment></segments>
          </file>
        </nzb>`, { status: 200 });
      });

      const results = Array.from({ length: 8 }, (_, i) =>
        makeResult({ protocol: 'usenet', downloadUrl: `http://nzb.test/${i}`, title: `Book ${i}` }),
      );

      await enrichUsenetLanguages(results, logger);

      expect(fetchCount).toBe(8);
      results.forEach(r => expect(r.language).toBe('german'));
    });

    it('queues excess fetches beyond concurrency limit', async () => {
      let concurrent = 0;
      let maxConcurrent = 0;
      mockFetchWithSsrfRedirect.mockImplementation(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise(r => setTimeout(r, 20));
        concurrent--;
        return new Response(`<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
          <file poster="t" date="1" subject="t">
            <groups><group>alt.binaries.german</group></groups>
            <segments><segment bytes="1" number="1">id@e</segment></segments>
          </file>
        </nzb>`, { status: 200 });
      });

      const results = Array.from({ length: 10 }, (_, i) =>
        makeResult({ protocol: 'usenet', downloadUrl: `http://nzb.test/${i}` }),
      );

      await enrichUsenetLanguages(results, logger);

      expect(maxConcurrent).toBeLessThanOrEqual(5);
      expect(maxConcurrent).toBeGreaterThan(1);
    });
  });

  describe('error isolation', () => {
    it('single NZB fetch failure does not prevent other results from being processed', async () => {
      const germanNzb = `<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
        <file poster="t" date="1" subject="t">
          <groups><group>alt.binaries.german</group></groups>
          <segments><segment bytes="1" number="1">id@e</segment></segments>
        </file>
      </nzb>`;
      mockFetchWithSsrfRedirect
        .mockRejectedValueOnce(new Error('Network failure'))
        .mockResolvedValueOnce(new Response(germanNzb, { status: 200 }));

      const results = [
        makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1', title: 'Failing' }),
        makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/2', title: 'Succeeding' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.language).toBeUndefined();
      expect(results[1]!.language).toBe('german');
    });

    it('NZB parsing failure on one result does not affect other results', async () => {
      const germanNzb = `<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
        <file poster="t" date="1" subject="t">
          <groups><group>alt.binaries.german</group></groups>
          <segments><segment bytes="1" number="1">id@e</segment></segments>
        </file>
      </nzb>`;
      mockFetchWithSsrfRedirect
        .mockResolvedValueOnce(new Response('garbage xml <><><', { status: 200 }))
        .mockResolvedValueOnce(new Response(germanNzb, { status: 200 }));

      const results = [
        makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1', title: 'BadXml' }),
        makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/2', title: 'GoodXml' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.language).toBeUndefined();
      expect(results[1]!.language).toBe('german');
    });
  });

  describe('metrics', () => {
    it('logs metrics: usenetResults, nzbFetched, languagesDetected, totalFetchMs', async () => {
      const nzbXml = `<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
        <file poster="t" date="1" subject="t">
          <groups><group>alt.binaries.german</group></groups>
          <segments><segment bytes="1" number="1">id@e</segment></segments>
        </file>
      </nzb>`;
      mockFetchWithSsrfRedirect.mockResolvedValueOnce(
        new Response(nzbXml, { status: 200 }),
      );

      const results = [
        makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' }),
        makeResult({ protocol: 'torrent' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          usenetResults: 1,
          nzbFetched: 1,
          languagesDetected: 1,
          totalFetchMs: expect.any(Number),
        }),
        expect.any(String),
      );
    });

    it('logs all-zero metrics when no Usenet results present', async () => {
      const results = [makeResult({ protocol: 'torrent' })];

      await enrichUsenetLanguages(results, logger);

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          usenetResults: 0,
          nzbFetched: 0,
          languagesDetected: 0,
        }),
        expect.any(String),
      );
    });

    it('logs correct counts when all NZB fetches fail', async () => {
      mockFetchWithSsrfRedirect.mockRejectedValue(new Error('fail'));

      const results = [
        makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' }),
        makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/2' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          usenetResults: 2,
          nzbFetched: 2,
          languagesDetected: 0,
        }),
        expect.any(String),
      );
    });

    it('logs correct counts for partial success', async () => {
      const germanNzb = `<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
        <file poster="t" date="1" subject="t">
          <groups><group>alt.binaries.german</group></groups>
          <segments><segment bytes="1" number="1">id@e</segment></segments>
        </file>
      </nzb>`;
      mockFetchWithSsrfRedirect
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce(new Response(germanNzb, { status: 200 }));

      const results = [
        makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' }),
        makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/2' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          usenetResults: 2,
          nzbFetched: 2,
          languagesDetected: 1,
        }),
        expect.any(String),
      );
    });

    it('emits warning per individual NZB fetch failure with result identifier', async () => {
      mockFetchWithSsrfRedirect.mockRejectedValueOnce(new Error('timeout'));

      const results = [
        makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1', title: 'My Audiobook' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'My Audiobook' }),
        expect.any(String),
      );
    });
  });

  describe('boundary values', () => {
    it('no-ops when zero Usenet results present', async () => {
      const results = [makeResult({ protocol: 'torrent' })];

      await enrichUsenetLanguages(results, logger);

      expect(mockFetchWithSsrfRedirect).not.toHaveBeenCalled();
    });

    it('skips all results when all already have language', async () => {
      const results = [
        makeResult({ protocol: 'usenet', language: 'english', downloadUrl: 'http://nzb.test/1' }),
        makeResult({ protocol: 'usenet', language: 'french', downloadUrl: 'http://nzb.test/2' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(mockFetchWithSsrfRedirect).not.toHaveBeenCalled();
      expect(results[0]!.language).toBe('english');
      expect(results[1]!.language).toBe('french');
    });
  });

  describe('NZB name extraction and language detection', () => {
    const nzbWithName = (name: string, group = 'alt.binaries.audiobooks') => `<nzb>
      <head><meta type="name">${name}</meta></head>
      <file poster="t" date="1" subject="fallback subject">
        <groups><group>${group}</group></groups>
        <segments><segment bytes="1" number="1">id@e</segment></segments>
      </file>
    </nzb>`;

    const nzbWithoutName = (group = 'alt.binaries.audiobooks') => `<nzb>
      <file poster="t" date="1" subject="File Subject Fallback">
        <groups><group>${group}</group></groups>
        <segments><segment bytes="1" number="1">id@e</segment></segments>
      </file>
    </nzb>`;

    it('sets nzbName on result from <meta type="name"> when NZB is fetched', async () => {
      mockFetchWithSsrfRedirect.mockResolvedValueOnce(
        new Response(nzbWithName('Stephen King-Pack.rar'), { status: 200 }),
      );
      const results = [makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' })];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.nzbName).toBe('Stephen King-Pack.rar');
    });

    it('sets nzbName even when no language detected from it', async () => {
      mockFetchWithSsrfRedirect.mockResolvedValueOnce(
        new Response(nzbWithName('Stephen King - The Stand MP3'), { status: 200 }),
      );
      const results = [makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' })];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.nzbName).toBe('Stephen King - The Stand MP3');
      expect(results[0]!.language).toBeUndefined();
    });

    it('does not set nzbName on torrent results', async () => {
      const results = [makeResult({ protocol: 'torrent' })];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.nzbName).toBeUndefined();
      expect(mockFetchWithSsrfRedirect).not.toHaveBeenCalled();
    });

    it('detects language from NZB name when newsgroup detection finds nothing', async () => {
      mockFetchWithSsrfRedirect.mockResolvedValueOnce(
        new Response(nzbWithName('Stephen King-Hörbuch-Pack.rar'), { status: 200 }),
      );
      const results = [makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' })];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.language).toBe('german');
      expect(results[0]!.nzbName).toBe('Stephen King-Hörbuch-Pack.rar');
    });

    it('newsgroup-based detection takes priority over NZB name detection', async () => {
      mockFetchWithSsrfRedirect.mockResolvedValueOnce(
        new Response(nzbWithName('Luisterboek NL.rar', 'alt.binaries.german'), { status: 200 }),
      );
      const results = [makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' })];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.language).toBe('german');
    });

    it('uses file subject as fallback when <meta type="name"> is absent', async () => {
      mockFetchWithSsrfRedirect.mockResolvedValueOnce(
        new Response(nzbWithoutName(), { status: 200 }),
      );
      const results = [makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' })];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.nzbName).toBe('File Subject Fallback');
    });

    it('does not overwrite existing result.language with NZB name detection', async () => {
      const results = [makeResult({ protocol: 'usenet', language: 'english', downloadUrl: 'http://nzb.test/1' })];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.language).toBe('english');
      expect(mockFetchWithSsrfRedirect).not.toHaveBeenCalled();
    });

    it('does not set nzbName when fetch fails', async () => {
      mockFetchWithSsrfRedirect.mockRejectedValueOnce(new Error('timeout'));
      const results = [makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' })];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.nzbName).toBeUndefined();
    });

    it('does not fetch when downloadUrl is empty string', async () => {
      const results = [makeResult({ protocol: 'usenet', downloadUrl: '' })];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.nzbName).toBeUndefined();
      expect(mockFetchWithSsrfRedirect).not.toHaveBeenCalled();
    });
  });

  describe('URL credential sanitization in logs', () => {
    it('logs sanitized URL on non-OK status (strips query params)', async () => {
      const results = [makeResult({
        protocol: 'usenet',
        downloadUrl: 'https://indexer.example.com/nzb/12345?apikey=SECRET',
      })];

      mockFetchWithSsrfRedirect.mockResolvedValue(new Response('', { status: 403 }));

      await enrichUsenetLanguages(results, logger);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://indexer.example.com/nzb/12345',
        }),
        expect.any(String),
      );
      const warnCall = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      expect(warnCall.url).not.toContain('SECRET');
    });

    it('logs sanitized URL on fetch error (strips query params)', async () => {
      const results = [makeResult({
        protocol: 'usenet',
        downloadUrl: 'https://indexer.example.com/nzb/12345?apikey=SECRET',
      })];

      mockFetchWithSsrfRedirect.mockRejectedValue(new Error('Network error'));

      await enrichUsenetLanguages(results, logger);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://indexer.example.com/nzb/12345',
        }),
        expect.any(String),
      );
      const warnCall = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      expect(warnCall.url).not.toContain('SECRET');
    });
  });

  describe('SSRF closure (#904)', () => {
    beforeEach(() => {
      mockCreateSsrfSafeDispatcher.mockClear();
      mockDispatcher.close.mockClear();
    });

    it('creates an SSRF-safe dispatcher, passes it to the helper, and closes it on success', async () => {
      const nzbXml = `<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
        <file poster="t" date="1" subject="t">
          <groups><group>alt.binaries.german</group></groups>
          <segments><segment bytes="1" number="1">id@e</segment></segments>
        </file>
      </nzb>`;
      mockFetchWithSsrfRedirect.mockResolvedValueOnce(new Response(nzbXml, { status: 200 }));

      const results = [makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' })];

      await enrichUsenetLanguages(results, logger);

      expect(mockCreateSsrfSafeDispatcher).toHaveBeenCalledTimes(1);
      expect(mockCreateSsrfSafeDispatcher).toHaveBeenCalledWith(undefined);
      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledWith(
        'http://nzb.test/1',
        expect.objectContaining({ dispatcher: mockDispatcher, timeoutMs: 5000 }),
      );
      const fetchOpts = mockFetchWithSsrfRedirect.mock.calls[0]![1] as Record<string, unknown>;
      expect(fetchOpts.lanAllowlist).toBeUndefined();
      expect(mockDispatcher.close).toHaveBeenCalledTimes(1);
    });

    it('closes the dispatcher even when the helper throws (SSRF refusal path)', async () => {
      mockFetchWithSsrfRedirect.mockRejectedValueOnce(
        new Error('Refused: hostname x resolved to 1 address(es); blocked address 192.168.1.1 is in the blocked range'),
      );

      const results = [makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' })];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.language).toBeUndefined();
      expect(mockDispatcher.close).toHaveBeenCalledTimes(1);
    });

    it('redirect to HTML auth-proxy login page returns no-languages without throwing', async () => {
      mockFetchWithSsrfRedirect.mockResolvedValueOnce(
        new Response('<html><body>Login</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      );

      const results = [makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' })];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.language).toBeUndefined();
      expect(mockDispatcher.close).toHaveBeenCalledTimes(1);
    });

    it('emits debug trace lines per result + per detection attempt (AC4 #932)', async () => {
      const nzbXml = `<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
        <head><meta type="name">Stephen King-Hoerbuch.part01.rar</meta></head>
        <file poster="test" date="1" subject="Stephen King.German.M4B">
          <groups>
            <group>alt.binaries.audiobooks</group>
            <group>alt.binaries.sounds.mp3.german.hoerbuecher</group>
          </groups>
          <segments><segment bytes="100" number="1">id@example</segment></segments>
        </file>
      </nzb>`;
      mockFetchWithSsrfRedirect.mockResolvedValueOnce(
        new Response(nzbXml, { status: 200 }),
      );

      const results = [
        makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Test Book', protocol: 'usenet', hasNewsgroup: false, hasDownloadUrl: true }),
        'Enrichment phase-1 input',
      );
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Test Book', url: expect.any(String) }),
        'Phase-2: fetching NZB',
      );
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Test Book', groupCount: 2 }),
        'Phase-2: NZB parsed',
      );
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Test Book', signal: 'newsgroup-token', testedAgainst: expect.any(String) }),
        'Detection attempt',
      );
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Test Book', finalLanguage: 'german', source: 'newsgroup' }),
        'Phase-2: enrichment complete',
      );
    });

    it('emits the "nzb-name-pattern" detection attempt log when newsgroup signals fail (Fairy Tale negative case)', async () => {
      const nzbXml = `<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
        <head><meta type="name">Stephen King Fairy Tale (Ungekrzt) German</meta></head>
        <file poster="t" date="1" subject="Stephen King.M4B">
          <groups><group>alt.binaries.audiobooks</group></groups>
          <segments><segment bytes="100" number="1">id@example</segment></segments>
        </file>
      </nzb>`;
      mockFetchWithSsrfRedirect.mockResolvedValueOnce(
        new Response(nzbXml, { status: 200 }),
      );
      const results = [
        makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ signal: 'newsgroup-token', testedAgainst: 'alt.binaries.audiobooks', matched: null }),
        'Detection attempt',
      );
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ signal: 'nzb-name-pattern' }),
        'Detection attempt',
      );
    });

    it('private-IP redirect refusal logs sanitized warning and returns no-languages', async () => {
      mockFetchWithSsrfRedirect.mockRejectedValueOnce(
        new Error(
          'Refused: hostname rebind.example.com resolved to 1 address(es); blocked address 192.168.1.1 is in the blocked range',
        ),
      );

      const results = [makeResult({
        protocol: 'usenet',
        downloadUrl: 'https://indexer.example.com/nzb/12345?apikey=SECRET',
      })];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.language).toBeUndefined();
      const warnCall = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      expect(warnCall.url).toBe('https://indexer.example.com/nzb/12345');
      expect(warnCall.url).not.toContain('SECRET');
    });
  });

  describe('LAN allowlist threading (#1149)', () => {
    beforeEach(() => {
      mockCreateSsrfSafeDispatcher.mockClear();
      mockFetchWithSsrfRedirect.mockReset();
    });

    it('forwards hostname allowlist to createSsrfSafeDispatcher and host:port allowlist to fetchWithSsrfRedirect when supplied', async () => {
      const nzbXml = `<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
        <head><meta type="name">Some Book.part01.rar</meta></head>
        <file poster="t" date="1" subject="t">
          <groups><group>alt.binaries.german</group></groups>
          <segments><segment bytes="1" number="1">id@e</segment></segments>
        </file>
      </nzb>`;
      mockFetchWithSsrfRedirect.mockResolvedValueOnce(new Response(nzbXml, { status: 200 }));

      const allowlist = {
        hostPort: new Set(['192.168.0.22:9696']),
        hostname: new Set(['192.168.0.22']),
      };
      const results = [
        makeResult({ protocol: 'usenet', downloadUrl: 'http://192.168.0.22:9696/api?t=get' }),
      ];

      await enrichUsenetLanguages(results, logger, allowlist);

      expect(mockCreateSsrfSafeDispatcher).toHaveBeenCalledWith(allowlist.hostname);
      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledWith(
        'http://192.168.0.22:9696/api?t=get',
        expect.objectContaining({ dispatcher: mockDispatcher, timeoutMs: 5000, lanAllowlist: allowlist.hostPort }),
      );
      expect(results[0]!.language).toBe('german');
      expect(results[0]!.nzbName).toBe('Some Book.part01.rar');
    });

    it('with allowlist supplied, the previously-refused private-IP fetch now succeeds (regression complement to #904 refusal test)', async () => {
      const nzbXml = `<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
        <file poster="t" date="1" subject="t">
          <groups><group>alt.binaries.audiobooks</group></groups>
          <segments><segment bytes="1" number="1">id@e</segment></segments>
        </file>
      </nzb>`;
      mockFetchWithSsrfRedirect.mockResolvedValueOnce(new Response(nzbXml, { status: 200 }));

      const results = [
        makeResult({ protocol: 'usenet', downloadUrl: 'http://192.168.0.22:9696/nzb' }),
      ];

      await enrichUsenetLanguages(results, logger, {
        hostPort: new Set(['192.168.0.22:9696']),
        hostname: new Set(['192.168.0.22']),
      });

      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledTimes(1);
      expect(results[0]!.nzbName ?? null).not.toBeNull();
    });

    it('empty allowlist (no indexers configured) still SSRF-refuses LAN URLs and falls back to title detection', async () => {
      mockFetchWithSsrfRedirect.mockRejectedValueOnce(
        new Error('Refused: address 192.168.0.22 is in the blocked range'),
      );

      const results = [
        makeResult({
          protocol: 'usenet',
          downloadUrl: 'http://192.168.0.22:9696/nzb',
          title: 'Stephen King - Fairy Tale (Ungekrzt)',
        }),
      ];

      await enrichUsenetLanguages(results, logger, {
        hostPort: new Set<string>(),
        hostname: new Set<string>(),
      });

      expect(mockCreateSsrfSafeDispatcher).toHaveBeenCalledWith(new Set<string>());
      const fetchOpts = mockFetchWithSsrfRedirect.mock.calls[0]![1] as Record<string, unknown>;
      expect(fetchOpts.lanAllowlist).toEqual(new Set<string>());
      expect(results[0]!.language).toBe('german');
    });
  });

  describe('title-pattern fallback (#1142)', () => {
    it('Phase-2: detects german from result.title when newsgroup + nzbName both miss — Fairy Tale UAT case', async () => {
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
      const results = [
        makeResult({
          protocol: 'usenet',
          downloadUrl: 'http://nzb.test/1',
          newsgroup: 'alt.binaries.audiobooks',
          title: 'Stephen King – Fairy Tale (Ungekrzt)',
        }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.language).toBe('german');
      expect(results[0]!.nzbName).toBe('Fairy.Tale.part01.rar');
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Stephen King – Fairy Tale (Ungekrzt)',
          finalLanguage: 'german',
          source: 'title',
        }),
        'Phase-2: enrichment complete',
      );
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          signal: 'title-pattern',
          testedAgainst: 'Stephen King – Fairy Tale (Ungekrzt)',
          matched: 'german',
        }),
        'Detection attempt',
      );
    });

    it('Phase-2: nzbName wins over a detectable conflicting title (priority preservation)', async () => {
      const nzbXml = `<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
        <head><meta type="name">Stephen King-Hörbuch-Pack.rar</meta></head>
        <file poster="t" date="1" subject="Stephen King-Hörbuch-Pack.rar">
          <groups><group>alt.binaries.audiobooks</group></groups>
          <segments><segment bytes="1" number="1">id@e</segment></segments>
        </file>
      </nzb>`;
      mockFetchWithSsrfRedirect.mockResolvedValueOnce(
        new Response(nzbXml, { status: 200 }),
      );
      const results = [
        makeResult({
          protocol: 'usenet',
          downloadUrl: 'http://nzb.test/1',
          newsgroup: 'alt.binaries.audiobooks',
          title: 'Boek Luisterboek NL.rar',
        }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.language).toBe('german');
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Boek Luisterboek NL.rar',
          finalLanguage: 'german',
          source: 'name',
        }),
        'Phase-2: enrichment complete',
      );
      const titleAttempts = (logger.debug as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([fields]) => (fields as Record<string, unknown>)?.signal === 'title-pattern',
      );
      expect(titleAttempts).toHaveLength(0);
    });

    it('Phase-2: title fallback still runs when downloadUrl is present and newsgroup is generic — no Phase-1 short-circuit on title', async () => {
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
      const results = [
        makeResult({
          protocol: 'usenet',
          downloadUrl: 'http://nzb.test/1',
          newsgroup: 'alt.binaries.audiobooks',
          title: 'Some Book (Ungekürzt)',
        }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledTimes(1);
      expect(results[0]!.nzbName).toBe('Fairy.Tale.part01.rar');
      expect(results[0]!.language).toBe('german');
    });

    it('Phase-1 (no-fetch): detects german from result.title when downloadUrl is absent and newsgroup is generic', async () => {
      const { downloadUrl: _downloadUrl, ...resultNoUrl } = makeResult({
        protocol: 'usenet',
        newsgroup: 'alt.binaries.audiobooks',
        title: 'Foo (Ungekürzt)',
      });
      const results: SearchResult[] = [resultNoUrl];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.language).toBe('german');
      expect(mockFetchWithSsrfRedirect).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Foo (Ungekürzt)',
          signal: 'title',
          matched: 'german',
        }),
        'Phase-1: language detected from title (no-fetch branch)',
      );
    });

    it('Phase-1 (no-fetch): detects german from result.title when downloadUrl is absent and newsgroup is also absent', async () => {
      const { downloadUrl: _downloadUrl, ...resultNoUrl } = makeResult({
        protocol: 'usenet',
        title: 'Foo (Ungekrzt)',
      });
      const results: SearchResult[] = [resultNoUrl];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.language).toBe('german');
      expect(mockFetchWithSsrfRedirect).not.toHaveBeenCalled();
    });

    it('Phase-1 (no-fetch): leaves language undefined when title also has no language marker', async () => {
      const { downloadUrl: _downloadUrl, ...resultNoUrl } = makeResult({
        protocol: 'usenet',
        newsgroup: 'alt.binaries.audiobooks',
        title: 'Stephen King - The Stand (2012) MP3',
      });
      const results: SearchResult[] = [resultNoUrl];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.language).toBeUndefined();
      expect(mockFetchWithSsrfRedirect).not.toHaveBeenCalled();
    });
  });

  describe('title-after-fetch-fail fallback (#1148)', () => {
    it('catch-path: detects german from title (Ungekrzt) when NZB fetch throws', async () => {
      mockFetchWithSsrfRedirect.mockRejectedValueOnce(
        new Error('Refused: address 192.168.0.22 is in the blocked range'),
      );

      const results = [
        makeResult({
          protocol: 'usenet',
          downloadUrl: 'http://nzb.test/1',
          title: 'Stephen King - Fairy Tale (Ungekrzt)',
        }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.language).toBe('german');
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Stephen King - Fairy Tale (Ungekrzt)',
          signal: 'title-after-fetch-fail',
          matched: 'german',
        }),
        'Language detected from title after NZB fetch failure',
      );
    });

    it('catch-path: detects german from mojibake title (UngekÃ¼rzt) when NZB fetch throws', async () => {
      mockFetchWithSsrfRedirect.mockRejectedValueOnce(new Error('network down'));

      const results = [
        makeResult({
          protocol: 'usenet',
          downloadUrl: 'http://nzb.test/1',
          title: 'Stephen King - Fairy Tale (UngekÃ¼rzt)',
        }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.language).toBe('german');
    });

    it('non-OK response: detects german from title when fetch returns 403', async () => {
      mockFetchWithSsrfRedirect.mockResolvedValueOnce(
        new Response('Forbidden', { status: 403 }),
      );

      const results = [
        makeResult({
          protocol: 'usenet',
          downloadUrl: 'http://nzb.test/1',
          title: 'Stephen King - Fairy Tale (Ungekrzt)',
        }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.language).toBe('german');
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          signal: 'title-after-fetch-fail',
          matched: 'german',
        }),
        'Language detected from title after NZB fetch failure',
      );
    });

    it('non-OK response: detects german from title when fetch returns 500', async () => {
      mockFetchWithSsrfRedirect.mockResolvedValueOnce(
        new Response('Server Error', { status: 500 }),
      );

      const results = [
        makeResult({
          protocol: 'usenet',
          downloadUrl: 'http://nzb.test/1',
          title: 'Some Book (ungekÃ¼rzt)',
        }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.language).toBe('german');
    });

    it('does NOT overwrite a pre-set result.language on catch-path fallback', async () => {
      mockFetchWithSsrfRedirect.mockRejectedValueOnce(new Error('network down'));

      const results = [
        makeResult({
          protocol: 'usenet',
          language: 'spanish',
          downloadUrl: 'http://nzb.test/1',
          title: 'Some Book (Ungekrzt)',
        }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.language).toBe('spanish');
    });

    it('languagesDetected counter is bumped when fetch-failure title fallback succeeds', async () => {
      mockFetchWithSsrfRedirect.mockRejectedValue(new Error('network down'));

      const results = [
        makeResult({
          protocol: 'usenet',
          downloadUrl: 'http://nzb.test/1',
          title: 'Stephen King - Fairy Tale (Ungekrzt)',
        }),
        makeResult({
          protocol: 'usenet',
          downloadUrl: 'http://nzb.test/2',
          title: 'Plain English Audiobook',
        }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          usenetResults: 2,
          nzbFetched: 2,
          languagesDetected: 1,
        }),
        'Usenet language detection complete',
      );
    });

    it('emits the distinct "title-after-fetch-fail" signal (not "title-pattern")', async () => {
      mockFetchWithSsrfRedirect.mockRejectedValueOnce(new Error('network down'));

      const results = [
        makeResult({
          protocol: 'usenet',
          downloadUrl: 'http://nzb.test/1',
          title: 'Fairy Tale (Ungekrzt)',
        }),
      ];

      await enrichUsenetLanguages(results, logger);

      const fallbackCalls = (logger.debug as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([fields]) => (fields as Record<string, unknown>)?.signal === 'title-after-fetch-fail',
      );
      expect(fallbackCalls).toHaveLength(1);

      const titlePatternCalls = (logger.debug as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([fields]) => (fields as Record<string, unknown>)?.signal === 'title-pattern',
      );
      expect(titlePatternCalls).toHaveLength(0);
    });

    it('leaves language undefined on fetch failure when title also has no language marker (regression)', async () => {
      mockFetchWithSsrfRedirect.mockRejectedValueOnce(new Error('network down'));

      const results = [
        makeResult({
          protocol: 'usenet',
          downloadUrl: 'http://nzb.test/1',
          title: 'Stephen King - The Stand (2012) MP3',
        }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0]!.language).toBeUndefined();
    });
  });

  describe('User-Agent (#1315)', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('sends User-Agent: Narratorr/<version> on the enrichment NZB fetch', async () => {
      // Pin the tagged-version branch; user-agent tests cover unset and unknown values.
      vi.stubEnv('GIT_TAG', 'v9.9.9');
      mockFetchWithSsrfRedirect.mockResolvedValueOnce(
        new Response(germanNzbXml(), { status: 200 }),
      );
      const results = [makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' })];

      await enrichUsenetLanguages(results, logger);

      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledWith(
        'http://nzb.test/1',
        expect.objectContaining({ headers: { 'User-Agent': 'Narratorr/v9.9.9' } }),
      );
    });
  });

  describe('per-release cache (#1315)', () => {
    it('two passes over the same release fetch only on the first; second reports nzbFetched: 0', async () => {
      mockFetchWithSsrfRedirect.mockResolvedValue(new Response(germanNzbXml(), { status: 200 }));
      const make = () => makeResult({ protocol: 'usenet', guid: 'guid-1', downloadUrl: 'http://nzb.test/1' });

      const pass1 = [make()];
      await enrichUsenetLanguages(pass1, logger);
      const pass2 = [make()];
      await enrichUsenetLanguages(pass2, logger);

      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledTimes(1);
      expect(pass1[0]!.language).toBe('german');
      expect(pass2[0]!.language).toBe('german');
      expect(logger.info).toHaveBeenLastCalledWith(
        expect.objectContaining({ usenetResults: 1, nzbFetched: 0 }),
        'Usenet language detection complete',
      );
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ signal: 'cache-hit', outcome: 'resolved', language: 'german' }),
        'Phase-2: served from enrichment cache',
      );
    });

    it('caches an unresolved (successful fetch, no signal) result and does not re-fetch it', async () => {
      mockFetchWithSsrfRedirect.mockResolvedValue(
        new Response(plainNzbXml(), { status: 200 }),
      );
      const make = () => makeResult({ protocol: 'usenet', guid: 'guid-u', downloadUrl: 'http://nzb.test/u', title: 'Plain English Audiobook' });

      await enrichUsenetLanguages([make()], logger);
      const pass2 = [make()];
      await enrichUsenetLanguages(pass2, logger);

      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledTimes(1);
      expect(pass2[0]!.language).toBeUndefined();
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ signal: 'cache-hit', outcome: 'unresolved' }),
        'Phase-2: served from enrichment cache',
      );
    });

    it('preserves nzbName on a resolved cache hit (downstream multi-part filter needs it)', async () => {
      mockFetchWithSsrfRedirect.mockResolvedValue(
        new Response(germanNzbXml('Stephen King-Pack.part01.rar'), { status: 200 }),
      );
      const make = () => makeResult({ protocol: 'usenet', guid: 'guid-n', downloadUrl: 'http://nzb.test/n' });

      const pass1 = [make()];
      await enrichUsenetLanguages(pass1, logger);
      const pass2 = [make()];
      await enrichUsenetLanguages(pass2, logger);

      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledTimes(1);
      expect(pass1[0]!.nzbName).toBe('Stephen King-Pack.part01.rar');
      expect(pass2[0]!.nzbName).toBe('Stephen King-Pack.part01.rar');
    });

    it('fetch-failure + title fallback: caches the title language, reapplies on hit, leaves nzbName absent', async () => {
      mockFetchWithSsrfRedirect.mockRejectedValue(new Error('network down'));
      const make = () => makeResult({
        protocol: 'usenet',
        guid: 'guid-f',
        downloadUrl: 'http://nzb.test/f',
        title: 'Stephen King - Fairy Tale (Ungekürzt)',
      });

      const pass1 = [make()];
      await enrichUsenetLanguages(pass1, logger);
      const pass2 = [make()];
      await enrichUsenetLanguages(pass2, logger);

      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledTimes(1);
      expect(pass1[0]!.language).toBe('german');
      expect(pass2[0]!.language).toBe('german');
      expect(pass2[0]!.nzbName).toBeUndefined();
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ signal: 'cache-hit', outcome: 'fetch-failed', language: 'german' }),
        'Phase-2: served from enrichment cache',
      );
    });

    it('fetch-failure + no title fallback: caches a fetch-failed entry and does not re-fetch within the failure TTL', async () => {
      mockFetchWithSsrfRedirect.mockRejectedValue(new Error('network down'));
      const make = () => makeResult({
        protocol: 'usenet',
        guid: 'guid-fn',
        downloadUrl: 'http://nzb.test/fn',
        title: 'Stephen King - The Stand (2012) MP3',
      });

      await enrichUsenetLanguages([make()], logger);
      const pass2 = [make()];
      await enrichUsenetLanguages(pass2, logger);

      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledTimes(1);
      expect(pass2[0]!.language).toBeUndefined();
    });

    it('keys under downloadUrl when guid is absent; a release with neither guid nor url is never cached', async () => {
      mockFetchWithSsrfRedirect.mockResolvedValue(new Response(germanNzbXml(), { status: 200 }));

      const make = () => makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/keyfallback' });
      await enrichUsenetLanguages([make()], logger);
      const pass2 = [make()];
      await enrichUsenetLanguages(pass2, logger);
      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledTimes(1);
      expect(pass2[0]!.language).toBe('german');

      const { downloadUrl: _omit, ...noKey } = makeResult({ protocol: 'usenet', title: 'No Key Book' });
      const noKeyResults: SearchResult[] = [noKey];
      await expect(enrichUsenetLanguages(noKeyResults, logger)).resolves.toBeUndefined();
    });
  });

  describe('cache TTL expiry (#1315)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('re-fetches a resolved release after the success TTL (~24h) elapses', async () => {
      mockFetchWithSsrfRedirect.mockResolvedValue(new Response(germanNzbXml(), { status: 200 }));
      const make = () => makeResult({ protocol: 'usenet', guid: 'guid-ttl', downloadUrl: 'http://nzb.test/ttl' });

      await enrichUsenetLanguages([make()], logger);
      vi.advanceTimersByTime(23 * 60 * 60 * 1000);
      await enrichUsenetLanguages([make()], logger);
      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2 * 60 * 60 * 1000);
      await enrichUsenetLanguages([make()], logger);
      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledTimes(2);
    });

    it('failure TTL (~1h) is shorter than success TTL: a failed guid re-fetches after 1h while a resolved guid does not', async () => {
      mockFetchWithSsrfRedirect.mockImplementation(async (url: string) =>
        url.includes('/fail')
          ? new Response('err', { status: 500 })
          : new Response(germanNzbXml(), { status: 200 }),
      );
      const failer = () => makeResult({ protocol: 'usenet', guid: 'g-fail', downloadUrl: 'http://nzb.test/fail', title: 'Plain English' });
      const ok = () => makeResult({ protocol: 'usenet', guid: 'g-ok', downloadUrl: 'http://nzb.test/ok' });

      await enrichUsenetLanguages([failer(), ok()], logger);
      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(61 * 60 * 1000);
      await enrichUsenetLanguages([failer(), ok()], logger);

      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledTimes(3);
      const fetchedUrls = mockFetchWithSsrfRedirect.mock.calls.map((c) => c[0]);
      expect(fetchedUrls.filter((u) => u === 'http://nzb.test/fail')).toHaveLength(2);
      expect(fetchedUrls.filter((u) => u === 'http://nzb.test/ok')).toHaveLength(1);
    });

    it('evicts oldest entries past the size cap so the cache does not grow unbounded', async () => {
      // Return a fresh Response; bodies are one-shot.
      mockFetchWithSsrfRedirect.mockImplementation(async () => new Response(germanNzbXml(), { status: 200 }));
      const results: SearchResult[] = Array.from({ length: 5001 }, (_, i) =>
        makeResult({ protocol: 'usenet', guid: `cap-${i}`, downloadUrl: `http://nzb.test/cap-${i}` }),
      );

      await enrichUsenetLanguages(results, logger);

      expect(enrichmentCache.size).toBeLessThanOrEqual(5000);
      expect(enrichmentCache.get('test:cap-5000')?.outcome).toBe('resolved');
    });
  });

  describe('Phase-2 fetch cap (#1315)', () => {
    function usenetCandidates(): SearchResult[] {
      // Missing matchScore must rank below scores 1–12.
      const scored = Array.from({ length: 12 }, (_, i) =>
        makeResult({ protocol: 'usenet', guid: `cap-${i}`, downloadUrl: `http://nzb.test/cap-${i}`, matchScore: i + 1 }),
      );
      const { matchScore: _omit, ...noScore } = makeResult({ protocol: 'usenet', guid: 'cap-noscore', downloadUrl: 'http://nzb.test/cap-noscore' });
      return [...scored, noScore as SearchResult];
    }

    it('fetches only the top-N cache-miss candidates by ranking tuple and logs the skipped count', async () => {
      // Return a fresh Response; bodies are one-shot.
      mockFetchWithSsrfRedirect.mockImplementation(async () => new Response(germanNzbXml(), { status: 200 }));
      const results = usenetCandidates();

      await enrichUsenetLanguages(results, logger, undefined, { maxPhase2Fetches: 10 });

      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledTimes(10);
      // Scores 3–12 are the top ten; missing score ranks last.
      const byGuid = new Map(results.map((r) => [r.guid, r]));
      for (let i = 2; i < 12; i++) expect(byGuid.get(`cap-${i}`)!.language).toBe('german');
      expect(byGuid.get('cap-0')!.language).toBeUndefined();
      expect(byGuid.get('cap-1')!.language).toBeUndefined();
      expect(byGuid.get('cap-noscore')!.language).toBeUndefined();

      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ candidates: 13, cap: 10, skipped: 3 }),
        'Phase-2 fetch cap applied — skipped lowest-ranked candidates',
      );
    });

    it('uncapped (option omitted) fetches every cache-miss candidate', async () => {
      // Return a fresh Response; bodies are one-shot.
      mockFetchWithSsrfRedirect.mockImplementation(async () => new Response(germanNzbXml(), { status: 200 }));
      const results = usenetCandidates();

      await enrichUsenetLanguages(results, logger);

      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledTimes(13);
      for (const r of results) expect(r.language).toBe('german');
      expect(enrichmentCache.get(`test:${results[0]!.guid}`)?.outcome).toBe('resolved');
    });
  });

  describe('Phase-2 cap boundary clamp (#1330)', () => {
    function usenetCandidates(n: number): SearchResult[] {
      return Array.from({ length: n }, (_, i) =>
        makeResult({ protocol: 'usenet', guid: `cap-${i}`, downloadUrl: `http://nzb.test/cap-${i}`, matchScore: i + 1 }),
      );
    }

    it('maxPhase2Fetches: 0 performs zero fetches', async () => {
      mockFetchWithSsrfRedirect.mockImplementation(async () => new Response(germanNzbXml(), { status: 200 }));

      await enrichUsenetLanguages(usenetCandidates(5), logger, undefined, { maxPhase2Fetches: 0 });

      expect(mockFetchWithSsrfRedirect).not.toHaveBeenCalled();
    });

    it('negative maxPhase2Fetches behaves as 0 after clamping (not slice(0, -n) keep-all-but-n)', async () => {
      mockFetchWithSsrfRedirect.mockImplementation(async () => new Response(germanNzbXml(), { status: 200 }));

      await enrichUsenetLanguages(usenetCandidates(5), logger, undefined, { maxPhase2Fetches: -2 });

      expect(mockFetchWithSsrfRedirect).not.toHaveBeenCalled();
    });

    it('fractional maxPhase2Fetches floors to whole fetches', async () => {
      mockFetchWithSsrfRedirect.mockImplementation(async () => new Response(germanNzbXml(), { status: 200 }));

      await enrichUsenetLanguages(usenetCandidates(5), logger, undefined, { maxPhase2Fetches: 2.9 });

      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledTimes(2);
    });

    it('cap >= candidate count fetches all candidates and emits no skip log', async () => {
      mockFetchWithSsrfRedirect.mockImplementation(async () => new Response(germanNzbXml(), { status: 200 }));

      await enrichUsenetLanguages(usenetCandidates(3), logger, undefined, { maxPhase2Fetches: 10 });

      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledTimes(3);
      expect(logger.debug).not.toHaveBeenCalledWith(
        expect.objectContaining({ skipped: expect.anything() }),
        'Phase-2 fetch cap applied — skipped lowest-ranked candidates',
      );
    });
  });

  describe('Phase-2 cap-skipped free title check (#1326)', () => {
    // Plain fetched NZBs isolate title detection on the cap-skipped tail.
    function plainFetch(): void {
      mockFetchWithSsrfRedirect.mockImplementation(async () => new Response(plainNzbXml(), { status: 200 }));
    }

    function capMiss(i: number, overrides: Partial<SearchResult> = {}): SearchResult {
      return makeResult({
        protocol: 'usenet',
        guid: `cap-${i}`,
        downloadUrl: `http://nzb.test/cap-${i}`,
        matchScore: i,
        ...overrides,
      });
    }

    it('detects a German title on a cap-skipped candidate without fetching its NZB', async () => {
      plainFetch();
      // Put the German marker on the lowest-ranked candidate.
      const german = capMiss(1, { guid: 'cap-german', downloadUrl: 'http://nzb.test/cap-german', title: 'Der Hobbit (Ungekürzt)' });
      const rest = Array.from({ length: 12 }, (_, i) => capMiss(i + 2));
      const results = [german, ...rest];

      await enrichUsenetLanguages(results, logger, undefined, { maxPhase2Fetches: 10 });

      expect(german.language).toBe('german');
      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledTimes(10);
      const fetchedUrls = mockFetchWithSsrfRedirect.mock.calls.map((c) => c[0]);
      expect(fetchedUrls).not.toContain('http://nzb.test/cap-german');
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ nzbFetched: 10, languagesDetected: 1 }),
        'Usenet language detection complete',
      );
    });

    it('walks the ranked dropped tail, not insertion order', async () => {
      plainFetch();
      // Insert the lowest-ranked German candidate first to distinguish ranking from insertion order.
      const german = capMiss(1, { guid: 'cap-german', downloadUrl: 'http://nzb.test/cap-german', title: 'Der Hobbit (Ungekürzt)' });
      const rest = Array.from({ length: 12 }, (_, i) => capMiss(i + 2));
      const results = [german, ...rest];

      await enrichUsenetLanguages(results, logger, undefined, { maxPhase2Fetches: 10 });

      expect(german.language).toBe('german');
      const fetchedUrls = mockFetchWithSsrfRedirect.mock.calls.map((c) => c[0]);
      expect(fetchedUrls).not.toContain('http://nzb.test/cap-german');
    });

    it('leaves a cap-skipped candidate with no language marker undefined and unfetched', async () => {
      plainFetch();
      const noMarker = capMiss(1, { guid: 'cap-plain', downloadUrl: 'http://nzb.test/cap-plain', title: 'A Perfectly Ordinary Audiobook' });
      const rest = Array.from({ length: 12 }, (_, i) => capMiss(i + 2));
      const results = [noMarker, ...rest];

      await enrichUsenetLanguages(results, logger, undefined, { maxPhase2Fetches: 10 });

      expect(noMarker.language).toBeUndefined();
      const fetchedUrls = mockFetchWithSsrfRedirect.mock.calls.map((c) => c[0]);
      expect(fetchedUrls).not.toContain('http://nzb.test/cap-plain');
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ nzbFetched: 10, languagesDetected: 0 }),
        'Usenet language detection complete',
      );
    });

    it('does not cache cap-skipped title detection, so a later uncapped run still fetches the NZB', async () => {
      plainFetch();
      const german = capMiss(1, { guid: 'cap-german', downloadUrl: 'http://nzb.test/cap-german', title: 'Der Hobbit (Ungekürzt)' });
      const rest = Array.from({ length: 12 }, (_, i) => capMiss(i + 2));
      const results = [german, ...rest];

      await enrichUsenetLanguages(results, logger, undefined, { maxPhase2Fetches: 10 });

      expect(enrichmentCache.get('test:cap-german')).toBeUndefined();

      mockFetchWithSsrfRedirect.mockClear();
      const second = [makeResult({ protocol: 'usenet', guid: 'cap-german', downloadUrl: 'http://nzb.test/cap-german', title: 'Der Hobbit (Ungekürzt)' })];
      await enrichUsenetLanguages(second, logger);
      const refetched = mockFetchWithSsrfRedirect.mock.calls.map((c) => c[0]);
      expect(refetched).toContain('http://nzb.test/cap-german');
    });

    it('emits a distinct title-cap-skipped debug signal', async () => {
      plainFetch();
      const german = capMiss(1, { guid: 'cap-german', downloadUrl: 'http://nzb.test/cap-german', title: 'Der Hobbit (Ungekürzt)' });
      const rest = Array.from({ length: 12 }, (_, i) => capMiss(i + 2));
      const results = [german, ...rest];

      await enrichUsenetLanguages(results, logger, undefined, { maxPhase2Fetches: 10 });

      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Der Hobbit (Ungekürzt)', signal: 'title-cap-skipped', matched: 'german' }),
        expect.any(String),
      );
      const signals = (logger.debug as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => (c[0] as { signal?: string }).signal)
        .filter(Boolean);
      expect(signals).toContain('title-cap-skipped');
      const capSkippedSignal = 'title-cap-skipped';
      expect(capSkippedSignal).not.toBe('title-pattern');
      expect(capSkippedSignal).not.toBe('title-after-fetch-fail');
    });
  });

  describe('indexer-scoped cache keys (#1328)', () => {
    it('same guid from two different indexers produces two distinct cache entries (no cross-indexer collision)', async () => {
      mockFetchWithSsrfRedirect.mockImplementation(async () => new Response(germanNzbXml(), { status: 200 }));
      const a = makeResult({ protocol: 'usenet', guid: 'shared-123', indexer: 'alpha', downloadUrl: 'http://nzb.test/a' });
      const b = makeResult({ protocol: 'usenet', guid: 'shared-123', indexer: 'beta', downloadUrl: 'http://nzb.test/b' });

      await enrichUsenetLanguages([a, b], logger);

      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledTimes(2);
      expect(enrichmentCache.get('alpha:shared-123')).toBeDefined();
      expect(enrichmentCache.get('beta:shared-123')).toBeDefined();
    });

    it('keys under indexerId when present (preferred over the indexer name)', async () => {
      mockFetchWithSsrfRedirect.mockResolvedValue(new Response(germanNzbXml(), { status: 200 }));
      const r = makeResult({ protocol: 'usenet', guid: 'g-77', indexer: 'alpha', indexerId: 77, downloadUrl: 'http://nzb.test/x' });

      await enrichUsenetLanguages([r], logger);

      expect(enrichmentCache.get('77:g-77')).toBeDefined();
      expect(enrichmentCache.get('alpha:g-77')).toBeUndefined();
    });

    it('a cached entry under one indexer does not serve a same-guid release from another indexer', async () => {
      mockFetchWithSsrfRedirect.mockImplementation(async () => new Response(germanNzbXml(), { status: 200 }));

      await enrichUsenetLanguages([makeResult({ protocol: 'usenet', guid: 'dup', indexer: 'alpha', downloadUrl: 'http://nzb.test/a' })], logger);
      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledTimes(1);

      await enrichUsenetLanguages([makeResult({ protocol: 'usenet', guid: 'dup', indexer: 'beta', downloadUrl: 'http://nzb.test/b' })], logger);
      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledTimes(2);
    });
  });

  describe('empty-guid key guard (#1328)', () => {
    it('keys a guid:"" result under indexer:downloadUrl, never a poison empty/namespace-only key', async () => {
      mockFetchWithSsrfRedirect.mockResolvedValue(new Response(germanNzbXml(), { status: 200 }));
      const r = makeResult({ protocol: 'usenet', guid: '', indexer: 'alpha', downloadUrl: 'http://nzb.test/u' });

      await enrichUsenetLanguages([r], logger);

      expect(enrichmentCache.get('alpha:http://nzb.test/u')).toBeDefined();
      expect(enrichmentCache.get('alpha:')).toBeUndefined();
      expect(enrichmentCache.get('alpha:undefined')).toBeUndefined();
    });

    it('a guid:"" result with no downloadUrl is uncacheable, never fetched, and produces no key', async () => {
      const { downloadUrl: _omit, ...noUrl } = makeResult({ protocol: 'usenet', guid: '', indexer: 'alpha', title: 'No Key Book' });

      await expect(enrichUsenetLanguages([noUrl as SearchResult], logger)).resolves.toBeUndefined();

      expect(mockFetchWithSsrfRedirect).not.toHaveBeenCalled();
      expect(enrichmentCache.size).toBe(0);
    });

    it('two guid:"" results with different downloadUrls get distinct keys, never a shared empty key', async () => {
      mockFetchWithSsrfRedirect.mockImplementation(async () => new Response(germanNzbXml(), { status: 200 }));
      const a = makeResult({ protocol: 'usenet', guid: '', indexer: 'alpha', downloadUrl: 'http://nzb.test/a' });
      const b = makeResult({ protocol: 'usenet', guid: '', indexer: 'alpha', downloadUrl: 'http://nzb.test/b' });

      await enrichUsenetLanguages([a, b], logger);

      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledTimes(2);
      expect(enrichmentCache.size).toBe(2);
    });
  });

  describe('within-run duplicate dedup (#1328)', () => {
    it('two results sharing a key fetch once; both carry the representative language and nzbName', async () => {
      mockFetchWithSsrfRedirect.mockResolvedValue(new Response(germanNzbXml('Der.Pack.part01.rar'), { status: 200 }));
      const dupA = makeResult({ protocol: 'usenet', guid: 'dup', indexer: 'alpha', downloadUrl: 'http://nzb.test/dup', title: 'A' });
      const dupB = makeResult({ protocol: 'usenet', guid: 'dup', indexer: 'alpha', downloadUrl: 'http://nzb.test/dup', title: 'B' });

      await enrichUsenetLanguages([dupA, dupB], logger);

      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledTimes(1);
      expect(dupA.language).toBe('german');
      expect(dupB.language).toBe('german');
      expect(dupA.nzbName).toBe('Der.Pack.part01.rar');
      expect(dupB.nzbName).toBe('Der.Pack.part01.rar');
      expect(enrichmentCache.size).toBe(1);
      expect(enrichmentCache.get('alpha:dup')).toBeDefined();
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ signal: 'within-run-dup', language: 'german' }),
        expect.any(String),
      );
    });

    it('a fetch-failed representative still dedups: one fetch, one cache entry, a later run does not re-fetch', async () => {
      mockFetchWithSsrfRedirect.mockResolvedValue(new Response('err', { status: 500 }));
      const dupA = makeResult({ protocol: 'usenet', guid: 'dupf', indexer: 'alpha', downloadUrl: 'http://nzb.test/dupf', title: 'Plain English A' });
      const dupB = makeResult({ protocol: 'usenet', guid: 'dupf', indexer: 'alpha', downloadUrl: 'http://nzb.test/dupf', title: 'Plain English B' });

      await enrichUsenetLanguages([dupA, dupB], logger);

      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledTimes(1);
      expect(dupA.language).toBeUndefined();
      expect(dupB.language).toBeUndefined();
      expect(enrichmentCache.size).toBe(1);

      mockFetchWithSsrfRedirect.mockClear();
      await enrichUsenetLanguages([makeResult({ protocol: 'usenet', guid: 'dupf', indexer: 'alpha', downloadUrl: 'http://nzb.test/dupf', title: 'Plain English A' })], logger);
      expect(mockFetchWithSsrfRedirect).not.toHaveBeenCalled();
    });

    it('an unresolved representative (successful fetch, no signal) dedups and is recorded as a hit', async () => {
      mockFetchWithSsrfRedirect.mockResolvedValue(new Response(plainNzbXml(), { status: 200 }));
      const dupA = makeResult({ protocol: 'usenet', guid: 'dupu', indexer: 'alpha', downloadUrl: 'http://nzb.test/dupu', title: 'Plain A' });
      const dupB = makeResult({ protocol: 'usenet', guid: 'dupu', indexer: 'alpha', downloadUrl: 'http://nzb.test/dupu', title: 'Plain B' });

      await enrichUsenetLanguages([dupA, dupB], logger);

      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledTimes(1);
      expect(dupA.language).toBeUndefined();
      expect(dupB.language).toBeUndefined();

      mockFetchWithSsrfRedirect.mockClear();
      await enrichUsenetLanguages([makeResult({ protocol: 'usenet', guid: 'dupu', indexer: 'alpha', downloadUrl: 'http://nzb.test/dupu', title: 'Plain A' })], logger);
      expect(mockFetchWithSsrfRedirect).not.toHaveBeenCalled();
    });

    it('cap-straddle: a duplicate key consumes one cap slot and both duplicates get the representative enrichment', async () => {
      mockFetchWithSsrfRedirect.mockImplementation(async () => new Response(germanNzbXml(), { status: 200 }));
      // The duplicate pair outranks other; cap 1 admits one key.
      const dupA = makeResult({ protocol: 'usenet', guid: 'dup', indexer: 'alpha', downloadUrl: 'http://nzb.test/dup', title: 'Plain A', matchScore: 5 });
      const dupB = makeResult({ protocol: 'usenet', guid: 'dup', indexer: 'alpha', downloadUrl: 'http://nzb.test/dup', title: 'Plain B', matchScore: 5 });
      const other = makeResult({ protocol: 'usenet', guid: 'other', indexer: 'alpha', downloadUrl: 'http://nzb.test/other', title: 'Plain Other', matchScore: 1 });

      await enrichUsenetLanguages([dupA, dupB, other], logger, undefined, { maxPhase2Fetches: 1 });

      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledTimes(1);
      expect(dupA.language).toBe('german');
      expect(dupB.language).toBe('german');
      expect(other.language).toBeUndefined();
    });

    it('fetches the highest-ranked (comparePhase2) group member as the representative, not insertion order', async () => {
      // Insert low first with distinct URLs so a group[0] representative fails.
      mockFetchWithSsrfRedirect.mockImplementation(async () => new Response(germanNzbXml(), { status: 200 }));
      const low = makeResult({ protocol: 'usenet', guid: 'dup', indexer: 'alpha', downloadUrl: 'http://nzb.test/low', matchScore: 1, title: 'Low' });
      const high = makeResult({ protocol: 'usenet', guid: 'dup', indexer: 'alpha', downloadUrl: 'http://nzb.test/high', matchScore: 9, title: 'High' });

      await enrichUsenetLanguages([low, high], logger);

      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledTimes(1);
      const fetchedUrls = mockFetchWithSsrfRedirect.mock.calls.map((c) => c[0]);
      expect(fetchedUrls).toEqual(['http://nzb.test/high']);
      expect(fetchedUrls).not.toContain('http://nzb.test/low');
      expect(low.language).toBe('german');
      expect(high.language).toBe('german');
    });
  });

  describe('info-level cache counters (#1328)', () => {
    it('the completion log reports cacheHits and capSkipped', async () => {
      mockFetchWithSsrfRedirect.mockImplementation(async () => new Response(germanNzbXml(), { status: 200 }));

      await enrichUsenetLanguages(
        [makeResult({ protocol: 'usenet', guid: 'warm', indexer: 'alpha', downloadUrl: 'http://nzb.test/warm' })],
        logger,
      );

      const run = [
        makeResult({ protocol: 'usenet', guid: 'warm', indexer: 'alpha', downloadUrl: 'http://nzb.test/warm' }),
        makeResult({ protocol: 'usenet', guid: 'fresh1', indexer: 'alpha', downloadUrl: 'http://nzb.test/fresh1', matchScore: 5, title: 'Plain One' }),
        makeResult({ protocol: 'usenet', guid: 'fresh2', indexer: 'alpha', downloadUrl: 'http://nzb.test/fresh2', matchScore: 1, title: 'Plain Two' }),
      ];
      await enrichUsenetLanguages(run, logger, undefined, { maxPhase2Fetches: 1 });

      expect(logger.info).toHaveBeenLastCalledWith(
        expect.objectContaining({ cacheHits: 1, capSkipped: 1 }),
        'Usenet language detection complete',
      );
    });

    it('counts an unresolved cache hit in cacheHits even though it sets no language', async () => {
      mockFetchWithSsrfRedirect.mockResolvedValue(new Response(plainNzbXml(), { status: 200 }));
      const make = () => makeResult({ protocol: 'usenet', guid: 'u-hit', indexer: 'alpha', downloadUrl: 'http://nzb.test/u-hit', title: 'Plain English Audiobook' });

      await enrichUsenetLanguages([make()], logger); // warm the unresolved entry
      await enrichUsenetLanguages([make()], logger); // served from the unresolved hit

      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenLastCalledWith(
        expect.objectContaining({ cacheHits: 1, languagesDetected: 0, nzbFetched: 0 }),
        'Usenet language detection complete',
      );
    });

    it('counts a fetch-failed cache hit in cacheHits without incrementing languagesDetected', async () => {
      mockFetchWithSsrfRedirect.mockResolvedValue(new Response('err', { status: 500 }));
      const make = () => makeResult({ protocol: 'usenet', guid: 'f-hit', indexer: 'alpha', downloadUrl: 'http://nzb.test/f-hit', title: 'Stephen King - The Stand (2012) MP3' });

      await enrichUsenetLanguages([make()], logger); // warm the fetch-failed entry
      await enrichUsenetLanguages([make()], logger); // served from the fetch-failed hit

      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenLastCalledWith(
        expect.objectContaining({ cacheHits: 1, languagesDetected: 0, nzbFetched: 0 }),
        'Usenet language detection complete',
      );
    });
  });

  // ─── #2573: the caller's abort bounds phase 2 ───────────────────────────────
  // Every describe above is the no-signal parity baseline and stays green UNMODIFIED.
  describe('abort-bounded phase 2 (#2573)', () => {
    /** Mirrors NZB_FETCH_CONCURRENCY: a candidate set at or below it never queues a waiter. */
    const CONCURRENCY = 5;

    function miss(i: number, overrides: Partial<SearchResult> = {}): SearchResult {
      return makeResult({
        protocol: 'usenet',
        guid: `ab-${i}`,
        downloadUrl: `http://nzb.test/ab-${i}`,
        title: `Plain Audiobook ${i}`,
        ...overrides,
      });
    }

    /**
     * Parks every fetch on one barrier and resolves `onWire` once `target` of them are genuinely on
     * the wire. Aborting before that point reaches only the pre-acquire guard, never the queued
     * waiters this bound exists to evict (solver-abort-after-slot-not-after-call).
     */
    function parkFetches(target: number, xml: () => string = plainNzbXml) {
      let open!: () => void;
      const barrier = new Promise<void>((resolve) => { open = resolve; });
      let admit!: () => void;
      const onWire = new Promise<void>((resolve) => { admit = resolve; });
      let started = 0;
      mockFetchWithSsrfRedirect.mockImplementation(async () => {
        if (++started >= target) admit();
        await barrier;
        return new Response(xml(), { status: 200 });
      });
      return { onWire, release: () => open() };
    }

    const calls = (level: 'debug' | 'info' | 'warn') => (logger[level] as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const truncationWarns = () => calls('warn').filter((c) => c[1] === 'Usenet enrichment truncated by abort');
    const taggedDebug = (tag: string) => calls('debug').filter((c) => (c[0] as { signal?: string }).signal === tag);
    const completionLog = () =>
      calls('info').findLast((c) => c[1] === 'Usenet language detection complete')![0] as Record<string, number>;

    /** Drives one aborted run to completion: park, let the first wave reach the wire, tear, drain. */
    async function tornRun(results: SearchResult[], options: { maxPhase2Fetches?: number } = {}) {
      const { onWire, release } = parkFetches(CONCURRENCY);
      const controller = new AbortController();
      const running = enrichUsenetLanguages(results, logger, undefined, { ...options, signal: controller.signal });
      await onWire;
      controller.abort();
      release();
      await running;
    }

    it('accepts the signal alone, beside the cap, and explicitly undefined (AC1)', async () => {
      mockFetchWithSsrfRedirect.mockImplementation(async () => new Response(plainNzbXml(), { status: 200 }));
      const live = new AbortController();

      await expect(enrichUsenetLanguages([miss(1)], logger, undefined, { signal: live.signal })).resolves.toBeUndefined();
      await expect(enrichUsenetLanguages([miss(2)], logger, undefined, { maxPhase2Fetches: 10, signal: live.signal })).resolves.toBeUndefined();
      await expect(enrichUsenetLanguages([miss(3)], logger, undefined, { maxPhase2Fetches: 10 })).resolves.toBeUndefined();
      await expect(enrichUsenetLanguages([miss(4)], logger, undefined, {})).resolves.toBeUndefined();
      // A bare `signal?: AbortSignal` — without the explicit `| undefined` — reds this line under eopt.
      await expect(enrichUsenetLanguages([miss(5)], logger, undefined, { signal: undefined })).resolves.toBeUndefined();
    });

    it('is byte-identical to the no-signal run while the signal stays live (AC1 control)', async () => {
      mockFetchWithSsrfRedirect.mockImplementation(async () => new Response(germanNzbXml(), { status: 200 }));
      const live = new AbortController();
      const results = Array.from({ length: 12 }, (_, i) => miss(i));

      await enrichUsenetLanguages(results, logger, undefined, { signal: live.signal });

      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledTimes(12);
      expect(results.map((r) => r.language)).toEqual(Array.from({ length: 12 }, () => 'german'));
      expect(completionLog()).toMatchObject({ nzbFetched: 12, abortSkipped: 0 });
      expect(truncationWarns()).toHaveLength(0);
    });

    it('evicts the queued waiters and nothing else when the abort lands mid-wave (AC2, AC6)', async () => {
      const results = Array.from({ length: 12 }, (_, i) => miss(i));

      await tornRun(results);

      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledTimes(CONCURRENCY);
      expect(completionLog()).toMatchObject({ nzbFetched: 5, abortSkipped: 7 });
      // The five already on the wire ran to completion on their own terms and cached normally.
      for (let i = 0; i < CONCURRENCY; i++) expect(enrichmentCache.get(`test:ab-${i}`)).toBeDefined();
    });

    it('starts no fetch at all under an already-aborted signal (AC2 boundary)', async () => {
      mockFetchWithSsrfRedirect.mockImplementation(async () => new Response(plainNzbXml(), { status: 200 }));
      const results = Array.from({ length: 8 }, (_, i) => miss(i));

      await expect(
        enrichUsenetLanguages(results, logger, undefined, { signal: AbortSignal.abort() }),
      ).resolves.toBeUndefined();

      expect(mockFetchWithSsrfRedirect).not.toHaveBeenCalled();
      expect(completionLog()).toMatchObject({ nzbFetched: 0, abortSkipped: 8 });
    });

    it('skips nothing when every candidate was already admitted (AC2 race boundary)', async () => {
      // Four candidates sit under NZB_FETCH_CONCURRENCY, so none of them ever queues and all four
      // are past `acquire()` when the abort fires. An implementation that derives abort-skipping
      // from an end-of-run `signal.aborted` reds here and nowhere else.
      const { onWire, release } = parkFetches(4, germanNzbXml);
      const controller = new AbortController();
      const results = Array.from({ length: 4 }, (_, i) => miss(i));

      const running = enrichUsenetLanguages(results, logger, undefined, { signal: controller.signal });
      await onWire;
      controller.abort();
      release();
      await running;

      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledTimes(4);
      expect(results.map((r) => r.language)).toEqual(['german', 'german', 'german', 'german']);
      expect(completionLog()).toMatchObject({ nzbFetched: 4, abortSkipped: 0 });
      expect(truncationWarns()).toHaveLength(0);
    });

    it('resolves rather than rejects when the abort races a failing in-flight fetch (AC3)', async () => {
      let open!: () => void;
      const barrier = new Promise<void>((resolve) => { open = resolve; });
      let admit!: () => void;
      const onWire = new Promise<void>((resolve) => { admit = resolve; });
      let started = 0;
      mockFetchWithSsrfRedirect.mockImplementation(async () => {
        if (++started >= CONCURRENCY) admit();
        await barrier;
        throw new Error('ECONNRESET while the NZB was in flight');
      });
      const controller = new AbortController();
      const results = Array.from({ length: 12 }, (_, i) => miss(i));

      const running = enrichUsenetLanguages(results, logger, undefined, { signal: controller.signal });
      await onWire;
      controller.abort();
      open();

      await expect(running).resolves.toBeUndefined();
      expect(completionLog()).toMatchObject({ nzbFetched: 5, abortSkipped: 7 });
    });

    it('propagates a non-abort acquire failure under a live signal (AC2 counterfactual)', async () => {
      mockFetchWithSsrfRedirect.mockImplementation(async () => new Response(plainNzbXml(), { status: 200 }));
      // A bare `catch { return; }` would swallow this — the inverted shape of abort-verdict-not-error-shape.
      const acquire = vi.spyOn(BoundedSemaphore.prototype, 'acquire')
        .mockRejectedValueOnce(new Error('slot queue drained'));
      const live = new AbortController();

      try {
        await expect(
          enrichUsenetLanguages([miss(1)], logger, undefined, { signal: live.signal }),
        ).rejects.toThrow('slot queue drained');
      } finally {
        acquire.mockRestore();
      }

      expect(mockFetchWithSsrfRedirect).not.toHaveBeenCalled();
    });

    it('writes no cache entry for an abort-skipped candidate, so a later run still fetches it (AC4)', async () => {
      await tornRun(Array.from({ length: 12 }, (_, i) => miss(i)));

      for (let i = CONCURRENCY; i < 12; i++) expect(enrichmentCache.get(`test:ab-${i}`)).toBeUndefined();

      mockFetchWithSsrfRedirect.mockReset();
      mockFetchWithSsrfRedirect.mockImplementation(async () => new Response(plainNzbXml(), { status: 200 }));
      await enrichUsenetLanguages(Array.from({ length: 12 }, (_, i) => miss(i)), logger);

      const refetched = mockFetchWithSsrfRedirect.mock.calls.map((c) => c[0]);
      for (let i = CONCURRENCY; i < 12; i++) expect(refetched).toContain(`http://nzb.test/ab-${i}`);
    });

    it('gives abort-skipped candidates free title detection under a distinct tag (AC4)', async () => {
      const results = [
        ...Array.from({ length: CONCURRENCY }, (_, i) => miss(i)),
        miss(5, { title: 'Der Hobbit (Ungekürzt)' }),
        miss(6, { title: 'A Perfectly Ordinary Audiobook' }),
        ...Array.from({ length: 5 }, (_, i) => miss(i + 7)),
      ];

      await tornRun(results);

      expect(results[5]!.language).toBe('german');
      expect(results[6]!.language).toBeUndefined();
      const tagged = taggedDebug('title-abort-skipped');
      expect(tagged).toHaveLength(1);
      expect(tagged[0]![0]).toMatchObject({ title: 'Der Hobbit (Ungekürzt)', matched: 'german' });
      // A trace has to tell a tear from a cap, and this run applied no cap at all.
      expect(taggedDebug('title-cap-skipped')).toHaveLength(0);
    });

    it('still degrades a genuine fetch failure under a live signal (AC3 control)', async () => {
      const live = new AbortController();
      mockFetchWithSsrfRedirect
        .mockResolvedValueOnce(new Response('nope', { status: 500 }))
        .mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const nonOk = miss(1, { title: 'Der Hobbit (Ungekürzt)' });
      const threw = miss(2, { title: 'Das Rad der Zeit (Ungekürzt)' });

      await enrichUsenetLanguages([nonOk, threw], logger, undefined, { signal: live.signal });

      expect(nonOk.language).toBe('german');
      expect(threw.language).toBe('german');
      expect(enrichmentCache.get('test:ab-1')).toMatchObject({ outcome: 'fetch-failed' });
      expect(enrichmentCache.get('test:ab-2')).toMatchObject({ outcome: 'fetch-failed' });
      expect(calls('warn').map((c) => c[1]))
        .toEqual(['NZB fetch failed with non-OK status', 'NZB fetch failed']);
    });

    it('counts cap-skipped and abort-skipped candidates disjointly (AC1, AC6)', async () => {
      // A cap at or below NZB_FETCH_CONCURRENCY leaves no selected-but-unstarted candidate, so the
      // two counters could never be observed together; 8 of 12 selected leaves 3 queued.
      const results = Array.from({ length: 12 }, (_, i) => miss(i, { matchScore: 12 - i }));

      await tornRun(results, { maxPhase2Fetches: 8 });

      const log = completionLog();
      expect(log).toMatchObject({ nzbFetched: 5, abortSkipped: 3, capSkipped: 4 });
      expect(log.nzbFetched! + log.abortSkipped! + log.capSkipped!).toBe(12);
    });

    it('leaves abortSkipped at zero when the cap already skipped everything (AC6 boundary)', async () => {
      mockFetchWithSsrfRedirect.mockImplementation(async () => new Response(plainNzbXml(), { status: 200 }));
      const results = Array.from({ length: 6 }, (_, i) => miss(i));

      await enrichUsenetLanguages(results, logger, undefined, { maxPhase2Fetches: 0, signal: AbortSignal.abort() });

      expect(mockFetchWithSsrfRedirect).not.toHaveBeenCalled();
      expect(completionLog()).toMatchObject({ capSkipped: 6, abortSkipped: 0, nzbFetched: 0 });
      expect(truncationWarns()).toHaveLength(0);
    });

    it('propagates a language an abort-skipped representative recovered to its duplicates (AC5)', async () => {
      const fillers = Array.from({ length: CONCURRENCY }, (_, i) => miss(i));
      const rep = miss(99, { guid: 'dup', downloadUrl: 'http://nzb.test/dup-high', matchScore: 9, title: 'Der Hobbit (Ungekürzt)' });
      const member = miss(98, { guid: 'dup', downloadUrl: 'http://nzb.test/dup-low', matchScore: 1, title: 'The Hobbit' });

      await tornRun([...fillers, rep, member]);

      expect(rep.language).toBe('german');
      // Reds if abort-skipped title detection is placed AFTER propagateDuplicates.
      expect(member.language).toBe('german');
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'The Hobbit', signal: 'within-run-dup', language: 'german' }),
        expect.any(String),
      );
    });

    it('resolves with no fetch on empty and torrent-only inputs under an aborted signal', async () => {
      const aborted = AbortSignal.abort();

      await expect(enrichUsenetLanguages([], logger, undefined, { signal: aborted })).resolves.toBeUndefined();
      await expect(
        enrichUsenetLanguages([makeResult({ title: 'Torrent Only' })], logger, undefined, { signal: aborted }),
      ).resolves.toBeUndefined();

      expect(mockFetchWithSsrfRedirect).not.toHaveBeenCalled();
      expect(truncationWarns()).toHaveLength(0);
    });

    it('logs the truncation exactly once, with its sibling counters (AC7)', async () => {
      await tornRun(Array.from({ length: 12 }, (_, i) => miss(i)));

      const warns = truncationWarns();
      expect(warns).toHaveLength(1);
      expect(warns[0]![0]).toMatchObject({ abortSkipped: 7, nzbFetched: 5 });
    });
  });
});

function germanNzbXml(name?: string): string {
  const head = name ? `<head><meta type="name">${name}</meta></head>` : '';
  return `<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
    ${head}
    <file poster="t" date="1" subject="t">
      <groups><group>alt.binaries.german</group></groups>
      <segments><segment bytes="1" number="1">id@e</segment></segments>
    </file>
  </nzb>`;
}

function plainNzbXml(): string {
  return `<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
    <file poster="t" date="1" subject="Plain English Audiobook MP3">
      <groups><group>alt.binaries.audiobooks</group></groups>
      <segments><segment bytes="1" number="1">id@e</segment></segments>
    </file>
  </nzb>`;
}
