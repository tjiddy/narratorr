/**
 * #2484 — the real SOCKS5 transport contract.
 *
 * Nothing here is mocked: a real `createProxyAgent('socks5://…')` result travels through the real
 * `fetchWithProxyAgent` → `undici.fetch` seam to a real in-process RFC 1928 listener. That is the
 * whole point of the file. `proxy.test.ts` carries a file-scoped `vi.mock` that rewires
 * `fetchWithOptionalDispatcher` to `globalThis.fetch`, so a contract test added there would never
 * touch a dispatcher — which is exactly how a `SocksProxyAgent` (an `http.Agent`, not an undici
 * `Dispatcher`) shipped and failed every request with `agent.dispatch is not a function`.
 */

import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Socks5ProxyAgent } from 'undici';
import { ProxyError, IndexerAuthError } from './errors.js';
import { fetchWithProxyAgent } from './proxy.js';
import { TorznabIndexer } from './torznab.js';
import { INDEXER_TIMEOUT_MS } from '../utils/constants.js';
import type { DispatcherFetchInit, FetchWithSsrfRedirectOptions } from '../utils/network-service.js';
import {
  ATYP_DOMAIN,
  ATYP_IPV4,
  startSocks5Stub,
  type Socks5Stub,
  type Socks5StubOptions,
} from '../__tests__/socks5-stub.js';

const ORIGIN_BODY = 'origin-body';

const TORZNAB_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <item>
      <title>Dune - Frank Herbert</title>
      <guid>tunnelled-guid</guid>
      <link>http://tracker.invalid/download/dune.torrent</link>
      <torznab:attr name="seeders" value="12" />
    </item>
  </channel>
</rss>`;

interface OriginStub {
  port: number;
  url(path: string): string;
  close(): Promise<void>;
}

/**
 * Bound on every interface, not just 127.0.0.1, so the `localhost` target of the ATYP_DOMAIN case
 * resolves the same way whichever family the host prefers.
 */
async function startOrigin(): Promise<OriginStub> {
  const server = http.createServer((req, res) => {
    const path = req.url ?? '/';
    if (path.startsWith('/hang')) return; // Accepted, never answered — case 14b's stall.
    if (path.startsWith('/502')) {
      res.writeHead(502, 'Bad Gateway');
      res.end('bad gateway');
      return;
    }
    if (path.startsWith('/404')) {
      res.writeHead(404, 'Not Found');
      res.end('not found');
      return;
    }
    if (path.startsWith('/api')) {
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      res.end(TORZNAB_FEED);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(ORIGIN_BODY);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('origin stub failed to bind');
  const { port } = address;
  return {
    port,
    url: (path: string) => `http://127.0.0.1:${port}${path}`,
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const openStubs: Array<{ close(): Promise<void> }> = [];

async function useSocks(options: Socks5StubOptions = {}): Promise<Socks5Stub> {
  const stub = await startSocks5Stub(options);
  openStubs.push(stub);
  return stub;
}

async function useOrigin(): Promise<OriginStub> {
  const origin = await startOrigin();
  openStubs.push(origin);
  return origin;
}

// The stub owns every socket it accepted and every upstream it opened; no test owns an agent,
// because `fetchWithProxyAgent` constructs its dispatcher in a local and never exposes it.
afterEach(async () => {
  vi.restoreAllMocks();
  while (openStubs.length > 0) await openStubs.pop()!.close();
});

