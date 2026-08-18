/**
 * #2367 — a detail-fetch failure is the one drop reason an operator cannot afford to miss: the row
 * vanishes from the result list and, before this, nothing in the logs said a page had failed to
 * load. It is therefore the one reason that logs at `warn` rather than `debug`.
 */
import { describe, it, expect, type Mock } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { IndexerParseStats, IndexerParseTrace, IndexerSearchResponse } from '@core/index.js';
import { logIndexerSearchTrace } from './indexer-search-trace.js';
import type { IndexerRow } from './types.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';

const INDEXER = inject<IndexerRow>({ name: 'AudioBookBay', type: 'abb' });

const FAILURE: IndexerParseTrace = {
  source: 'row',
  reason: 'dropped:detail-fetch-failed',
  rawTitle: 'Murder in the New Forest',
  rawTitleBytes: '4d7572646572',
  errorMessage: 'HTTP 500: Internal Server Error',
  errorCode: 'ECONNREFUSED',
  httpStatus: 500,
  requestUrl: 'https://abb.test/audio-books/murder-in-the-new-forest/?token=hunter2',
};

const NO_DROPS: IndexerParseStats['dropped'] = { emptyTitle: 0, noUrl: 0, other: 0 };

function run(debugTrace: IndexerParseTrace[], dropped = NO_DROPS): Record<string, Mock | string> {
  const log = createMockLogger();
  const response: IndexerSearchResponse = {
    results: [],
    parseStats: { itemsObserved: debugTrace.length, kept: 0, dropped },
    debugTrace,
  };
  logIndexerSearchTrace(inject<FastifyBaseLogger>(log), INDEXER, response);
  return log;
}

function callsWith(log: Record<string, Mock | string>, level: 'warn' | 'debug', message: string) {
  return (log[level] as Mock).mock.calls.filter((call) => call[1] === message) as Array<[Record<string, unknown>, string]>;
}

describe('logIndexerSearchTrace', () => {
  it('raises a detail-fetch failure to warn with the failure\'s structural identity', () => {
    const log = run([FAILURE]);

    const warnings = callsWith(log, 'warn', 'Indexer detail fetch failed');
    expect(warnings).toHaveLength(1);
    expect((log.warn as Mock).mock.calls).toHaveLength(1);
    expect(warnings[0]![0]).toEqual({
      indexer: 'AudioBookBay',
      reason: 'dropped:detail-fetch-failed',
      rawTitle: 'Murder in the New Forest',
      rawTitleBytes: '4d7572646572',
      errorMessage: 'HTTP 500: Internal Server Error',
      errorCode: 'ECONNREFUSED',
      httpStatus: 500,
      url: 'https://abb.test/audio-books/murder-in-the-new-forest/',
    });
    // The summary line is the only debug this response earns; the failure is not also logged there.
    expect(callsWith(log, 'debug', 'Indexer dropped item')).toEqual([]);
  });

  it('leaves every other drop reason on the existing debug line', () => {
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

  it('logs the request URL with its query string stripped', () => {
    const log = run([{ ...FAILURE, requestUrl: 'https://abb.test/audio-books/murder/?apikey=hunter2#frag' }]);

    const payload = callsWith(log, 'warn', 'Indexer detail fetch failed')[0]![0];
    expect(payload.url).toBe('https://abb.test/audio-books/murder/');
    expect(JSON.stringify(payload)).not.toContain('hunter2');
  });

  it('omits an absent optional field instead of logging the key as undefined', () => {
    const log = run([{
      source: 'row',
      reason: 'dropped:detail-fetch-failed',
      rawTitle: 'Murder in the New Forest',
      errorMessage: 'socket hang up',
    }]);

    const payload = callsWith(log, 'warn', 'Indexer detail fetch failed')[0]![0];
    expect(payload.errorMessage).toBe('socket hang up');
    expect(payload).not.toHaveProperty('rawTitleBytes');
    expect(payload).not.toHaveProperty('errorCode');
    expect(payload).not.toHaveProperty('httpStatus');
    expect(payload).not.toHaveProperty('url');
  });

  it('still reports the search summary, carrying the new other count', () => {
    const log = run([FAILURE], { emptyTitle: 0, noUrl: 1, other: 2 });

    const summary = callsWith(log, 'debug', 'Indexer search complete');
    expect(summary).toHaveLength(1);
    expect(summary[0]![0]).toEqual({
      indexer: 'AudioBookBay',
      type: 'abb',
      itemsObserved: 1,
      kept: 0,
      dropped: { emptyTitle: 0, noUrl: 1, other: 2 },
    });
  });
});
