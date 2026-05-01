/**
 * Dispatcher-routing regression for fetchWithProxyAgent (F1, PR #907 review).
 *
 * The main proxy.test.ts file mocks `undiciFetch` as a delegate to
 * `globalThis.fetch` so its existing MSW/spy assertions keep working. That
 * forwarding mock means a regression that swapped production back to
 * `globalThis.fetch` would still satisfy those tests — exactly the failure
 * mode that put cover-download at risk for 24 hours after the undici 7→8
 * bump.
 *
 * This file mocks the production seam — `fetchWithOptionalDispatcher` — with
 * a non-forwarding `vi.fn()` and asserts the call-site contract:
 *   - proxied call MUST hit the helper with the dispatcher attached
 *   - no-proxy call MUST hit the helper without a dispatcher
 *
 * The helper's own routing (dispatcher → undiciFetch, no-dispatcher →
 * globalThis.fetch) is asserted in network-service.test.ts under
 * `fetchWithOptionalDispatcher (call-site routing contract)`. Together the
 * two test files protect end-to-end against the regression.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type * as NetworkServiceModule from '../utils/network-service.js';

vi.mock('../utils/network-service.js', async (importActual) => {
  const actual = await importActual<typeof NetworkServiceModule>();
  return { ...actual, fetchWithOptionalDispatcher: vi.fn() };
});

import { fetchWithProxyAgent } from './proxy.js';
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
    const init = mockHelper.mock.calls[0][1] as { dispatcher?: unknown };
    expect(init.dispatcher).toBeDefined();
  });

  it('calls fetchWithOptionalDispatcher WITHOUT a dispatcher when no proxyUrl', async () => {
    mockHelper.mockResolvedValue(
      new Response('hello', { status: 200 }),
    );

    await fetchWithProxyAgent('https://example.com');

    expect(mockHelper).toHaveBeenCalledOnce();
    const init = mockHelper.mock.calls[0][1] as { dispatcher?: unknown };
    expect(init.dispatcher).toBeUndefined();
  });
});
