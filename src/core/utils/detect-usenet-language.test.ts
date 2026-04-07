import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { SearchResult } from '../indexers/types.js';
import {
  detectLanguageFromNewsgroup,
  parseNzbGroups,
  enrichUsenetLanguages,
} from './detect-usenet-language.js';

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

describe('detectLanguageFromNewsgroup', () => {
  describe('token-to-language mapping', () => {
    it('maps "german" token to "german"', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.german')).toBe('german');
    });

    it('maps "hoerbuecher" token to "german"', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.sounds.mp3.german.hoerbuecher')).toBe('german');
    });

    it('maps "hoerspiele" token to "german"', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.hoerspiele')).toBe('german');
    });

    it('maps "deutsch" token to "german"', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.deutsch')).toBe('german');
    });

    it('maps "french" token to "french"', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.french')).toBe('french');
    });

    it('maps "francais" token to "french"', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.francais')).toBe('french');
    });

    it('maps "dutch" token to "dutch"', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.dutch')).toBe('dutch');
    });

    it('maps "nederlands" token to "dutch"', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.nederlands')).toBe('dutch');
    });

    it('maps "audioboeken" token to "dutch"', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.audioboeken')).toBe('dutch');
    });

    it('maps "luisterboeken" token to "dutch"', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.luisterboeken')).toBe('dutch');
    });

    it('maps "spanish" token to "spanish"', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.spanish')).toBe('spanish');
    });

    it('maps "italian" token to "italian"', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.italian')).toBe('italian');
    });

    it('maps "italiano" token to "italian"', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.italiano')).toBe('italian');
    });

    it('maps "japanese" token to "japanese"', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.japanese')).toBe('japanese');
    });

    it('maps "nihongo" token to "japanese"', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.nihongo')).toBe('japanese');
    });
  });

  describe('group name parsing', () => {
    it('returns undefined for unknown tokens like mp3, audiobooks, sounds, binaries', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.sounds.mp3.audiobooks')).toBeUndefined();
    });

    it('first language-specific token wins when group contains multiple (alt.binaries.german.french → german)', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.german.french')).toBe('german');
    });

    it('returns undefined for empty string input', () => {
      expect(detectLanguageFromNewsgroup('')).toBeUndefined();
    });

    it('returns undefined for undefined input', () => {
      expect(detectLanguageFromNewsgroup(undefined)).toBeUndefined();
    });

    it('matches tokens case-insensitively (GERMAN, German, german all resolve)', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.GERMAN')).toBe('german');
      expect(detectLanguageFromNewsgroup('alt.binaries.German')).toBe('german');
      expect(detectLanguageFromNewsgroup('alt.binaries.german')).toBe('german');
    });

    it('returns undefined for group with only dots (e.g., "...")', () => {
      expect(detectLanguageFromNewsgroup('...')).toBeUndefined();
    });

    it('detects language from single token input (e.g., just "german")', () => {
      expect(detectLanguageFromNewsgroup('german')).toBe('german');
    });
  });
});

describe('parseNzbGroups', () => {
  it('extracts single group tag from NZB XML', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE nzb PUBLIC "-//newzBin//DTD NZB 1.1//EN" "http://www.newzbin.com/DTD/nzb/nzb-1.1.dtd">
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <file poster="test@example.com" date="1234567890" subject="test">
    <groups><group>alt.binaries.german.hoerbuecher</group></groups>
    <segments><segment bytes="100" number="1">test@example.com</segment></segments>
  </file>
</nzb>`;
    expect(parseNzbGroups(xml)).toEqual(['alt.binaries.german.hoerbuecher']);
  });

  it('extracts multiple group tags from NZB XML', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <file poster="test" date="123" subject="test">
    <groups>
      <group>alt.binaries.german.hoerbuecher</group>
      <group>alt.binaries.sounds.mp3</group>
    </groups>
    <segments><segment bytes="100" number="1">id@example</segment></segments>
  </file>
</nzb>`;
    const groups = parseNzbGroups(xml);
    expect(groups).toContain('alt.binaries.german.hoerbuecher');
    expect(groups).toContain('alt.binaries.sounds.mp3');
  });

  it('returns empty array for NZB with no group tags', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <file poster="test" date="123" subject="test">
    <segments><segment bytes="100" number="1">id@example</segment></segments>
  </file>
</nzb>`;
    expect(parseNzbGroups(xml)).toEqual([]);
  });

  it('returns empty array for malformed XML', () => {
    expect(parseNzbGroups('not xml at all <><><')).toEqual([]);
  });

  it('skips empty group tags (no text content)', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <file poster="test" date="123" subject="test">
    <groups>
      <group></group>
      <group>alt.binaries.german.hoerbuecher</group>
    </groups>
    <segments><segment bytes="100" number="1">id@example</segment></segments>
  </file>
</nzb>`;
    expect(parseNzbGroups(xml)).toEqual(['alt.binaries.german.hoerbuecher']);
  });
});