describe('#2484 SOCKS5 transport contract — real agent, real fetch, real listener', () => {
  it('round-trips a plaintext origin through the tunnel', async () => {
    const origin = await useOrigin();
    const socks = await useSocks();

    const result = await fetchWithProxyAgent(origin.url('/ok'), { proxyUrl: socks.url });

    expect(result.body).toBe(ORIGIN_BODY);
    expect(result.httpStatus).toBe(200);
    expect(result.requestUrl).toBe(origin.url('/ok'));
  });

  it('actually traverses the proxy — the listener saw a CONNECT and dialed the origin', async () => {
    const origin = await useOrigin();
    const socks = await useSocks();

    await fetchWithProxyAgent(origin.url('/ok'), { proxyUrl: socks.url });

    expect(socks.connects).toEqual([{ atyp: ATYP_IPV4, host: '127.0.0.1', port: origin.port }]);
    // Positive control for the zero-attempt assertion in the default-port case below: without it,
    // a counter that never increments would satisfy `toBe(0)` vacuously.
    expect(socks.upstreamAttempts).toBe(1);
  });

  it('derives the default tunnel port from the target scheme (80 / 443)', async () => {
    // `noUpstream` so the stub records the CONNECT and refuses without dialing :80/:443. Whether
    // the runner has something bound there — or something that accepts and stalls past the 30s
    // production timeout — must not decide the outcome. Refusing also removes the need for a
    // certificate on the https: half; the contract is the port the proxy was asked to reach.
    const socks = await useSocks({ noUpstream: true });

    await expect(
      fetchWithProxyAgent('http://127.0.0.1/x', { proxyUrl: socks.url }),
    ).rejects.toThrow(ProxyError);
    await expect(
      fetchWithProxyAgent('https://127.0.0.1/x', { proxyUrl: socks.url }),
    ).rejects.toThrow(ProxyError);

    expect(socks.connects).toEqual([
      { atyp: ATYP_IPV4, host: '127.0.0.1', port: 80 },
      { atyp: ATYP_IPV4, host: '127.0.0.1', port: 443 },
    ]);
    // The isolation property itself, not just its consequence: two CONNECTs were recorded and zero
    // dials left the process. Deleting the `noUpstream` branch reds here even on a runner where
    // :80/:443 are closed, which is the case the recorded-port assertion alone cannot distinguish.
    expect(socks.upstreamAttempts).toBe(0);
  });

  it('encodes a hostname target as ATYP 0x03 — remote DNS (socks5h) is the contract', async () => {
    const origin = await useOrigin();
    const socks = await useSocks();

    const result = await fetchWithProxyAgent(`http://localhost:${origin.port}/ok`, {
      proxyUrl: socks.url,
    });

    expect(result.httpStatus).toBe(200);
    expect(socks.connects).toEqual([{ atyp: ATYP_DOMAIN, host: 'localhost', port: origin.port }]);
  });

  it('refuses an IPv6-literal target before opening any tunnel (AC9)', async () => {
    const origin = await useOrigin();
    const socks = await useSocks();

    await expect(
      fetchWithProxyAgent(`http://[::1]:${origin.port}/ok`, { proxyUrl: socks.url }),
    ).rejects.toThrow(ProxyError);

    // The load-bearing half: a guard that fired after the tunnel opened would still reject.
    expect(socks.connects).toEqual([]);
  });
});

describe('#2484 SOCKS5 authentication (RFC 1929)', () => {
  it('percent-decodes URL credentials and the proxy receives them verbatim', async () => {
    const origin = await useOrigin();
    const socks = await useSocks({ requireAuth: true });

    const result = await fetchWithProxyAgent(origin.url('/ok'), {
      proxyUrl: `socks5://us%20er:p%40ss@127.0.0.1:${socks.port}`,
    });

    expect(result.httpStatus).toBe(200);
    expect(socks.credentials).toEqual([{ username: 'us er', password: 'p@ss' }]);
  });

  it('surfaces a rejected sub-negotiation as an actionable ProxyError', async () => {
    const origin = await useOrigin();
    const socks = await useSocks({ rejectAuth: true });

    const promise = fetchWithProxyAgent(origin.url('/ok'), {
      proxyUrl: `socks5://u:p@127.0.0.1:${socks.port}`,
    });

    await expect(promise).rejects.toThrow(ProxyError);
    await expect(promise).rejects.not.toBeInstanceOf(IndexerAuthError);
    await expect(promise).rejects.toThrow(/Authentication failed/i);
  });

  it('turns malformed percent-encoding into the schema-shaped ProxyError, never a raw URIError', async () => {
    const origin = await useOrigin();

    const promise = fetchWithProxyAgent(origin.url('/ok'), {
      proxyUrl: 'socks5://u:p%ss@127.0.0.1:1080',
    });

    await expect(promise).rejects.toThrow(ProxyError);
    await expect(promise).rejects.toThrow(/Invalid proxy URL/);
  });
});

describe('#2484 SOCKS5 failure classification', () => {
  it('reports a refused proxy connection with the connector cause visible', async () => {
    const origin = await useOrigin();
    const dead = await startSocks5Stub();
    const deadPort = dead.port;
    await dead.close();

    const promise = fetchWithProxyAgent(origin.url('/ok'), {
      proxyUrl: `socks5://127.0.0.1:${deadPort}`,
    });

    await expect(promise).rejects.toThrow(ProxyError);
    await expect(promise).rejects.toThrow(/ECONNREFUSED/);
  });

  it("names undici's own 5s SOCKS5 timeout when the proxy accepts but never speaks", async () => {
    const origin = await useOrigin();
    const socks = await useSocks({ silent: true });

    const promise = fetchWithProxyAgent(origin.url('/ok'), { proxyUrl: socks.url });

    // undici's internal ceiling fires long before INDEXER_TIMEOUT_MS, so this lands in the generic
    // `Proxy connection failed:` arm rather than the `Proxy timed out after Ns` one.
    await expect(promise).rejects.toThrow(/SOCKS5 authentication timeout/i);
    await expect(promise).rejects.toThrow(ProxyError);
  }, 20_000);

  it('maps an origin 502 through the tunnel to ProxyError (dispatcher-gated, deliberately)', async () => {
    const origin = await useOrigin();
    const socks = await useSocks();

    await expect(
      fetchWithProxyAgent(origin.url('/502'), { proxyUrl: socks.url }),
    ).rejects.toThrow(/Proxy HTTP error 502/);
  });

  it('leaves an origin 404 through the tunnel as an ordinary HTTP error', async () => {
    const origin = await useOrigin();
    const socks = await useSocks();

    const promise = fetchWithProxyAgent(origin.url('/404'), { proxyUrl: socks.url });

    await expect(promise).rejects.toThrow('HTTP 404: Not Found');
    await expect(promise).rejects.not.toBeInstanceOf(ProxyError);
  });
});

