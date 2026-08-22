import { describe, it, expect } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { IndexerParseStats, IndexerParseTrace, IndexerSearchResponse } from '@core/index.js';
import { logIndexerSearchTrace } from './indexer-search-trace.js';
import type { IndexerRow } from './types.js';
import { createMockLogger, inject, type MockLogger } from '../__tests__/helpers.js';

const INDEXER = inject<IndexerRow>({ name: 'AudioBookBay', type: 'abb' });

const NO_DROPS: IndexerParseStats['dropped'] = { emptyTitle: 0, noUrl: 0, other: 0 };

function run(debugTrace: IndexerParseTrace[], dropped = NO_DROPS): MockLogger {
  const log = createMockLogger();
  const response: IndexerSearchResponse = {
    results: [],
    parseStats: { itemsObserved: debugTrace.length, kept: 0, dropped },
    debugTrace,
  };
  logIndexerSearchTrace(inject<FastifyBaseLogger>(log), INDEXER, response);
  return log;
}

function callsWith(log: MockLogger, level: 'warn' | 'debug', message: string) {
  return log[level].mock.calls.filter((call) => call[1] === message) as Array<[Record<string, unknown>, string]>;
}

describe('logIndexerSearchTrace', () => {
  it('reports every drop reason on the debug line and keeps kept rows off it', () => {
    const log = run([
      { source: 'row', reason: 'kept', rawTitle: 'Kept Book', rawTitleBytes: 'aa', guid: 'abc' },
      { source: 'row', reason: 'dropped:empty-title' },
      { source: 'row', reason: 'dropped:no-url', rawTitle: 'No Torrent', rawTitleBytes: 'bb' },
    ]);

    expect(log.warn).not.toHaveBeenCalled();
    const drops = callsWith(log, 'debug', 'Indexer dropped item');
    expect(drops.map((call) => call[0].reason)).toEqual(['dropped:empty-title', 'dropped:no-url']);
    expect(drops[1]![0]).toMatchObject({
      indexer: 'AudioBookBay',
      rawTitle: 'No Torrent',
      rawTitleBytes: 'bb',
    });
  });

  /**
   * #2421 — an obfuscated ABB post that would not base64-decode leaves no result and no other
   * trace of itself, so the generic debug branch plus the `other` count in the summary is the whole
   * of what an operator can see. Asserted rather than assumed to fall out of the generic branch.
   */
  it('reports an undecodable re-ab row on the debug line and in the summary\'s other count', () => {
    const log = run(
      [{ source: 'row', reason: 'dropped:re-ab-undecodable' }],
      { emptyTitle: 0, noUrl: 0, other: 1 },
    );

    expect(log.warn).not.toHaveBeenCalled();
    const drops = callsWith(log, 'debug', 'Indexer dropped item');
    expect(drops).toHaveLength(1);
    expect(drops[0]![0].reason).toBe('dropped:re-ab-undecodable');
    expect(callsWith(log, 'debug', 'Indexer search complete')[0]![0].dropped).toEqual({
      emptyTitle: 0,
      noUrl: 0,
      other: 1,
    });
  });

  it('logs the search request URL with its query string stripped', () => {
    const log = createMockLogger();
    const response: IndexerSearchResponse = {
      results: [],
      parseStats: { itemsObserved: 0, kept: 0, dropped: NO_DROPS },
      debugTrace: [],
      requestUrl: 'https://abb.test/?s=murder&apikey=hunter2',
    };
    logIndexerSearchTrace(inject<FastifyBaseLogger>(log), INDEXER, response);

    const payload = callsWith(log, 'debug', 'Indexer search complete')[0]![0];
    expect(payload.url).toBe('https://abb.test/');
    expect(JSON.stringify(payload)).not.toContain('hunter2');
  });

  it('still reports the search summary, carrying the drop counts', () => {
    const log = run(
      [{ source: 'row', reason: 'dropped:empty-title' }],
      { emptyTitle: 1, noUrl: 1, other: 2 },
    );

    const summary = callsWith(log, 'debug', 'Indexer search complete');
    expect(summary).toHaveLength(1);
    expect(summary[0]![0]).toEqual({
      indexer: 'AudioBookBay',
      type: 'abb',
      itemsObserved: 1,
      kept: 0,
      dropped: { emptyTitle: 1, noUrl: 1, other: 2 },
    });
  });
});
