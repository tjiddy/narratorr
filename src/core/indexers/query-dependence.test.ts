/**
 * The #2375 classification table, as a total order. Every row states its expected verdict up
 * front — a discovered verdict would pin whatever the implementation happens to do.
 */
import { describe, expect, it } from 'vitest';
import { classifyQueryDependence, type QueryDependence } from './query-dependence.js';
import { IndexerAuthError, IndexerError, ProxyError, httpStatusError } from './errors.js';

/** The undici wrapper shape `describeTransportError` unwraps: the real code lives on `.cause`. */
function fetchFailed(code: string): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error('socket'), { code }) });
}

function withCode(code: string): Error {
  return Object.assign(new Error(`transport said ${code}`), { code });
}

const ROWS: Array<{ name: string; error: unknown; expected: QueryDependence }> = [
  // Arm 3 — a recognized transport code means the indexer never looked at the query.
  { name: 'ECONNREFUSED', error: withCode('ECONNREFUSED'), expected: 'transport' },
  { name: 'ENOTFOUND', error: withCode('ENOTFOUND'), expected: 'transport' },
  { name: 'ETIMEDOUT', error: withCode('ETIMEDOUT'), expected: 'transport' },
  { name: 'ECONNRESET', error: withCode('ECONNRESET'), expected: 'transport' },
  { name: 'UND_ERR_CONNECT_TIMEOUT', error: withCode('UND_ERR_CONNECT_TIMEOUT'), expected: 'transport' },
  { name: 'UND_ERR_HEADERS_TIMEOUT', error: withCode('UND_ERR_HEADERS_TIMEOUT'), expected: 'transport' },
  { name: 'UND_ERR_BODY_TIMEOUT', error: withCode('UND_ERR_BODY_TIMEOUT'), expected: 'transport' },

  // Arm 4 — the one code in the transport table the query actually caused.
  { name: 'UND_ERR_RESPONSE_EXCEEDED_SIZE', error: withCode('UND_ERR_RESPONSE_EXCEEDED_SIZE'), expected: 'query-scoped' },

  { name: 'TypeError: fetch failed wrapping ECONNRESET', error: fetchFailed('ECONNRESET'), expected: 'transport' },
  {
    name: 'TypeError: fetch failed wrapping UND_ERR_RESPONSE_EXCEEDED_SIZE',
    error: fetchFailed('UND_ERR_RESPONSE_EXCEEDED_SIZE'),
    expected: 'query-scoped',
  },

  // Arm 3 via the DOMException name. These reach the classifier only under a LIVE signal —
  // a cancelled leg is tagged `cancelled` upstream and is never classified at all (arm 0).
  { name: "DOMException('TimeoutError')", error: new DOMException('timed out', 'TimeoutError'), expected: 'transport' },
  { name: "DOMException('AbortError')", error: new DOMException('aborted', 'AbortError'), expected: 'transport' },

  // Arms 1 and 2 — typed indexer failures that no rung can fix.
  { name: 'IndexerAuthError', error: new IndexerAuthError('MAM', 'bad credentials'), expected: 'transport' },
  { name: 'ProxyError', error: new ProxyError('Proxy connection failed: socket hang up'), expected: 'transport' },
  {
    name: 'ProxyError from the solver-concurrency shed',
    error: new ProxyError('Timed out after 30s waiting for a request slot at solver http://s.test'),
    expected: 'transport',
  },

  // Arm 7 — a response we received but could not read; the next rung may parse cleanly.
  { name: 'IndexerError (response validation)', error: new IndexerError('Torznab', 'invalid JSON'), expected: 'query-scoped' },

  // Arm 5 — exactly the statuses a different query can clear.
  { name: 'HTTP 400', error: httpStatusError(400, 'Bad Request'), expected: 'query-scoped' },
  { name: 'HTTP 413', error: httpStatusError(413, 'Payload Too Large'), expected: 'query-scoped' },
  { name: 'HTTP 414', error: httpStatusError(414, 'URI Too Long'), expected: 'query-scoped' },
  { name: 'HTTP 422', error: httpStatusError(422, 'Unprocessable Entity'), expected: 'query-scoped' },

  // Arm 6 — every other status. 429 is the tempting miss: a rate limit is per-client.
  { name: 'HTTP 401', error: httpStatusError(401, 'Unauthorized'), expected: 'transport' },
  { name: 'HTTP 403', error: httpStatusError(403, 'Forbidden'), expected: 'transport' },
  { name: 'HTTP 404', error: httpStatusError(404, 'Not Found'), expected: 'transport' },
  { name: 'HTTP 408', error: httpStatusError(408, 'Request Timeout'), expected: 'transport' },
  { name: 'HTTP 429', error: httpStatusError(429, 'Too Many Requests'), expected: 'transport' },
  { name: 'HTTP 500', error: httpStatusError(500, 'Internal Server Error'), expected: 'transport' },
  { name: 'HTTP 503', error: httpStatusError(503, 'Service Unavailable'), expected: 'transport' },

  // Arm 8 — the deliberate default. Misclassifying a query error costs one indexer one run.
  { name: 'plain Error with no discriminant', error: new Error('something new'), expected: 'transport' },
  { name: 'thrown string', error: 'boom', expected: 'transport' },
  { name: 'thrown null', error: null, expected: 'transport' },
  { name: 'thrown undefined', error: undefined, expected: 'transport' },
  { name: 'thrown plain object', error: { message: 'boom' }, expected: 'transport' },
  { name: 'unrecognized transport code', error: withCode('EPIPE'), expected: 'transport' },
];

