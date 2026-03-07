import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { BlacklistSettings } from './BlacklistSettings';

vi.mock('@/lib/api', () => ({
  api: {
    getBlacklist: vi.fn(),
    removeFromBlacklist: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { api } from '@/lib/api';

const mockEntries = [
  {
    id: 1,
    infoHash: 'abc123def456789',
    title: 'Bad Release [Unabridged]',
    reason: 'wrong_content' as const,
    note: 'Not the right book',
    blacklistedAt: '2024-06-15T12:00:00Z',
  },
  {
    id: 2,
    infoHash: 'xyz789abc123456',
    title: 'Spam Release',
    reason: 'spam' as const,
    blacklistedAt: '2024-06-16T12:00:00Z',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BlacklistSettings', () => {
  it('shows empty state when no entries', async () => {
    vi.mocked(api.getBlacklist).mockResolvedValue([]);

    renderWithProviders(<BlacklistSettings />);

    await waitFor(() => {
      expect(screen.getByText('No blacklisted releases')).toBeInTheDocument();
    });
  });

  it('renders blacklist entries', async () => {
    vi.mocked(api.getBlacklist).mockResolvedValue(mockEntries);

    renderWithProviders(<BlacklistSettings />);

    await waitFor(() => {
      expect(screen.getByText('Bad Release [Unabridged]')).toBeInTheDocument();
    });
    expect(screen.getByText('Spam Release')).toBeInTheDocument();
    expect(screen.getByText('Wrong Content')).toBeInTheDocument();
    expect(screen.getByText('Spam')).toBeInTheDocument();
  });

  it('shows note when present', async () => {
    vi.mocked(api.getBlacklist).mockResolvedValue(mockEntries);

    renderWithProviders(<BlacklistSettings />);

    await waitFor(() => {
      expect(screen.getByText('Not the right book')).toBeInTheDocument();
    });
  });

  it('shows truncated info hash', async () => {
    vi.mocked(api.getBlacklist).mockResolvedValue(mockEntries);

    renderWithProviders(<BlacklistSettings />);

    await waitFor(() => {
      expect(screen.getByText('abc123def456...')).toBeInTheDocument();
    });
  });

  it('opens confirm modal and deletes entry', async () => {
    vi.mocked(api.getBlacklist).mockResolvedValue(mockEntries);
    vi.mocked(api.removeFromBlacklist).mockResolvedValue({ success: true });
    const user = userEvent.setup();

    renderWithProviders(<BlacklistSettings />);

    await waitFor(() => {
      expect(screen.getByText('Bad Release [Unabridged]')).toBeInTheDocument();
    });

    // Click delete on first entry
    const deleteButtons = screen.getAllByLabelText(/Remove .* from blacklist/);
    await user.click(deleteButtons[0]);

    // Confirm modal should appear
    expect(screen.getByText(/Remove "Bad Release \[Unabridged\]" from the blacklist/)).toBeInTheDocument();

    // Click the "Delete" confirm button
    const confirmButton = screen.getByRole('button', { name: 'Delete' });
    await user.click(confirmButton);

    await waitFor(() => {
      expect(api.removeFromBlacklist).toHaveBeenCalled();
      expect(vi.mocked(api.removeFromBlacklist).mock.calls[0][0]).toBe(1);
    });
  });
});
