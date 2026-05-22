import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { SearchResult } from '../../core/indexers/types.js';
import type * as NetworkServiceModule from '../../core/utils/network-service.js';
import { enrichUsenetLanguages } from './enrich-usenet-languages.js';

const mockDispatcher = { close: vi.fn().mockResolvedValue(undefined) };

vi.mock('../../core/utils/network-service.js', async (importActual) => {
  const actual = await importActual<typeof NetworkServiceModule>();
  return {
    ...actual,
    fetchWithSsrfRedirect: vi.fn(),
    createSsrfSafeDispatcher: vi.fn(() => mockDispatcher),
  };
});

import { fetchWithSsrfRedirect, createSsrfSafeDispatcher } from '../../core/utils/network-service.js';
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

      // Group says german, NZB name says dutch — group wins
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
      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledWith(
        'http://nzb.test/1',
        expect.objectContaining({ dispatcher: mockDispatcher, timeoutMs: 5000 }),
      );
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
      // Helper now follows the 302 instead of throwing — the response body is
      // an HTML login page. Parser fails to extract groups, no language set.
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

      // Phase-1 input log
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Test Book', protocol: 'usenet', hasNewsgroup: false, hasDownloadUrl: true }),
        'Enrichment phase-1 input',
      );
      // Phase-2 fetch + parse
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Test Book', url: expect.any(String) }),
        'Phase-2: fetching NZB',
      );
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Test Book', groupCount: 2 }),
        'Phase-2: NZB parsed',
      );
      // Per-pattern detection attempt with explicit signal naming
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Test Book', signal: 'newsgroup-token', testedAgainst: expect.any(String) }),
        'Detection attempt',
      );
      // Final outcome
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

      // The newsgroup-token attempt against alt.binaries.audiobooks must log matched: null
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ signal: 'newsgroup-token', testedAgainst: 'alt.binaries.audiobooks', matched: null }),
        'Detection attempt',
      );
      // The nzb-name-pattern fallback must also log
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
      // Debug trace records source: 'title' so the path is observable
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Stephen King – Fairy Tale (Ungekrzt)',
          finalLanguage: 'german',
          source: 'title',
        }),
        'Phase-2: enrichment complete',
      );
      // Per-pattern detection-attempt log emitted for the title signal
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
      // nzbName matches german (Hörbuch), title matches dutch (Luisterboek).
      // The earlier signal (nzbName) must win; the title fallback must NOT run.
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
      // The title-pattern detection attempt must NOT have been emitted
      const titleAttempts = (logger.debug as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([fields]) => (fields as Record<string, unknown>)?.signal === 'title-pattern',
      );
      expect(titleAttempts).toHaveLength(0);
    });

    it('Phase-2: title fallback still runs when downloadUrl is present and newsgroup is generic — no Phase-1 short-circuit on title', async () => {
      // Generic newsgroup falls through to the NZB fetch (per #533 wiring); the
      // fetch is required to populate nzbName for downstream filterMultiPartUsenet.
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

      expect(mockFetchWithSsrfRedirect).toHaveBeenCalledTimes(1); // fetch still happened
      expect(results[0]!.nzbName).toBe('Fairy.Tale.part01.rar'); // nzbName populated
      expect(results[0]!.language).toBe('german'); // language from title fallback
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
});