describe('#2484 SOCKS5 abort paths', () => {
  const MARKER_TIMEOUT_MS = 61_000;

  /** Redirect only `proxy.ts`'s own hand-rolled timer, so unrelated internal timers keep their delay. */
  function fireInternalTimeoutImmediately(): void {
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: Parameters<typeof globalThis.setTimeout>[0],
      ms?: number,
      ...rest: unknown[]
    ) =>
      ms === MARKER_TIMEOUT_MS
        ? realSetTimeout(fn, 0)
        : realSetTimeout(fn, ms, ...rest)) as typeof globalThis.setTimeout);
  }

  it("aborts on Narratorr's own timeout with the timeout-shaped ProxyError", async () => {
    const origin = await useOrigin();
    const socks = await useSocks();
    fireInternalTimeoutImmediately();

    await expect(
      fetchWithProxyAgent(origin.url('/hang'), {
        proxyUrl: socks.url,
        timeoutMs: MARKER_TIMEOUT_MS,
      }),
    ).rejects.toThrow(/Proxy timed out after 61s/);
  });

  it('clears the timeout timer on the success path', async () => {
    const origin = await useOrigin();
    const socks = await useSocks();
    const realSetTimeout = globalThis.setTimeout;
    const handles: unknown[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: Parameters<typeof globalThis.setTimeout>[0],
      ms?: number,
      ...rest: unknown[]
    ) => {
      const handle = realSetTimeout(fn, ms, ...rest);
      if (ms === MARKER_TIMEOUT_MS) handles.push(handle);
      return handle;
    }) as typeof globalThis.setTimeout);
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

    await fetchWithProxyAgent(origin.url('/ok'), {
      proxyUrl: socks.url,
      timeoutMs: MARKER_TIMEOUT_MS,
    });

    expect(handles).toHaveLength(1);
    expect(clearSpy.mock.calls.map(([handle]) => handle)).toContain(handles[0]);
  });

  it('settles promptly when the caller aborts an in-flight tunnelled request, attributing it to the caller', async () => {
    const origin = await useOrigin();
    const socks = await useSocks();
    const controller = new AbortController();
    const reason = new Error('caller cancelled the search');

    const promise = fetchWithProxyAgent(origin.url('/hang'), {
      proxyUrl: socks.url,
      signal: controller.signal,
    });
    // Abort only once the CONNECT is observed at the proxy — a fixed sleep can fire before the
    // tunnel opens on a loaded runner, cancelling a request that was never sent (#2524). The
    // rejection settling under the suite timeout IS the promptness proof; no wall-clock bound —
    // and it is also AC12's proof that the awaited `close()` does not stall the rejection.
    await socks.connectObserved();
    controller.abort(reason);

    // #2539 pins the verdict positively: undici forwards the signal's reason, and the caller-abort
    // guard rethrows it verbatim rather than reclassifying it as the internal timeout.
    const rejection = await promise.catch((error: unknown) => error);
    expect(rejection).toBe(reason);
    expect(rejection).not.toBeInstanceOf(ProxyError);
    expect((rejection as Error).message).not.toMatch(/Proxy timed out/);
    expect(socks.connects).toHaveLength(1);
  });

  /**
   * #2539 AC8 against a REAL `Socks5ProxyAgent`. The mocked routing suites capture a dispatcher the
   * transport never actually used, so they cannot tell that the close happens on a live agent; this
   * is the one place the real one is observed.
   */
  it('closes the real Socks5ProxyAgent it constructed', async () => {
    const origin = await useOrigin();
    const socks = await useSocks();
    const closeSpy = vi.spyOn(Socks5ProxyAgent.prototype, 'close');

    const result = await fetchWithProxyAgent(origin.url('/ok'), { proxyUrl: socks.url });

    expect(result.body).toBe(ORIGIN_BODY);
    // `DispatcherBase.close()` re-enters `this.close(cb)` internally, so the prototype spy sees the
    // one production call plus undici's own recursion — the contract here is "released", not a count.
    expect(closeSpy).toHaveBeenCalled();
  });
});

