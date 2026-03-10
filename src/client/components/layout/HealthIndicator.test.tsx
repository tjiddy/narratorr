import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../__tests__/helpers';
import { HealthIndicator } from './HealthIndicator';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

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

    // Wait for query to resolve
    await waitFor(() => {
      expect(api.getHealthSummary).toHaveBeenCalled();
    });

    // Should not render a visible indicator
    expect(container.querySelector('[data-testid="health-indicator"]')).toBeNull();
  });

  it('shows amber dot when any check in warning state', async () => {
    (api.getHealthSummary as Mock).mockResolvedValue({ state: 'warning' });

    renderWithProviders(<HealthIndicator />);

    await waitFor(() => {
      const button = screen.getByTestId('health-indicator');
      expect(button).toBeInTheDocument();
      const dot = button.querySelector('span');
      expect(dot?.className).toContain('amber');
    });
  });

  it('shows red dot when any check in error state (overrides amber)', async () => {
    (api.getHealthSummary as Mock).mockResolvedValue({ state: 'error' });

    renderWithProviders(<HealthIndicator />);

    await waitFor(() => {
      const button = screen.getByTestId('health-indicator');
      expect(button).toBeInTheDocument();
      const dot = button.querySelector('span');
      expect(dot?.className).toContain('red');
    });
  });

  it('click navigates to /settings/system', async () => {
    const user = userEvent.setup();
    (api.getHealthSummary as Mock).mockResolvedValue({ state: 'error' });

    renderWithProviders(<HealthIndicator />);

    await waitFor(() => {
      expect(screen.getByTestId('health-indicator')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('health-indicator'));
    expect(mockNavigate).toHaveBeenCalledWith('/settings/system');
  });
});
