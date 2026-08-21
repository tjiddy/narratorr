/** Non-forwarding mock verifies that only proxied calls attach a dispatcher. */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { Dispatcher } from 'undici';
import type * as NetworkServiceModule from '../utils/network-service.js';
import {
  captureDispatcher,
  respondInFlightUntilAborted,
  type DispatcherCapture,
} from '../__tests__/dispatcher-capture.js';

vi.mock('../utils/network-service.js', async (importActual) => {
  const actual = await importActual<typeof NetworkServiceModule>();
  return { ...actual, fetchWithOptionalDispatcher: vi.fn() };
});

import { fetchWithProxyAgent } from './proxy.js';
import { ProxyError } from './errors.js';
import { fetchWithOptionalDispatcher } from '../utils/network-service.js';

const mockHelper = vi.mocked(fetchWithOptionalDispatcher) as unknown as Mock;

describe('fetchWithProxyAgent — dispatcher-routing regression (F1)', () => {
  beforeEach(() => {
    mockHelper.mockReset();
  });

  it('calls fetchWithOptionalDispatcher with dispatcher attached when proxyUrl is set', async () => {
    mockHelper.mockResolvedValue(
      new Response('<xml>data</xml>', { status: 200 }),
    );

    await fetchWithProxyAgent('https://indexer.example.com/api', {
      proxyUrl: 'http://proxy.example.com:8080',
    });

    expect(mockHelper).toHaveBeenCalledOnce();
    const init = mockHelper.mock.calls[0]![1] as { dispatcher?: unknown };
    expect(init.dispatcher).toBeDefined();
  });

  it('calls fetchWithOptionalDispatcher WITHOUT a dispatcher when no proxyUrl', async () => {
    mockHelper.mockResolvedValue(
      new Response('hello', { status: 200 }),
    );

    await fetchWithProxyAgent('https://example.com');

    expect(mockHelper).toHaveBeenCalledOnce();
    const init = mockHelper.mock.calls[0]![1] as { dispatcher?: unknown };
    expect(init.dispatcher).toBeUndefined();
  });
});

/**
 * #2539 dispatcher lifecycle. This is the only mocked seam that can see it: `proxy.test.ts` rewires
 * the helper down to `globalThis.fetch` and never sees a dispatcher at all, while here the real
 * instance `createProxyAgent` minted arrives on `init.dispatcher` and can be spied per call.
 *
 * Every case keeps the close-once assertion independent of the error assertion, so a regression in
 * either is separately attributable.
 */
