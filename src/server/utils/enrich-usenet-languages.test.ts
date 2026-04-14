import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { SearchResult } from '../../core/indexers/types.js';
import { enrichUsenetLanguages } from './enrich-usenet-languages.js';

vi.mock('../../core/utils/fetch-with-timeout.js', () => ({
  fetchWithTimeout: vi.fn(),
}));

import { fetchWithTimeout } from '../../core/utils/fetch-with-timeout.js';
const mockFetchWithTimeout = vi.mocked(fetchWithTimeout);

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
    mockFetchWithTimeout.mockReset();
  });

  describe('newsgroup short-circuit', () => {
    it('detects language from existing newsgroup field without NZB fetch', async () => {
      const results = [
        makeResult({ protocol: 'usenet', newsgroup: 'alt.binaries.german.hoerbuecher', downloadUrl: 'http://nzb.test/1' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0].language).toBe('german');
      expect(mockFetchWithTimeout).not.toHaveBeenCalled();
    });

    it('sets language to "german" from newsgroup alt.binaries.german.hoerbuecher without fetch', async () => {
      const results = [
        makeResult({ protocol: 'usenet', newsgroup: 'alt.binaries.german.hoerbuecher', downloadUrl: 'http://nzb.test/1' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0].language).toBe('german');
    });

    it('falls through to NZB fetch for generic newsgroup (alt.binaries.audiobooks) and populates nzbName', async () => {
      const nzbXml = `<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
        <head><meta type="name">Stephen King-H?rbuch-Pack.part01.rar</meta></head>
        <file poster="test" date="123" subject="test">
          <groups><group>alt.binaries.audiobooks</group></groups>
          <segments><segment bytes="100" number="1">id@example</segment></segments>
        </file>
      </nzb>`;
      mockFetchWithTimeout.mockResolvedValueOnce(
        new Response(nzbXml, { status: 200 }),
      );

      const results = [
        makeResult({ protocol: 'usenet', newsgroup: 'alt.binaries.mp3.audiobooks', downloadUrl: 'http://nzb.test/1' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(mockFetchWithTimeout).toHaveBeenCalledWith('http://nzb.test/1', {}, 5000);
      expect(results[0].nzbName).toBe('Stephen King-H?rbuch-Pack.part01.rar');
      expect(results[0].language).toBe('german');
    });

    it('fetches NZB when newsgroup is absent and downloadUrl is present', async () => {
      const nzbXml = `<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
        <file poster="test" date="123" subject="test">
          <groups><group>alt.binaries.french</group></groups>
          <segments><segment bytes="100" number="1">id@example</segment></segments>
        </file>
      </nzb>`;
      mockFetchWithTimeout.mockResolvedValueOnce(
        new Response(nzbXml, { status: 200 }),
      );

      const results = [
        makeResult({ protocol: 'usenet', newsgroup: undefined, downloadUrl: 'http://nzb.test/1' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0].language).toBe('french');
      expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
      expect(mockFetchWithTimeout).toHaveBeenCalledWith('http://nzb.test/1', {}, 5000);
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
      mockFetchWithTimeout.mockResolvedValueOnce(
        new Response(nzbXml, { status: 200 }),
      );

      const results = [
        makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0].language).toBe('german');
    });

    it('skips results that already have language set', async () => {
      const results = [
        makeResult({ protocol: 'usenet', language: 'english', downloadUrl: 'http://nzb.test/1' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0].language).toBe('english');
      expect(mockFetchWithTimeout).not.toHaveBeenCalled();
    });

    it('skips results without downloadUrl', async () => {
      const results = [
        makeResult({ protocol: 'usenet', downloadUrl: undefined }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0].language).toBeUndefined();
      expect(mockFetchWithTimeout).not.toHaveBeenCalled();
    });

    it('skips torrent results regardless of language state', async () => {
      const results = [
        makeResult({ protocol: 'torrent', downloadUrl: 'magnet:?xt=urn:btih:aaa' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0].language).toBeUndefined();
      expect(mockFetchWithTimeout).not.toHaveBeenCalled();
    });

    it('leaves language undefined when NZB fetch returns 404', async () => {
      mockFetchWithTimeout.mockResolvedValueOnce(
        new Response('Not Found', { status: 404 }),
      );

      const results = [
        makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0].language).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Test Book', status: 404 }),
        expect.any(String),
      );
    });

    it('leaves language undefined when NZB fetch times out', async () => {
      mockFetchWithTimeout.mockRejectedValueOnce(new Error('The operation was aborted'));

      const results = [
        makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0].language).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Test Book', error: 'The operation was aborted' }),
        expect.any(String),
      );
    });

    it('leaves language undefined when NZB contains invalid XML', async () => {
      mockFetchWithTimeout.mockResolvedValueOnce(
        new Response('not xml <><><', { status: 200 }),
      );

      const results = [
        makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0].language).toBeUndefined();
    });

    it('leaves language undefined for NZB with only generic groups', async () => {
      const nzbXml = `<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
        <file poster="test" date="123" subject="test">
          <groups><group>alt.binaries.mp3.audiobooks</group></groups>
          <segments><segment bytes="100" number="1">id@example</segment></segments>
        </file>
      </nzb>`;
      mockFetchWithTimeout.mockResolvedValueOnce(
        new Response(nzbXml, { status: 200 }),
      );

      const results = [
        makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0].language).toBeUndefined();
    });

    it('sets language to "german" for NZB with german.hoerbuecher group', async () => {
      const nzbXml = `<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
        <file poster="test" date="123" subject="test">
          <groups><group>alt.binaries.sounds.mp3.german.hoerbuecher</group></groups>
          <segments><segment bytes="100" number="1">id@example</segment></segments>
        </file>
      </nzb>`;
      mockFetchWithTimeout.mockResolvedValueOnce(
        new Response(nzbXml, { status: 200 }),
      );

      const results = [
        makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0].language).toBe('german');
    });

    it('normalizes detected language through normalizeLanguage()', async () => {
      const results = [
        makeResult({ protocol: 'usenet', newsgroup: 'alt.binaries.FRENCH', downloadUrl: 'http://nzb.test/1' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0].language).toBe('french');
    });
  });

  describe('concurrency and parallelism', () => {
    it('runs NZB fetches in parallel up to concurrency limit', async () => {
      let fetchCount = 0;
      mockFetchWithTimeout.mockImplementation(async () => {
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
      mockFetchWithTimeout.mockImplementation(async () => {
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
      mockFetchWithTimeout
        .mockRejectedValueOnce(new Error('Network failure'))
        .mockResolvedValueOnce(new Response(germanNzb, { status: 200 }));

      const results = [
        makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1', title: 'Failing' }),
        makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/2', title: 'Succeeding' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0].language).toBeUndefined();
      expect(results[1].language).toBe('german');
    });

    it('NZB parsing failure on one result does not affect other results', async () => {
      const germanNzb = `<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
        <file poster="t" date="1" subject="t">
          <groups><group>alt.binaries.german</group></groups>
          <segments><segment bytes="1" number="1">id@e</segment></segments>
        </file>
      </nzb>`;
      mockFetchWithTimeout
        .mockResolvedValueOnce(new Response('garbage xml <><><', { status: 200 }))
        .mockResolvedValueOnce(new Response(germanNzb, { status: 200 }));

      const results = [
        makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1', title: 'BadXml' }),
        makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/2', title: 'GoodXml' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0].language).toBeUndefined();
      expect(results[1].language).toBe('german');
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
      mockFetchWithTimeout.mockResolvedValueOnce(
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
      mockFetchWithTimeout.mockRejectedValue(new Error('fail'));

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
      mockFetchWithTimeout
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
      mockFetchWithTimeout.mockRejectedValueOnce(new Error('timeout'));

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

      expect(mockFetchWithTimeout).not.toHaveBeenCalled();
    });

    it('skips all results when all already have language', async () => {
      const results = [
        makeResult({ protocol: 'usenet', language: 'english', downloadUrl: 'http://nzb.test/1' }),
        makeResult({ protocol: 'usenet', language: 'french', downloadUrl: 'http://nzb.test/2' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(mockFetchWithTimeout).not.toHaveBeenCalled();
      expect(results[0].language).toBe('english');
      expect(results[1].language).toBe('french');
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
      mockFetchWithTimeout.mockResolvedValueOnce(
        new Response(nzbWithName('Stephen King-Pack.rar'), { status: 200 }),
      );
      const results = [makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' })];

      await enrichUsenetLanguages(results, logger);

      expect(results[0].nzbName).toBe('Stephen King-Pack.rar');
    });

    it('sets nzbName even when no language detected from it', async () => {
      mockFetchWithTimeout.mockResolvedValueOnce(
        new Response(nzbWithName('Stephen King - The Stand MP3'), { status: 200 }),
      );
      const results = [makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' })];

      await enrichUsenetLanguages(results, logger);

      expect(results[0].nzbName).toBe('Stephen King - The Stand MP3');
      expect(results[0].language).toBeUndefined();
    });

    it('does not set nzbName on torrent results', async () => {
      const results = [makeResult({ protocol: 'torrent' })];

      await enrichUsenetLanguages(results, logger);

      expect(results[0].nzbName).toBeUndefined();
      expect(mockFetchWithTimeout).not.toHaveBeenCalled();
    });

    it('detects language from NZB name when newsgroup detection finds nothing', async () => {
      mockFetchWithTimeout.mockResolvedValueOnce(
        new Response(nzbWithName('Stephen King-Hörbuch-Pack.rar'), { status: 200 }),
      );
      const results = [makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' })];

      await enrichUsenetLanguages(results, logger);

      expect(results[0].language).toBe('german');
      expect(results[0].nzbName).toBe('Stephen King-Hörbuch-Pack.rar');
    });

    it('newsgroup-based detection takes priority over NZB name detection', async () => {
      mockFetchWithTimeout.mockResolvedValueOnce(
        new Response(nzbWithName('Luisterboek NL.rar', 'alt.binaries.german'), { status: 200 }),
      );
      const results = [makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' })];

      await enrichUsenetLanguages(results, logger);

      // Group says german, NZB name says dutch — group wins
      expect(results[0].language).toBe('german');
    });

    it('uses file subject as fallback when <meta type="name"> is absent', async () => {
      mockFetchWithTimeout.mockResolvedValueOnce(
        new Response(nzbWithoutName(), { status: 200 }),
      );
      const results = [makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' })];

      await enrichUsenetLanguages(results, logger);

      expect(results[0].nzbName).toBe('File Subject Fallback');
    });

    it('does not overwrite existing result.language with NZB name detection', async () => {
      const results = [makeResult({ protocol: 'usenet', language: 'english', downloadUrl: 'http://nzb.test/1' })];

      await enrichUsenetLanguages(results, logger);

      expect(results[0].language).toBe('english');
      expect(mockFetchWithTimeout).not.toHaveBeenCalled();
    });

    it('does not set nzbName when fetch fails', async () => {
      mockFetchWithTimeout.mockRejectedValueOnce(new Error('timeout'));
      const results = [makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' })];

      await enrichUsenetLanguages(results, logger);

      expect(results[0].nzbName).toBeUndefined();
    });

    it('does not fetch when downloadUrl is empty string', async () => {
      const results = [makeResult({ protocol: 'usenet', downloadUrl: '' })];

      await enrichUsenetLanguages(results, logger);

      expect(results[0].nzbName).toBeUndefined();
      expect(mockFetchWithTimeout).not.toHaveBeenCalled();
    });
  });

  describe('URL credential sanitization in logs', () => {
    it('logs sanitized URL on non-OK status (strips query params)', async () => {
      const results = [makeResult({
        protocol: 'usenet',
        downloadUrl: 'https://indexer.example.com/nzb/12345?apikey=SECRET',
      })];

      mockFetchWithTimeout.mockResolvedValue({ ok: false, status: 403, text: vi.fn() } as any);

      await enrichUsenetLanguages(results, logger);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://indexer.example.com/nzb/12345',
        }),
        expect.any(String),
      );
      const warnCall = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
      expect(warnCall.url).not.toContain('SECRET');
    });

    it('logs sanitized URL on fetch error (strips query params)', async () => {
      const results = [makeResult({
        protocol: 'usenet',
        downloadUrl: 'https://indexer.example.com/nzb/12345?apikey=SECRET',
      })];

      mockFetchWithTimeout.mockRejectedValue(new Error('Network error'));

      await enrichUsenetLanguages(results, logger);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://indexer.example.com/nzb/12345',
        }),
        expect.any(String),
      );
      const warnCall = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
      expect(warnCall.url).not.toContain('SECRET');
    });
  });
});
