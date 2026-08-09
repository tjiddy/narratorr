/** Non-forwarding mock verifies that only proxied calls attach a dispatcher. */

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
