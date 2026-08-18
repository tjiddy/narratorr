/**
 * #2422 — the apostrophe-bearing query reaches the REAL AudioBookBay adapter, folded, on every
 * rung, while the real Newznab-family adapter beside it keeps asking exactly what it asks today.
 *
 * Every assertion here reads the request URL that actually left over MSW. A mock adapter cannot
 * prove any of it: the defect lives in the plumbing between the service and the real adapters,
 * and an injected double is free to have whatever query-building behaviour the test wants
 * (see `degrading-adapter-invisible-to-mock-suite`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { FastifyBaseLogger } from 'fastify';
import { IndexerService } from './indexer.service.js';
import { IndexerSearchService } from './indexer-search.service.js';
import { createAggregateExecutor, createStreamingExecutor } from './search-ladder-execution.js';
import { buildQueryLadder, runQueryLadder, MAX_SEARCH_RUNGS } from './search-query-ladder.js';
import { NOOP_SINK } from './search-event-sink.js';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import { createMockDbIndexer } from '../__tests__/factories.js';
import { initializeKey, _resetKey } from '../utils/secret-codec.js';
import { AudioBookBayIndexer } from '@core/indexers/abb.js';
import { abbThrottle, _resetAbbThrottleForTesting } from '@core/indexers/abb-throttle.js';
import { TorznabIndexer } from '@core/indexers/torznab.js';
import { useMswServer } from '@core/__tests__/msw/server.js';
import type { Db } from '@db/index.js';

const TEST_KEY = Buffer.from('a'.repeat(64), 'hex');
const ABB_HOST = 'abb.test';
const TORZNAB_URL = 'https://torznab.test/api/v2.0/indexers/x/results/torznab';

/** No colon: a two-rung ladder, so rung 1 is the only rung anything reaches. */
const SIMPLE_TITLE = "A Dragon Rider's Guide to Retirement";
/** Colon-segmented, so relaxation rungs genuinely exist to assert on. */
const DEEP_TITLE = "A Dragon Rider's Guide: The Retirement Chronicles: Book One";
const AUTHOR = 'Julia Huni';

const EMPTY_RSS = '<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>';

interface Captured {
  abb: string[];
  torznab: string[];
}

/** Two real adapters — the real ABB and a real Torznab — behind one real search service. */
function build() {
  const rows = [
    createMockDbIndexer({ id: 1, name: 'AudioBookBay', type: 'abb', priority: 0, settings: {} }),
    createMockDbIndexer({ id: 2, name: 'Torznab', type: 'torznab', priority: 1, settings: {} }),
  ];
  const db = createMockDb();
  db.select.mockReturnValue(mockDbChain(rows));
  db.update.mockReturnValue(mockDbChain(rows));
  const log = createMockLogger();
  const service = new IndexerService(inject<Db>(db), inject<FastifyBaseLogger>(log), undefined, () => 0);
  const search = new IndexerSearchService(inject<Db>(db), inject<FastifyBaseLogger>(log), service);

  // Hold the #2376 breaker open: its backoff and the rung period are the same order of magnitude,
  // so a live breaker could make these assertions pass for an unrelated mechanism's reason.
  vi.spyOn(service, 'reserveSearchAttempt').mockImplementation((id) => ({
    allowed: true,
    generation: service.getFailureGeneration(id),
    snapshot: service.getFailureSnapshot(id),
  }));

  const abb = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 1 });
  const torznab = new TorznabIndexer({ apiUrl: TORZNAB_URL, apiKey: 'key' }, 'Torznab');
  const getAdapter = vi.spyOn(service, 'getAdapter')
    .mockImplementation(async (indexer) => (indexer.id === 1 ? abb : torznab) as never);

  return { service, search, log, getAdapter };
}

type Harness = ReturnType<typeof build>;

type Surface = 'aggregate' | 'streaming';

