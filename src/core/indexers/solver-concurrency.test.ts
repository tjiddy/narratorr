/**
 * The endpoint-identity half of the solver bound. Pure and transport-free: the runtime consequences
 * (who queues behind whom) are pinned in `fetch.test.ts`, and this file pins the key those cases
 * key on, so the two cannot drift apart silently.
 */

import { describe, it, expect } from 'vitest';
import { normalizeBaseUrl } from '@shared/normalize-base-url.js';
import { solverConcurrencyKey } from './solver-concurrency.js';

/** AC2's derivation, restated here so the table below is anchored to the rule, not to the code. */
function derivedKey(proxyUrl: string): string {
  const endpoint = new URL(`${normalizeBaseUrl(proxyUrl)}/v1`);
  endpoint.hash = '';
  return endpoint.href;
}

/** What the Fetch Standard actually serializes onto the wire for a credential-free URL. */
function wireTarget(proxyUrl: string): string {
  const endpoint = new URL(`${normalizeBaseUrl(proxyUrl)}/v1`);
  return `${endpoint.protocol}//${endpoint.host}${endpoint.pathname}${endpoint.search}`;
}

interface Pair {
  a: string;
  b: string;
  share: boolean;
  why: string;
  /** `fetch` refuses a credential-bearing URL outright, so it has no wire target to compare to. */
  credentialBearing?: boolean;
}

const PAIRS: Pair[] = [
  { a: 'http://solver.lan:8191/', b: 'http://solver.lan:8191', share: true, why: 'trailing slash stripped before append' },
  { a: 'http://SOLVER.lan:8191', b: 'http://solver.lan:8191', share: true, why: 'URL folds host case' },
  { a: 'http://solver.lan:80', b: 'http://solver.lan', share: true, why: 'URL drops the default port' },
  { a: 'http://gateway/solver-a/', b: 'http://gateway/solver-a', share: true, why: 'same, on a base path' },
  { a: 'http://h/v1#one', b: 'http://h/v1#two', share: true, why: 'fragments are never transmitted' },
  { a: 'http://solver.lan:8191', b: 'http://solver.lan:8191/v1', share: false, why: 'the second builds /v1/v1' },
  { a: 'http://gateway/solver-a', b: 'http://gateway/solver-b', share: false, why: 'distinct solvers behind one host:port' },
  { a: 'http://gateway/Solver-A', b: 'http://gateway/solver-a', share: false, why: 'paths are case-sensitive' },
  { a: 'http://h:8191', b: 'https://h:8191', share: false, why: 'scheme participates even on one explicit port' },
  { a: 'http://solver.lan', b: 'https://solver.lan', share: false, why: 'distinct scheme and distinct default port' },
  { a: 'http://[::1]:8080', b: 'http://[::1]:8081', share: false, why: 'distinct ports' },
  { a: 'http://h?a=1', b: 'http://h?a=2', share: false, why: 'the query is transmitted, so these are two targets' },
  { a: 'http://user:pass@h', b: 'http://h', share: false, why: 'fetch refuses credentials, so the first has no wire target', credentialBearing: true },
];

describe('solverConcurrencyKey', () => {
  describe('endpoint identity', () => {
    it.each(PAIRS)('$a vs $b — share: $share ($why)', ({ a, b, share }) => {
      const keyA = solverConcurrencyKey(a);
      const keyB = solverConcurrencyKey(b);

      expect(keyA === keyB).toBe(share);
    });

    it.each(PAIRS)('$a vs $b agrees with AC2’s derivation applied to each side', ({ a, b }) => {
      expect(solverConcurrencyKey(a)).toBe(derivedKey(a));
      expect(solverConcurrencyKey(b)).toBe(derivedKey(b));
    });

    it.each(PAIRS.filter((pair) => !pair.credentialBearing))(
      '$a and $b key on the request target that goes on the wire',
      ({ a, b }) => {
        expect(solverConcurrencyKey(a)).toBe(wireTarget(a));
        expect(solverConcurrencyKey(b)).toBe(wireTarget(b));
      },
    );

    it('keeps a credential-bearing URL apart from the plain one so it cannot inherit a saturated pool', () => {
      // Deliberately excluded from the wire-target assertion: this URL never dispatches at all.
      expect(solverConcurrencyKey('http://user:pass@h')).toBe('http://user:pass@h/v1');
      expect(solverConcurrencyKey('http://h')).toBe('http://h/v1');
    });

    it('separates the same host on two ports', () => {
      expect(solverConcurrencyKey('http://solver.lan:8191')).not.toBe(solverConcurrencyKey('http://solver.lan:8192'));
    });

    it('folds host case but not path case, in the same breath', () => {
      expect(solverConcurrencyKey('http://GATEWAY/solver-a')).toBe(solverConcurrencyKey('http://gateway/solver-a'));
      expect(solverConcurrencyKey('http://gateway/Solver-A')).not.toBe(solverConcurrencyKey('http://gateway/solver-a'));
    });
  });

  describe('IPv6', () => {
    it('keys a bracketed literal on its own endpoint', () => {
      expect(solverConcurrencyKey('http://[::1]:8080')).toBe('http://[::1]:8080/v1');
    });

    it('does not let the unparseable unbracketed spelling share the bracketed key', () => {
      // An IPv6 literal in a URL requires brackets, so this lands in the raw-string branch.
      expect(solverConcurrencyKey('http://::1:8080')).toBe('http://::1:8080');
      expect(solverConcurrencyKey('http://::1:8080')).not.toBe(solverConcurrencyKey('http://[::1]:8080'));
    });
  });

  describe('parse failure', () => {
    it('falls back to the raw proxyUrl rather than throwing', () => {
      expect(() => solverConcurrencyKey('not a url')).not.toThrow();
      expect(solverConcurrencyKey('not a url')).toBe('not a url');
    });

    it('gives two calls with the same unparseable value one key', () => {
      expect(solverConcurrencyKey('not a url')).toBe(solverConcurrencyKey('not a url'));
    });

    it('never throws for any spelling in the table', () => {
      for (const { a, b } of PAIRS) {
        expect(() => solverConcurrencyKey(a)).not.toThrow();
        expect(() => solverConcurrencyKey(b)).not.toThrow();
      }
    });
  });
});
