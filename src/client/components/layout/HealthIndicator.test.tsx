import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../__tests__/helpers';
import { HealthIndicator } from './HealthIndicator';

vi.mock('@/lib/api', () => ({
  api: {
    getHealthSummary: vi.fn(),
  },
}));

import { api } from '@/lib/api';
import type { Mock } from 'vitest';

describe('HealthIndicator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hidden when all checks healthy', async () => {
    (api.getHealthSummary as Mock).mockResolvedValue({ state: 'healthy' });

    const { container } = renderWithProviders(<HealthIndicator />);

    await waitFor(() => {
      expect(api.getHealthSummary).toHaveBeenCalled();
    });

    expect(container.querySelector('[data-testid="health-indicator"]')).toBeNull();
  });

  it('shows amber dot when any check in warning state', async () => {
    (api.getHealthSummary as Mock).mockResolvedValue({ state: 'warning' });

    renderWithProviders(<HealthIndicator />);

    await waitFor(() => {
      const link = screen.getByTestId('health-indicator');
      expect(link).toBeInTheDocument();
      const dot = link.querySelector('span');
      expect(dot?.className).toContain('amber');
    });
  });

  it('shows red dot when any check in error state (overrides amber)', async () => {
    (api.getHealthSummary as Mock).mockResolvedValue({ state: 'error' });

    renderWithProviders(<HealthIndicator />);

    await waitFor(() => {
      const link = screen.getByTestId('health-indicator');
      expect(link).toBeInTheDocument();
      const dot = link.querySelector('span');
      expect(dot?.className).toContain('red');
    });
  });

  it('renders a link resolving to /settings/system (guardable by the unsaved-changes guard)', async () => {
    (api.getHealthSummary as Mock).mockResolvedValue({ state: 'error' });

    renderWithProviders(<HealthIndicator />);

    const link = await screen.findByRole('link', { name: /health: error/i });
    expect(link).toHaveAttribute('href', '/settings/system');
  });

  it('resolves the link under a subpath basename', async () => {
    (api.getHealthSummary as Mock).mockResolvedValue({ state: 'error' });

    renderWithProviders(<HealthIndicator />, { basename: '/narratorr' });

    const link = await screen.findByRole('link', { name: /health: error/i });
    expect(link).toHaveAttribute('href', '/narratorr/settings/system');
  });

  it('has aria-label on the health status link that includes the health state', async () => {
    (api.getHealthSummary as Mock).mockResolvedValue({ state: 'error' });
    renderWithProviders(<HealthIndicator />);
    await waitFor(() => {
      const link = screen.getByTestId('health-indicator');
      expect(link).toHaveAttribute('aria-label', expect.stringContaining('error'));
    });
  });
});