/** Both shared executors build their own SearchOptions, so a fix to one leaves the other bare. */
async function runLadder(harness: Harness, title: string, surface: Surface = 'aggregate') {
  const book = { id: 1, title, authors: [{ name: AUTHOR }] };
  const execute = surface === 'aggregate'
    ? createAggregateExecutor(book, harness.search, NOOP_SINK, inject<FastifyBaseLogger>(harness.log))
    : await createStreamingExecutor(book, harness.search, NOOP_SINK);
  return runQueryLadder(buildQueryLadder({ title, author: AUTHOR }), execute);
}

function searchParamOf(url: string, name: string): string | null {
  return new URL(url).searchParams.get(name);
}

describe('#2422 — the folded ABB query through the real service seam', () => {
  const server = useMswServer();
  let captured: Captured;

  beforeEach(() => {
    initializeKey(TEST_KEY);
    captured = { abb: [], torznab: [] };
    // ABB's 6.1s floor would make an eight-rung run a 48-second test. The gate is module-level, so
    // one spy covers every adapter `getAdapter` builds; its timing lives in `abb-throttle.test.ts`.
    _resetAbbThrottleForTesting();
    vi.spyOn(abbThrottle, 'acquire').mockResolvedValue(undefined);
  });
  afterEach(() => { _resetAbbThrottleForTesting(); _resetKey(); vi.restoreAllMocks(); });

  /** ABB answers a genuine, empty search page; Torznab answers an empty feed. Both record their URL. */
  function serveEmpty(): void {
    server.use(
      http.get(`https://${ABB_HOST}/`, ({ request }) => {
        captured.abb.push(request.url);
        return new HttpResponse('<html><body></body></html>', { headers: { 'Content-Type': 'text/html' } });
      }),
      http.get(`${TORZNAB_URL}/api`, ({ request }) => {
        captured.torznab.push(request.url);
        return new HttpResponse(EMPTY_RSS, { headers: { 'Content-Type': 'application/xml' } });
      }),
    );
  }

  it.each<Surface>(['aggregate', 'streaming'])(
    'folds the apostrophe word out of the rung-1 ABB request URL on the %s executor',
    async (surface) => {
      serveEmpty();

      await runLadder(build(), SIMPLE_TITLE, surface);

      expect(searchParamOf(captured.abb[0]!, 's'))
        .toBe('a dragon guide to retirement julia huni');
      expect(searchParamOf(captured.torznab[0]!, 'q'))
        .toBe('A Dragon Riders Guide to Retirement Julia Huni');
    },
  );

  it('folds the rung-2 ABB request too, once rung 1 answers a genuine zero', async () => {
    serveEmpty();
    const ladder = buildQueryLadder({ title: DEEP_TITLE, author: AUTHOR });
    // Without this the "every rung folded" claim would hold just as well against a one-rung ladder.
    expect(ladder).toHaveLength(MAX_SEARCH_RUNGS);

    const ran = await runLadder(build(), DEEP_TITLE);

    expect(ran.exhausted).toBe(true);
    expect(captured.abb).toHaveLength(MAX_SEARCH_RUNGS);
    expect(searchParamOf(captured.abb[0]!, 's'))
      .toBe('a dragon guide the retirement chronicles book one julia huni');
    expect(searchParamOf(captured.abb[1]!, 's'))
      .toBe('a dragon guide the retirement chronicles julia huni');
    for (const url of captured.abb) expect(searchParamOf(url, 's')).not.toContain('riders');
  });

  // The control for the case above: without it, "every rung is folded" also passes when the
  // ladder never advances past rung 1, or when it advances for the wrong reason.
  it('control: the ladder stops on the first non-empty rung, and that rung is folded too', async () => {
    const oneRow = `<html><body><div class="post"><div class="postTitle">
      <h2><a href="/audio-books/a-dragon-riders-guide/" rel="bookmark">A Dragon Riders Guide</a></h2>
    </div></div></body></html>`;
    server.use(
      http.get(`https://${ABB_HOST}/`, ({ request }) => {
        captured.abb.push(request.url);
        return new HttpResponse(oneRow, { headers: { 'Content-Type': 'text/html' } });
      }),
      http.get(`${TORZNAB_URL}/api`, ({ request }) => {
        captured.torznab.push(request.url);
        return new HttpResponse(EMPTY_RSS, { headers: { 'Content-Type': 'application/xml' } });
      }),
    );

    const ran = await runLadder(build(), DEEP_TITLE);

    expect(ran.index).toBe(0);
    expect(ran.results.length).toBeGreaterThan(0);
    expect(captured.abb).toHaveLength(1);
    expect(searchParamOf(captured.abb[0]!, 's'))
      .toBe('a dragon guide the retirement chronicles book one julia huni');
  });

  // AC17's proof: in the SAME run, the two adapters read different inputs.
  it('leaves the Newznab-family request byte-identical while ABB folds', async () => {
    serveEmpty();

    await runLadder(build(), SIMPLE_TITLE);

    expect(searchParamOf(captured.torznab[0]!, 'q'))
      .toBe('A Dragon Riders Guide to Retirement Julia Huni');
    expect(searchParamOf(captured.torznab[0]!, 'q')).toContain('Riders');
    expect(searchParamOf(captured.abb[0]!, 's')).not.toContain('riders');
  });

  it('does not add the new option to the Newznab-family query string at all', async () => {
    serveEmpty();

    await runLadder(build(), SIMPLE_TITLE);

    expect(new URL(captured.torznab[0]!).searchParams.has('queryWithApostrophes')).toBe(false);
    expect([...new URL(captured.torznab[0]!).searchParams.keys()].sort())
      .toEqual(['apikey', 'attrs', 'author', 'cat', 'limit', 'q', 't']);
  });

  // #2375 semantics: an ABB outage is a failed leg, not an answered zero, and the new option
  // must not swallow or reshape that.
  it('surfaces an ABB transport failure as a failed leg without incrementing succeeded', async () => {
    const outcomes: Array<{ name: string; kind: string }> = [];
    server.use(
      http.get(`https://${ABB_HOST}/`, ({ request }) => {
        captured.abb.push(request.url);
        return HttpResponse.error();
      }),
      http.get(`${TORZNAB_URL}/api`, ({ request }) => {
        captured.torznab.push(request.url);
        return new HttpResponse(EMPTY_RSS, { headers: { 'Content-Type': 'application/xml' } });
      }),
    );
    const harness = build();
    const { results, succeeded } = await harness.search.searchAllWithStatus(
      'A Dragon Riders Guide to Retirement Julia Huni',
      { title: SIMPLE_TITLE, author: AUTHOR, queryWithApostrophes: `${SIMPLE_TITLE} ${AUTHOR}` },
      { onOutcome: (_id, name, outcome) => { outcomes.push({ name, kind: outcome.kind }); } },
    );

    expect(results).toEqual([]);
    // Torznab answered; ABB did not. A swallowed failure would report two.
    expect(succeeded).toBe(1);
    expect(outcomes).toContainEqual({ name: 'AudioBookBay', kind: 'failed' });
    expect(searchParamOf(captured.abb[0]!, 's')).toBe('a dragon guide to retirement julia huni');
  });

  it('asks a failed ABB exactly once across the whole ladder, unchanged by the new option', async () => {
    server.use(
      http.get(`https://${ABB_HOST}/`, ({ request }) => {
        captured.abb.push(request.url);
        return new HttpResponse(null, { status: 503 });
      }),
      http.get(`${TORZNAB_URL}/api`, ({ request }) => {
        captured.torznab.push(request.url);
        return new HttpResponse(EMPTY_RSS, { headers: { 'Content-Type': 'application/xml' } });
      }),
    );

    await runLadder(build(), DEEP_TITLE);

    expect(captured.abb).toHaveLength(1);
    expect(captured.torznab).toHaveLength(MAX_SEARCH_RUNGS);
  });
});
