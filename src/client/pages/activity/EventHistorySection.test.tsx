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
      total: 0,
      isLoading: true,
      isError: false,
      markFailedMutation: { mutate: vi.fn(), isPending: false } as never,
      deleteMutation: { mutate: vi.fn(), isPending: false } as never,
      bulkDeleteMutation: { mutate: vi.fn(), isPending: false } as never,
    });

    renderWithProviders(<EventHistorySection />);
    expect(screen.getAllByTestId('loading-spinner').length).toBeGreaterThanOrEqual(1);
  });

  it('shows empty state when no events', () => {
    mockUseEventHistory.mockReturnValue({
      events: [],
      total: 0,
      isLoading: false,
      isError: false,
      markFailedMutation: { mutate: vi.fn(), isPending: false } as never,
      deleteMutation: { mutate: vi.fn(), isPending: false } as never,
      bulkDeleteMutation: { mutate: vi.fn(), isPending: false } as never,
    });

    renderWithProviders(<EventHistorySection />);
    expect(screen.getByText('No events')).toBeInTheDocument();
  });

  it('renders event cards', () => {
    mockUseEventHistory.mockReturnValue({
      events: [
        { id: 1, bookId: 1, downloadId: 5, bookTitle: 'The Way of Kings', authorName: 'Brandon Sanderson', eventType: 'grabbed', source: 'auto', reason: null, createdAt: new Date().toISOString() },
      ],
      total: 1,
      isLoading: false,
      isError: false,
      markFailedMutation: { mutate: vi.fn(), isPending: false } as never,
      deleteMutation: { mutate: vi.fn(), isPending: false } as never,
      bulkDeleteMutation: { mutate: vi.fn(), isPending: false } as never,
    });

    renderWithProviders(<EventHistorySection />);
    // "Grabbed" appears in both the filter pill and the event card
    expect(screen.getAllByText('Grabbed')).toHaveLength(2);
    expect(screen.getByText(/The Way of Kings/)).toBeInTheDocument();
  });

  it('renders type filter pills', () => {
    mockUseEventHistory.mockReturnValue({
      events: [],
      total: 0,
      isLoading: false,
      isError: false,
      markFailedMutation: { mutate: vi.fn(), isPending: false } as never,
      deleteMutation: { mutate: vi.fn(), isPending: false } as never,
      bulkDeleteMutation: { mutate: vi.fn(), isPending: false } as never,
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
      total: 0,
      isLoading: false,
      isError: false,
      markFailedMutation: { mutate: vi.fn(), isPending: false } as never,
      deleteMutation: { mutate: vi.fn(), isPending: false } as never,
      bulkDeleteMutation: { mutate: vi.fn(), isPending: false } as never,
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
      total: 0,
      isLoading: false,
      isError: false,
      markFailedMutation: { mutate: vi.fn(), isPending: false } as never,
      deleteMutation: { mutate: vi.fn(), isPending: false } as never,
      bulkDeleteMutation: { mutate: vi.fn(), isPending: false } as never,
    });

    renderWithProviders(<EventHistorySection />);

    const searchInput = screen.getByPlaceholderText('Search by title...');
    await user.type(searchInput, 'Kings');
    await user.tab(); // blur triggers search

    expect(mockUseEventHistory).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'Kings' }),
    );
  });

  it('shows Clear Errors and Clear All buttons', () => {
    mockUseEventHistory.mockReturnValue({
      events: [],
      total: 0,
      isLoading: false,
      isError: false,
      markFailedMutation: { mutate: vi.fn(), isPending: false } as never,
      deleteMutation: { mutate: vi.fn(), isPending: false } as never,
      bulkDeleteMutation: { mutate: vi.fn(), isPending: false } as never,
    });

    renderWithProviders(<EventHistorySection />);
    expect(screen.getByText('Clear Errors')).toBeInTheDocument();
    expect(screen.getByText('Clear All')).toBeInTheDocument();
  });

  it('Clear All opens confirmation modal', async () => {
    const user = userEvent.setup();
    mockUseEventHistory.mockReturnValue({
      events: [],
      total: 0,
      isLoading: false,
      isError: false,
      markFailedMutation: { mutate: vi.fn(), isPending: false } as never,
      deleteMutation: { mutate: vi.fn(), isPending: false } as never,
      bulkDeleteMutation: { mutate: vi.fn(), isPending: false } as never,
    });

    renderWithProviders(<EventHistorySection />);
    await user.click(screen.getByText('Clear All'));

    expect(screen.getByText('Clear All Events')).toBeInTheDocument();
    expect(screen.getByText(/permanently delete all event history/)).toBeInTheDocument();
  });

  it('confirming Clear All calls bulkDeleteMutation', async () => {
    const user = userEvent.setup();
    const mockBulkDelete = vi.fn();
    mockUseEventHistory.mockReturnValue({
      events: [],
      total: 0,
      isLoading: false,
      isError: false,
      markFailedMutation: { mutate: vi.fn(), isPending: false } as never,
      deleteMutation: { mutate: vi.fn(), isPending: false } as never,
      bulkDeleteMutation: { mutate: mockBulkDelete, isPending: false } as never,
    });

    renderWithProviders(<EventHistorySection />);
    await user.click(screen.getByText('Clear All'));
    // The confirm button inside the modal — find the one in the modal dialog
    const confirmButtons = screen.getAllByRole('button', { name: /Clear All/i });
    // The last one is in the modal
    await user.click(confirmButtons[confirmButtons.length - 1]);

    expect(mockBulkDelete).toHaveBeenCalledWith(undefined);
  });

  it('clicking delete button on event card calls deleteMutation.mutate with event id', async () => {
    const user = userEvent.setup();
    const mockDeleteMutate = vi.fn();
    mockUseEventHistory.mockReturnValue({
      events: [
        { id: 42, bookId: 1, downloadId: 5, bookTitle: 'Test Book', authorName: null, eventType: 'grabbed', source: 'auto', reason: null, createdAt: new Date().toISOString() },
      ],
      total: 1,
      isLoading: false,
      isError: false,
      markFailedMutation: { mutate: vi.fn(), isPending: false } as never,
      deleteMutation: { mutate: mockDeleteMutate, isPending: false } as never,
      bulkDeleteMutation: { mutate: vi.fn(), isPending: false } as never,
    });

    renderWithProviders(<EventHistorySection />);
    await user.click(screen.getByLabelText('Delete event'));

    expect(mockDeleteMutate).toHaveBeenCalledWith(42);
  });

  it('Clear Errors opens error-specific confirmation modal', async () => {
    const user = userEvent.setup();
    mockUseEventHistory.mockReturnValue({
      events: [],
      total: 0,
      isLoading: false,
      isError: false,
      markFailedMutation: { mutate: vi.fn(), isPending: false } as never,
      deleteMutation: { mutate: vi.fn(), isPending: false } as never,
      bulkDeleteMutation: { mutate: vi.fn(), isPending: false } as never,
    });

    renderWithProviders(<EventHistorySection />);
    await user.click(screen.getByText('Clear Errors'));

    expect(screen.getByText('Clear Error Events')).toBeInTheDocument();
    expect(screen.getByText(/permanently delete all failed download and import events/)).toBeInTheDocument();
  });

  it('confirming Clear Errors calls bulkDeleteMutation with download_failed then import_failed on success', async () => {
    const user = userEvent.setup();
    const mockBulkDelete = vi.fn();
    mockUseEventHistory.mockReturnValue({
      events: [],
      total: 0,
      isLoading: false,
      isError: false,
      markFailedMutation: { mutate: vi.fn(), isPending: false } as never,
      deleteMutation: { mutate: vi.fn(), isPending: false } as never,
      bulkDeleteMutation: { mutate: mockBulkDelete, isPending: false } as never,
    });

    renderWithProviders(<EventHistorySection />);
    await user.click(screen.getByText('Clear Errors'));

    // Find the confirm button inside the modal
    const confirmButtons = screen.getAllByRole('button', { name: /Clear Errors/i });
    await user.click(confirmButtons[confirmButtons.length - 1]);

    // First call: delete download_failed events with onSuccess callback
    expect(mockBulkDelete).toHaveBeenCalledWith(
      { eventType: 'download_failed' },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );

    // Simulate onSuccess firing → should trigger second call with import_failed
    const firstCallOptions = mockBulkDelete.mock.calls[0][1];
    firstCallOptions.onSuccess();

    expect(mockBulkDelete).toHaveBeenCalledTimes(2);
    expect(mockBulkDelete).toHaveBeenLastCalledWith({ eventType: 'import_failed' });
  });

  it('shows filtered empty state message', () => {
    mockUseEventHistory.mockReturnValue({
      events: [],
      total: 0,
      isLoading: false,
      isError: false,
      markFailedMutation: { mutate: vi.fn(), isPending: false } as never,
      deleteMutation: { mutate: vi.fn(), isPending: false } as never,
      bulkDeleteMutation: { mutate: vi.fn(), isPending: false } as never,
    });

    renderWithProviders(<EventHistorySection />);
    expect(screen.getByText('Events will appear here as books are processed')).toBeInTheDocument();
  });
});
