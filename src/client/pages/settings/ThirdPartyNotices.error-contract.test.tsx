import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../__tests__/helpers';
import { ThirdPartyNotices } from './ThirdPartyNotices';
import { systemApi } from '@/lib/api/system';
import { ApiError } from '@/lib/api/client';

/** Mocks only fetch to exercise the real systemApi → fetchApi → ApiError path and 500 envelope. */
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

    // URL_BASE adds the /api prefix.
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/system/notices',
      expect.objectContaining({ credentials: 'include' }),
    );

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
