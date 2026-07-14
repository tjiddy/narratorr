import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../__tests__/helpers';
import { ThirdPartyNotices } from './ThirdPartyNotices';
import { systemApi } from '@/lib/api/system';
import { ApiError } from '@/lib/api/client';

/**
 * F6 — exercises the REAL client error boundary for GET /api/system/notices. Unlike the
 * co-located ThirdPartyNotices.test.tsx (which mocks `api.getThirdPartyNotices`), this file
 * mocks only `globalThis.fetch` and drives the genuine `systemApi` → `fetchApi` → `ApiError`
 * path, so the exact 500 status/body envelope is actually observed — not merely supplied on a
 * rejected object the component ignores. Removing the status/body from the endpoint contract,
 * or changing the endpoint path, now fails these assertions (deletion heuristic).
 */
describe('ThirdPartyNotices — real 500 client contract (#1862 F6)', () => {
  const originalFetch = globalThis.fetch;
  const ERROR_BODY = { error: 'Failed to load third-party notices' };

  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve(ERROR_BODY),
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('surfaces the exact 500 status + body as an ApiError through the real client', async () => {
    await expect(systemApi.getThirdPartyNotices()).rejects.toMatchObject({
      status: 500,
      body: ERROR_BODY,
    });

    // The wrapper hits the internal /system/notices path (URL_BASE + /api prefix applied).
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/system/notices',
      expect.objectContaining({ credentials: 'include' }),
    );

    // And the thrown value is a genuine ApiError carrying the contract fields.
    const err = await systemApi.getThirdPartyNotices().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
    expect(err.body).toEqual(ERROR_BODY);
  });

  it('renders the user-visible error affordance when the endpoint 500s', async () => {
    renderWithProviders(<ThirdPartyNotices />);

    await waitFor(() => {
      expect(screen.getByText(/Failed to load third-party notices/i)).toBeInTheDocument();
    });
  });
});