describe('enrichUsenetLanguages', () => {
  let logger: FastifyBaseLogger;

  beforeEach(() => {
    logger = createMockLogger();
    vi.restoreAllMocks();
  });

  describe('newsgroup short-circuit', () => {
    it('detects language from existing newsgroup field without NZB fetch', async () => {
      const results = [
        makeResult({ protocol: 'usenet', newsgroup: 'alt.binaries.german.hoerbuecher', downloadUrl: 'http://nzb.test/1' }),
      ];
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      await enrichUsenetLanguages(results, logger);

      expect(results[0].language).toBe('german');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('sets language to "german" from newsgroup alt.binaries.german.hoerbuecher without fetch', async () => {
      const results = [
        makeResult({ protocol: 'usenet', newsgroup: 'alt.binaries.german.hoerbuecher', downloadUrl: 'http://nzb.test/1' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0].language).toBe('german');
    });

    it('leaves language undefined for generic newsgroup, does NOT fetch NZB', async () => {
      const results = [
        makeResult({ protocol: 'usenet', newsgroup: 'alt.binaries.mp3.audiobooks', downloadUrl: 'http://nzb.test/1' }),
      ];
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      await enrichUsenetLanguages(results, logger);

      expect(results[0].language).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('fetches NZB when newsgroup is absent and downloadUrl is present', async () => {
      const nzbXml = `<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
        <file poster="test" date="123" subject="test">
          <groups><group>alt.binaries.french</group></groups>
          <segments><segment bytes="100" number="1">id@example</segment></segments>
        </file>
      </nzb>`;
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(nzbXml, { status: 200 }),
      );

      const results = [
        makeResult({ protocol: 'usenet', newsgroup: undefined, downloadUrl: 'http://nzb.test/1' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0].language).toBe('french');
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
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
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(nzbXml, { status: 200 }),
      );

      const results = [
        makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0].language).toBe('german');
    });

    it('skips results that already have language set', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const results = [
        makeResult({ protocol: 'usenet', language: 'english', downloadUrl: 'http://nzb.test/1' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0].language).toBe('english');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('skips results without downloadUrl', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const results = [
        makeResult({ protocol: 'usenet', downloadUrl: undefined }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0].language).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('skips torrent results regardless of language state', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const results = [
        makeResult({ protocol: 'torrent', downloadUrl: 'magnet:?xt=urn:btih:aaa' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0].language).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('leaves language undefined when NZB fetch returns 404', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('Not Found', { status: 404 }),
      );

      const results = [
        makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0].language).toBeUndefined();
      expect(logger.warn).toHaveBeenCalled();
    });

    it('leaves language undefined when NZB fetch times out', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('The operation was aborted'));

      const results = [
        makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0].language).toBeUndefined();
      expect(logger.warn).toHaveBeenCalled();
    });

    it('leaves language undefined when NZB contains invalid XML', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
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
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
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
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(nzbXml, { status: 200 }),
      );

      const results = [
        makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0].language).toBe('german');
    });

    it('normalizes detected language through normalizeLanguage()', async () => {
      // normalizeLanguage should pass through canonical names unchanged
      const results = [
        makeResult({ protocol: 'usenet', newsgroup: 'alt.binaries.FRENCH', downloadUrl: 'http://nzb.test/1' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(results[0].language).toBe('french');
    });
  });

  describe('concurrency and parallelism', () => {
    it('runs NZB fetches in parallel up to concurrency limit', async () => {
      const callOrder: number[] = [];
      let fetchCount = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        const idx = fetchCount++;
        callOrder.push(idx);
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

      // All 8 should be fetched and enriched
      expect(fetchCount).toBe(8);
      results.forEach(r => expect(r.language).toBe('german'));
    });

    it('queues excess fetches beyond concurrency limit', async () => {
      let concurrent = 0;
      let maxConcurrent = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
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

      // Concurrency should be capped at 5
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
      vi.spyOn(globalThis, 'fetch')
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
      vi.spyOn(globalThis, 'fetch')
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
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
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
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fail'));

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
      vi.spyOn(globalThis, 'fetch')
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
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('timeout'));

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
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const results = [makeResult({ protocol: 'torrent' })];

      await enrichUsenetLanguages(results, logger);

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('skips all results when all already have language', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const results = [
        makeResult({ protocol: 'usenet', language: 'english', downloadUrl: 'http://nzb.test/1' }),
        makeResult({ protocol: 'usenet', language: 'french', downloadUrl: 'http://nzb.test/2' }),
      ];

      await enrichUsenetLanguages(results, logger);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(results[0].language).toBe('english');
      expect(results[1].language).toBe('french');
    });
  });
});