/**
 * AC3 closes two independently widenable holes, so each gets its own assertion. Guarding only the
 * first would leave the second defended by nothing but incidental inference: `fetchWithSsrfRedirect`
 * forwards its `dispatcher` into a `DispatcherFetchInit`, so widening the field alone reds
 * `network-service.ts` — but silencing that with a one-line `as Dispatcher` cast at the forward
 * reopens the hole with a fully green suite. These assertions do not depend on that plumbing.
 */
describe('#2484 dispatcher typing (AC3)', () => {
  it('rejects a Node http.Agent-shaped value on DispatcherFetchInit at compile time', () => {
    const init: DispatcherFetchInit = {
      // @ts-expect-error An `http.Agent` is not an undici `Dispatcher`; this line reds if
      // `DispatcherFetchInit['dispatcher']` is ever widened back to `unknown`.
      dispatcher: { addRequest: () => undefined },
    };

    expect(init.dispatcher).toBeDefined();
  });

  it('rejects a Node http.Agent-shaped value on FetchWithSsrfRedirectOptions at compile time', () => {
    const options: FetchWithSsrfRedirectOptions = {
      // @ts-expect-error Same contract on the SSRF-redirect entry point; this line reds if
      // `FetchWithSsrfRedirectOptions['dispatcher']` is ever widened back to `unknown`.
      dispatcher: { addRequest: () => undefined },
    };

    expect(options.dispatcher).toBeDefined();
  });
});

describe('#2484 end-to-end through a real indexer adapter', () => {
  it('carries a socks5 proxy from adapter config through to the tunnel', async () => {
    const origin = await useOrigin();
    const socks = await useSocks();
    const indexer = new TorznabIndexer({
      // Trailing slash included deliberately: it must survive normalizeBaseUrl and still tunnel.
      apiUrl: `http://127.0.0.1:${origin.port}/`,
      apiKey: 'test-key',
      proxyUrl: socks.url,
    });

    const response = await indexer.search('dune');

    expect(response.results.map((r) => r.title)).toEqual(['Dune - Frank Herbert']);
    expect(response.requestUrl).toContain(`http://127.0.0.1:${origin.port}/api?`);
    expect(socks.connects).toEqual([{ atyp: ATYP_IPV4, host: '127.0.0.1', port: origin.port }]);
  });

  /**
   * #2539 AC1 end to end. This is the ONLY case that exercises real `undici.fetch` cancellation
   * attribution through a real dispatcher: MSW cannot observe a dispatcher-routed request at all
   * (`fetchWithOptionalDispatcher` calls undici's fetch directly when one is present), and the
   * family suites rewire that helper back to `globalThis.fetch` precisely to keep MSW working —
   * which is what makes them non-coverage here.
   */
  it('attributes a caller abort to the caller through a real adapter and a real tunnel', async () => {
    const origin = await useOrigin();
    const socks = await useSocks();
    const controller = new AbortController();
    const reason = new Error('search deadline reached');
    // `/hang` is accepted and never answered, so the request is still in flight when we abort; the
    // adapter appends `/api?…`, which still matches the stub's prefix test.
    const indexer = new TorznabIndexer({
      apiUrl: `http://127.0.0.1:${origin.port}/hang`,
      apiKey: 'test-key',
      proxyUrl: socks.url,
    });

    const pending = indexer.search('dune', { signal: controller.signal });
    await socks.connectObserved();
    controller.abort(reason);

    const rejection = await pending.catch((error: unknown) => error);
    expect(rejection).toBe(reason);
    expect(rejection).not.toBeInstanceOf(ProxyError);
    expect((rejection as Error).message).not.toMatch(/Proxy timed out/);
  });

  // Control for the case above: the arm this work must not have touched. Without it, a
  // rethrow-everything regression in the guard would be invisible on the real transport.
  it('control: the same real leg with no caller abort still reports the internal timeout', async () => {
    const origin = await useOrigin();
    const socks = await useSocks();
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: Parameters<typeof globalThis.setTimeout>[0],
      ms?: number,
      ...rest: unknown[]
    ) =>
      // The adapter passes no timeoutMs, so its budget is INDEXER_TIMEOUT_MS. Redirect only that
      // delay: proxy.ts hand-rolls `AbortController` + `setTimeout`, so the spy genuinely captures
      // it, unlike an `AbortSignal.timeout`.
      ms === INDEXER_TIMEOUT_MS
        ? realSetTimeout(fn, 0)
        : realSetTimeout(fn, ms, ...rest)) as typeof globalThis.setTimeout);
    const indexer = new TorznabIndexer({
      apiUrl: `http://127.0.0.1:${origin.port}/hang`,
      apiKey: 'test-key',
      proxyUrl: socks.url,
    });

    const rejection = await indexer.search('dune').catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(ProxyError);
    expect((rejection as Error).message).toBe('Proxy timed out after 30s');
  });
});