describe('fetchWithProxyAgent — dispatcher lifecycle (#2539 AC8-AC10)', () => {
  const PROXIED = { proxyUrl: 'http://proxy.example.com:8080' } as const;

  const capture = (
    respond: (init: RequestInit & { dispatcher?: Dispatcher }) => Promise<Response>,
    options?: { closeRejects?: boolean },
  ): DispatcherCapture => captureDispatcher(mockHelper, respond, options);

  beforeEach(() => {
    mockHelper.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('closes the dispatcher exactly once on a proxied success', async () => {
    const captured = capture(async () => new Response('<xml>data</xml>', { status: 200 }));

    const result = await fetchWithProxyAgent('https://indexer.example.com/api', PROXIED);

    expect(result.body).toBe('<xml>data</xml>');
    expect(captured.dispatcher).toBeDefined();
    expect(captured.closeCalls()).toBe(1);
  });

  /**
   * One row per proxied throw path. The expected rejection differs by row because
   * `fetchWithProxyAgent` deliberately classifies — the property under test is that the lifecycle
   * work left every one of those classifications exactly as it was, plus close-once on all five.
   * The direct arm has no row: it constructs nothing, so there is nothing to close.
   */
  describe('closes the dispatcher exactly once on every proxied throw path (AC9)', () => {
    it('proxy HTTP 502', async () => {
      const captured = capture(async () => new Response('bad', { status: 502, statusText: 'Bad Gateway' }));

      const rejection = await fetchWithProxyAgent('https://indexer.example.com/api', PROXIED).catch((e: unknown) => e);

      expect(rejection).toBeInstanceOf(ProxyError);
      expect((rejection as Error).message).toBe('Proxy HTTP error 502: Bad Gateway');
      expect(captured.closeCalls()).toBe(1);
    });

    it('upstream HTTP 404 — an ordinary error, deliberately not a ProxyError', async () => {
      const captured = capture(async () => new Response('nope', { status: 404, statusText: 'Not Found' }));

      const rejection = await fetchWithProxyAgent('https://indexer.example.com/api', PROXIED).catch((e: unknown) => e);

      expect(rejection).not.toBeInstanceOf(ProxyError);
      expect((rejection as Error).message).toBe('HTTP 404: Not Found');
      expect(captured.closeCalls()).toBe(1);
    });

    it('dispatcher / network failure', async () => {
      const cause = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:8080'), { code: 'ECONNREFUSED' });
      const captured = capture(async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause });
      });

      const rejection = await fetchWithProxyAgent('https://indexer.example.com/api', PROXIED).catch((e: unknown) => e);

      expect(rejection).toBeInstanceOf(ProxyError);
      expect((rejection as Error).message).toMatch(/Proxy connection failed: .*ECONNREFUSED/);
      expect(captured.closeCalls()).toBe(1);
    });

    it('internal timeout with no caller signal', async () => {
      const captured = capture(async () => {
        throw new DOMException('signal is aborted', 'AbortError');
      });

      const rejection = await fetchWithProxyAgent('https://indexer.example.com/api', {
        ...PROXIED, timeoutMs: 30_000,
      }).catch((e: unknown) => e);

      expect(rejection).toBeInstanceOf(ProxyError);
      expect((rejection as Error).message).toBe('Proxy timed out after 30s');
      expect(captured.closeCalls()).toBe(1);
    });

    it('caller abort in flight — the only row whose rejection survives by identity', async () => {
      const reason = new Error('search deadline reached');
      const controller = new AbortController();
      const { onTheWire, respond } = respondInFlightUntilAborted();
      const captured = capture(respond);

      const pending = fetchWithProxyAgent('https://indexer.example.com/api', {
        ...PROXIED, signal: controller.signal,
      });
      await onTheWire;
      controller.abort(reason);
      const rejection = await pending.catch((e: unknown) => e);

      expect(rejection).toBe(reason);
      expect(rejection).not.toBeInstanceOf(ProxyError);
      expect(captured.closeCalls()).toBe(1);
    });
  });

  it('constructs and closes nothing when no proxy is configured (AC8)', async () => {
    mockHelper.mockResolvedValue(new Response('hello', { status: 200 }));

    const result = await fetchWithProxyAgent('https://example.com');

    expect(result.body).toBe('hello');
    const init = mockHelper.mock.calls[0]![1] as { dispatcher?: unknown };
    expect(init.dispatcher).toBeUndefined();
  });

  describe('a rejecting close() is never the caller\'s outcome (AC8)', () => {
    it('a success still returns its result', async () => {
      const captured = capture(async () => new Response('payload', { status: 200 }), { closeRejects: true });

      await expect(fetchWithProxyAgent('https://indexer.example.com/api', PROXIED))
        .resolves.toMatchObject({ body: 'payload', httpStatus: 200 });
      expect(captured.closeCalls()).toBe(1);
    });

    it('a failure still rejects with its own classified outcome, not the close rejection', async () => {
      const captured = capture(
        async () => new Response('bad', { status: 502, statusText: 'Bad Gateway' }),
        { closeRejects: true },
      );

      const rejection = await fetchWithProxyAgent('https://indexer.example.com/api', PROXIED).catch((e: unknown) => e);

      expect(rejection).toBeInstanceOf(ProxyError);
      expect((rejection as Error).message).toBe('Proxy HTTP error 502: Bad Gateway');
      expect((rejection as Error).message).not.toMatch(/close failed/);
      expect(captured.closeCalls()).toBe(1);
    });
  });

  it('reads the whole multi-chunk body BEFORE closing the dispatcher (AC10)', async () => {
    let bodyUsedAtClose: boolean | undefined;
    let response: Response | undefined;
    mockHelper.mockImplementation(async (_url: string, init: RequestInit & { dispatcher?: Dispatcher }) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('<xml>chunk-one '));
          controller.enqueue(encoder.encode('chunk-two</xml>'));
          controller.close();
        },
      });
      response = new Response(stream, { status: 200 });
      vi.spyOn(init.dispatcher!, 'close').mockImplementation(async () => {
        // A close-before-read regression would record `false` here and truncate the body below.
        bodyUsedAtClose = response!.bodyUsed;
      });
      return response;
    });

    const result = await fetchWithProxyAgent('https://indexer.example.com/api', PROXIED);

    expect(result.body).toBe('<xml>chunk-one chunk-two</xml>');
    expect(bodyUsedAtClose).toBe(true);
  });
});
