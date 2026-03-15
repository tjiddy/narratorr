import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { EventHistorySection } from './EventHistorySection';

vi.mock('@/hooks/useEventHistory', () => ({
  useEventHistory: vi.fn(),
}));

import { useEventHistory } from '@/hooks/useEventHistory';

const mockUseEventHistory = vi.mocked(useEventHistory);

describe('EventHistorySection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading spinner while loading', () => {
    mockUseEventHistory.mockReturnValue({
      events: [],
      isLoading: true,
      isError: false,
      markFailedMutation: { mutate: vi.fn(), isPending: false } as never,
    });

    renderWithProviders(<EventHistorySection />);
    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
  });

  it('shows empty state when no events', () => {
    mockUseEventHistory.mockReturnValue({
      events: [],
      isLoading: false,
      isError: false,
      markFailedMutation: { mutate: vi.fn(), isPending: false } as never,
    });

    renderWithProviders(<EventHistorySection />);
    expect(screen.getByText('No events')).toBeInTheDocument();
  });

  it('renders event cards', () => {
    mockUseEventHistory.mockReturnValue({
      events: [
        { id: 1, bookId: 1, downloadId: 5, bookTitle: 'The Way of Kings', authorName: 'Brandon Sanderson', eventType: 'grabbed', source: 'auto', reason: null, createdAt: new Date().toISOString() },
      ],
      isLoading: false,
      isError: false,
      markFailedMutation: { mutate: vi.fn(), isPending: false } as never,
    });

    renderWithProviders(<EventHistorySection />);
    // "Grabbed" appears in both the filter pill and the event card
    expect(screen.getAllByText('Grabbed')).toHaveLength(2);
    expect(screen.getByText(/The Way of Kings/)).toBeInTheDocument();
  });

  it('renders type filter pills', () => {
    mockUseEventHistory.mockReturnValue({
      events: [],
      isLoading: false,
      isError: false,
      markFailedMutation: { mutate: vi.fn(), isPending: false } as never,
    });

    renderWithProviders(<EventHistorySection />);
    expect(screen.getByText('All')).toBeInTheDocument();
    expect(screen.getByText('Grabbed')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('type filter changes displayed events', async () => {
    const user = userEvent.setup();
    mockUseEventHistory.mockReturnValue({
      events: [],
      isLoading: false,
      isError: false,
      markFailedMutation: { mutate: vi.fn(), isPending: false } as never,
    });

    renderWithProviders(<EventHistorySection />);

    await user.click(screen.getByText('Grabbed'));

    // The hook should be called with the new filter
    expect(mockUseEventHistory).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'grabbed' }),
    );
  });

  it('search input filters by title', async () => {
    const user = userEvent.setup();
    mockUseEventHistory.mockReturnValue({
      events: [],
      isLoading: false,
      isError: false,
      markFailedMutation: { mutate: vi.fn(), isPending: false } as never,
    });

    renderWithProviders(<EventHistorySection />);

    const searchInput = screen.getByPlaceholderText('Search by title...');
    await user.type(searchInput, 'Kings');
    await user.tab(); // blur triggers search

    expect(mockUseEventHistory).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'Kings' }),
    );
  });

  it('shows filtered empty state message', () => {
    mockUseEventHistory.mockReturnValue({
      events: [],
      isLoading: false,
      isError: false,
      markFailedMutation: { mutate: vi.fn(), isPending: false } as never,
    });

    renderWithProviders(<EventHistorySection />);
    expect(screen.getByText('Events will appear here as books are processed')).toBeInTheDocument();
  });
});
