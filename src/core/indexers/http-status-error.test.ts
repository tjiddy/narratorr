/**
 * AC11 — the numeric HTTP status is structural on every adapter's non-OK throw, and the message
 * an operator reads is unchanged. Both halves matter: `indexer-failure-state.ts` renders the
 * message on the health card, and `classifyQueryDependence` reads only the property.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import type * as NetworkServiceModule from '../utils/network-service.js';

// Keep MSW on the proxy/MAM paths; the dedicated routing tests cover real dispatchers.
vi.mock('../utils/network-service.js', async (importActual) => {
  const actual = await importActual<typeof NetworkServiceModule>();
  return {
    ...actual,
    fetchWithOptionalDispatcher: ((url, options) => globalThis.fetch(url, options as RequestInit)) as typeof actual.fetchWithOptionalDispatcher,
  };
});

import { fetchWithProxy } from './fetch.js';
import { fetchWithProxyAgent } from './proxy.js';
import { MyAnonamouseIndexer } from './myanonamouse.js';
import { httpStatusError } from './errors.js';
import { classifyQueryDependence } from './query-dependence.js';
import { _resetMamThrottleForTesting } from './mam-throttle.js';

const TARGET_URL = 'https://indexer.test/api?q=test';
const MAM_BASE = 'https://mam.test';

/**
 * `toMatchObject({ message })` reads through `Error.prototype.message`, so it passes against a
 * raw Error and would stay green if the attachment were deleted. Pin the own-enumerable key set
 * — which is also exactly what Pino serializes.
 */
function expectStructuralStatus(error: unknown, status: number, message: string): void {
  expect(error).toBeInstanceOf(Error);
  expect(Object.keys(error as object)).toEqual(['httpStatus']);
  expect((error as { httpStatus: unknown }).httpStatus).toBe(status);
  expect((error as Error).message).toBe(message);
}

/** The exact throw each producer raised, without a matcher swallowing its identity. */
async function thrown(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected the call to reject');
}

describe('#2375 AC11 — httpStatusError', () => {
  it('attaches the status as an own enumerable property and keeps the message byte-identical', () => {
    const error = httpStatusError(429, 'Too Many Requests');

    expectStructuralStatus(error, 429, 'HTTP 429: Too Many Requests');
  });
});

describe('#2375 AC11 — fetch.ts raises a status-carrying error', () => {
  const server = useMswServer();

  it('carries the status structurally on a direct non-OK response', async () => {
    server.use(http.get('https://indexer.test/api', () => new HttpResponse('bad', { status: 400, statusText: 'Bad Request' })));

    expectStructuralStatus(await thrown(() => fetchWithProxy({ url: TARGET_URL })), 400, 'HTTP 400: Bad Request');
  });

  // Round-trip: without this the table tests can pass while production never produces the shape.
  it('classifies a real 400 as query-scoped and a real 429 as transport', async () => {
    server.use(http.get('https://indexer.test/api', () => new HttpResponse('bad', { status: 400, statusText: 'Bad Request' })));
    const rejected = await thrown(() => fetchWithProxy({ url: TARGET_URL }));

    server.use(http.get('https://indexer.test/api', () => new HttpResponse('slow down', { status: 429, statusText: 'Too Many Requests' })));
    const rateLimited = await thrown(() => fetchWithProxy({ url: TARGET_URL }));

    expect(classifyQueryDependence(rejected)).toBe('query-scoped');
    expect(classifyQueryDependence(rateLimited)).toBe('transport');
  });
});

describe('#2375 AC11 — proxy.ts raises a status-carrying error', () => {
  const server = useMswServer();

  it('carries the status structurally on an upstream non-OK response', async () => {
    server.use(http.get('https://indexer.test/api', () => new HttpResponse('nope', { status: 422, statusText: 'Unprocessable Entity' })));

    const error = await thrown(() => fetchWithProxyAgent(TARGET_URL));

    expectStructuralStatus(error, 422, 'HTTP 422: Unprocessable Entity');
    expect(classifyQueryDependence(error)).toBe('query-scoped');
  });
});

describe('#2375 AC11 — myanonamouse.ts raises a status-carrying error', () => {
  const server = useMswServer();

  beforeEach(() => _resetMamThrottleForTesting());

  it('carries the status structurally on a non-auth non-OK response', async () => {
    server.use(http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => new HttpResponse('nope', { status: 503, statusText: 'Service Unavailable' })));
    const indexer = new MyAnonamouseIndexer({ mamId: 'test-mam-id', baseUrl: MAM_BASE, searchLanguages: [1], searchType: 'active' });

    const error = await thrown(() => indexer.search('kings'));

    expectStructuralStatus(error, 503, 'HTTP 503: Service Unavailable');
    expect(classifyQueryDependence(error)).toBe('transport');
  });
});
