import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../__tests__/helpers';
import { ThirdPartyNotices } from './ThirdPartyNotices';

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual('@/lib/api');
  return {
    ...actual,
    api: {
      ...(actual as { api: object }).api,
      getThirdPartyNotices: vi.fn(),
    },
  };
});

import { api } from '@/lib/api';
import type { Mock } from 'vitest';

const noticeContent =
  '# Third-Party Notices\n\nThis image bundles FFmpeg © the FFmpeg developers.\n\nGNU GENERAL PUBLIC LICENSE';

describe('ThirdPartyNotices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the notice content once loaded', async () => {
    (api.getThirdPartyNotices as Mock).mockResolvedValue({ content: noticeContent });

    renderWithProviders(<ThirdPartyNotices />);

    await waitFor(() => {
      expect(screen.getByText(/This image bundles FFmpeg/)).toBeInTheDocument();
    });
    expect(screen.getByText(/GNU GENERAL PUBLIC LICENSE/)).toBeInTheDocument();
  });

  it('shows a loading affordance while the notice is fetching', () => {
    // Never resolves — keeps the query in the loading state.
    (api.getThirdPartyNotices as Mock).mockReturnValue(new Promise(() => {}));

    renderWithProviders(<ThirdPartyNotices />);

    expect(screen.getByText(/Loading third-party notices/i)).toBeInTheDocument();
  });

  it('shows an error affordance when the endpoint rejects with the 500 contract', async () => {
    (api.getThirdPartyNotices as Mock).mockRejectedValue(
      Object.assign(new Error('Failed to load third-party notices'), {
        status: 500,
        body: { error: 'Failed to load third-party notices' },
      }),
    );

    renderWithProviders(<ThirdPartyNotices />);

    await waitFor(() => {
      expect(screen.getByText(/Failed to load third-party notices/i)).toBeInTheDocument();
    });
  });
});