describe('#2375 classifyQueryDependence — the total order', () => {
  it.each(ROWS)('classifies $name as $expected', ({ error, expected }) => {
    expect(classifyQueryDependence(error)).toBe(expected);
  });

  it('returns one of exactly two verdicts for every fixture, never undefined', () => {
    for (const row of ROWS) {
      expect(['transport', 'query-scoped']).toContain(classifyQueryDependence(row.error));
    }
  });
});

describe('#2375 AC16 — precedence is code-before-status, inverting classifyFailure', () => {
  it('reads a transport code ahead of a query-scoped status (arm 3 before arm 5)', () => {
    const both = Object.assign(httpStatusError(400, 'Bad Request'), { code: 'ECONNRESET' });

    expect(classifyQueryDependence(both)).toBe('transport');
  });

  // The mirror: without it a single row proves a coincidence rather than an ordering.
  it('reads the oversized-response code ahead of a transport status (arm 4 before arm 6)', () => {
    const both = Object.assign(httpStatusError(500, 'Internal Server Error'), { code: 'UND_ERR_RESPONSE_EXCEEDED_SIZE' });

    expect(classifyQueryDependence(both)).toBe('query-scoped');
  });

  it('prefers the typed auth class over a query-scoped status (arm 1 before arm 5)', () => {
    const authWith400 = Object.assign(new IndexerAuthError('MAM', 'rejected'), { httpStatus: 400 });

    expect(classifyQueryDependence(authWith400)).toBe('transport');
  });
});

describe('#2375 AC11 — the status is read structurally, never from the message', () => {
  it('ignores a status that exists only in the message text', () => {
    // The pre-#2375 shape. Nothing structural is attached, so arm 8 applies.
    expect(classifyQueryDependence(new Error('HTTP 400: Bad Request'))).toBe('transport');
  });

  it('reads a status attached to the cause of a wrapping indexer error', () => {
    const wrapped = new IndexerError('Torznab', 'upstream rejected', { cause: httpStatusError(429, 'Too Many Requests') });

    // Arm 6 wins over arm 7: the server's own 429 is stronger evidence than the wrapper class.
    expect(classifyQueryDependence(wrapped)).toBe('transport');
  });

  it('ignores a non-numeric httpStatus rather than guessing', () => {
    const bogus = Object.assign(new Error('weird'), { httpStatus: '400' });

    expect(classifyQueryDependence(bogus)).toBe('transport');
  });
});
