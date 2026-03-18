import { describe, expect, it, vi, afterEach } from 'vitest';
import { fetchWithTimeout } from './fetch-with-timeout.js';

describe('fetchWithTimeout', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns response for successful fetch within timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );

    const response = await fetchWithTimeout('https://example.com', {}, 5000);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });

  it('passes through request options (method, headers, body)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );

    await fetchWithTimeout(
      'https://example.com/api',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"key":"value"}',
      },
      5000,
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://example.com/api',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"key":"value"}',
      }),
    );
  });

  it('attaches an abort signal to the fetch call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );

    await fetchWithTimeout('https://example.com', {}, 3000);

    const calledOptions = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(calledOptions.signal).toBeDefined();
  });

  it('uses custom timeout value', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );

    await fetchWithTimeout('https://example.com', {}, 7500);

    // Signal should exist with the timeout
    const calledOptions = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(calledOptions.signal).toBeDefined();
  });
});
