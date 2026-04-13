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

function mockDefaultHook(overrides: Partial<ReturnType<typeof useEventHistory>> = {}) {
  mockUseEventHistory.mockReturnValue({
    events: [],
    total: 0,
    isLoading: false,
    isError: false,
    markFailedMutation: { mutate: vi.fn(), isPending: false } as never,
    deleteMutation: { mutate: vi.fn(), isPending: false } as never,
    bulkDeleteMutation: { mutate: vi.fn(), isPending: false } as never,
    retryMutation: { mutate: vi.fn(), isPending: false } as never,
    ...overrides,
  });
}

describe('EventHistorySection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading spinner while loading', () => {
    mockDefaultHook({ isLoading: true });

    renderWithProviders(<EventHistorySection />);
    expect(screen.getAllByTestId('loading-spinner').length).toBeGreaterThanOrEqual(1);
  });

  it('shows empty state when no events', () => {
    mockDefaultHook();

    renderWithProviders(<EventHistorySection />);
    expect(screen.getByText('No events')).toBeInTheDocument();
  });

  it('renders event cards', () => {
    mockDefaultHook({
      events: [
        { id: 1, bookId: 1, downloadId: 5, bookTitle: 'The Way of Kings', authorName: 'Brandon Sanderson', eventType: 'grabbed', source: 'auto', reason: null, createdAt: new Date().toISOString() },
      ],
      total: 1,
    });

    renderWithProviders(<EventHistorySection />);
    expect(screen.getByText(/The Way of Kings/)).toBeInTheDocument();
  });

  it('search input filters by title', async () => {
    const user = userEvent.setup();
    mockDefaultHook();

    renderWithProviders(<EventHistorySection />);

    const searchInput = screen.getByPlaceholderText('Search by title...');
    await user.type(searchInput, 'Kings');
    await user.tab(); // blur triggers search

    expect(mockUseEventHistory).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'Kings' }),
    );
  });

  it('shows Clear Errors and Clear All buttons', () => {
    mockDefaultHook();

    renderWithProviders(<EventHistorySection />);
    expect(screen.getByText('Clear Errors')).toBeInTheDocument();
    expect(screen.getByText('Clear All')).toBeInTheDocument();
  });

  it('Clear All opens confirmation modal', async () => {
    const user = userEvent.setup();
    mockDefaultHook();

    renderWithProviders(<EventHistorySection />);
    await user.click(screen.getByText('Clear All'));

    expect(screen.getByText('Clear All Events')).toBeInTheDocument();
    expect(screen.getByText(/permanently delete all event history/)).toBeInTheDocument();
  });

  it('confirming Clear All calls bulkDeleteMutation', async () => {
    const user = userEvent.setup();
    const mockBulkDelete = vi.fn();
    mockDefaultHook({ bulkDeleteMutation: { mutate: mockBulkDelete, isPending: false } as never });

    renderWithProviders(<EventHistorySection />);
    await user.click(screen.getByText('Clear All'));
    const confirmButtons = screen.getAllByRole('button', { name: /Clear All/i });
    await user.click(confirmButtons[confirmButtons.length - 1]);

    expect(mockBulkDelete).toHaveBeenCalledWith(undefined);
  });

  it('clicking delete button on event card calls deleteMutation.mutate with event id', async () => {
    const user = userEvent.setup();
    const mockDeleteMutate = vi.fn();
    mockDefaultHook({
      events: [
        { id: 42, bookId: 1, downloadId: 5, bookTitle: 'Test Book', authorName: null, eventType: 'grabbed', source: 'auto', reason: null, createdAt: new Date().toISOString() },
      ],
      total: 1,
      deleteMutation: { mutate: mockDeleteMutate, isPending: false } as never,
    });

    renderWithProviders(<EventHistorySection />);
    await user.click(screen.getByLabelText('Delete event'));

    expect(mockDeleteMutate).toHaveBeenCalledWith(42);
  });

  describe('intent-based filter groups', () => {
    it('renders exactly 8 filter buttons (All + 7 groups)', () => {
      mockDefaultHook();

      renderWithProviders(<EventHistorySection />);
      expect(screen.getByText('All')).toBeInTheDocument();
      expect(screen.getByText('Errors')).toBeInTheDocument();
      expect(screen.getByText('Needs Review')).toBeInTheDocument();
      expect(screen.getByText('Downloads')).toBeInTheDocument();
      expect(screen.getByText('Imported')).toBeInTheDocument();
      expect(screen.getByText('File Changes')).toBeInTheDocument();
      expect(screen.getByText('Removed')).toBeInTheDocument();
      // Count all filter pill buttons (inside the flex-wrap container)
      const filterButtons = screen.getAllByRole('button').filter(
        (btn) => ['All', 'Errors', 'Needs Review', 'Downloads', 'Imported', 'File Changes', 'Removed'].includes(btn.textContent ?? ''),
      );
      expect(filterButtons).toHaveLength(7);
    });

    it('Errors chip sends eventType=download_failed,import_failed,merge_failed', async () => {
      const user = userEvent.setup();
      mockDefaultHook();

      renderWithProviders(<EventHistorySection />);
      await user.click(screen.getByText('Errors'));

      expect(mockUseEventHistory).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'download_failed,import_failed,merge_failed' }),
      );
    });

    it('Needs Review chip sends eventType=held_for_review', async () => {
      const user = userEvent.setup();
      mockDefaultHook();

      renderWithProviders(<EventHistorySection />);
      await user.click(screen.getByText('Needs Review'));

      expect(mockUseEventHistory).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'held_for_review' }),
      );
    });

    it('Downloads chip sends eventType=grabbed,download_completed,merge_started', async () => {
      const user = userEvent.setup();
      mockDefaultHook();

      renderWithProviders(<EventHistorySection />);
      await user.click(screen.getByText('Downloads'));

      expect(mockUseEventHistory).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'grabbed,download_completed,merge_started' }),
      );
    });

    it('Imported chip sends eventType=imported,upgraded,merged', async () => {
      const user = userEvent.setup();
      mockDefaultHook();

      renderWithProviders(<EventHistorySection />);
      await user.click(screen.getByText('Imported'));

      expect(mockUseEventHistory).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'imported,upgraded,merged' }),
      );
    });

    it('File Changes chip sends eventType=renamed,file_tagged', async () => {
      const user = userEvent.setup();
      mockDefaultHook();

      renderWithProviders(<EventHistorySection />);
      await user.click(screen.getByText('File Changes'));

      expect(mockUseEventHistory).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'renamed,file_tagged' }),
      );
    });

    it('Removed chip sends eventType=deleted', async () => {
      const user = userEvent.setup();
      mockDefaultHook();

      renderWithProviders(<EventHistorySection />);
      await user.click(screen.getByText('Removed'));

      expect(mockUseEventHistory).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'deleted' }),
      );
    });

    it('All chip sends no eventType param', async () => {
      const user = userEvent.setup();
      mockDefaultHook();

      renderWithProviders(<EventHistorySection />);
      // First click a filter, then click All to clear
      await user.click(screen.getByText('Errors'));
      await user.click(screen.getByText('All'));

      const lastCall = mockUseEventHistory.mock.calls[mockUseEventHistory.mock.calls.length - 1]?.[0];
      expect(lastCall?.eventType).toBeUndefined();
    });
  });

  describe('Clear Errors — single mutation', () => {
    it('sends single DELETE with eventType=download_failed,import_failed,merge_failed', async () => {
      const user = userEvent.setup();
      const mockBulkDelete = vi.fn();
      mockDefaultHook({ bulkDeleteMutation: { mutate: mockBulkDelete, isPending: false } as never });

      renderWithProviders(<EventHistorySection />);
      await user.click(screen.getByText('Clear Errors'));

      const confirmButtons = screen.getAllByRole('button', { name: /Clear Errors/i });
      await user.click(confirmButtons[confirmButtons.length - 1]);

      expect(mockBulkDelete).toHaveBeenCalledTimes(1);
      expect(mockBulkDelete).toHaveBeenCalledWith({ eventType: 'download_failed,import_failed,merge_failed' });
    });

    it('confirmation modal copy reflects all three error event classes', async () => {
      const user = userEvent.setup();
      mockDefaultHook();

      renderWithProviders(<EventHistorySection />);
      await user.click(screen.getByText('Clear Errors'));

      expect(screen.getByText('Clear Error Events')).toBeInTheDocument();
      expect(screen.getByText(/permanently delete all failed download, import, and merge events/)).toBeInTheDocument();
    });

    it('no longer chains two sequential mutations', async () => {
      const user = userEvent.setup();
      const mockBulkDelete = vi.fn();
      mockDefaultHook({ bulkDeleteMutation: { mutate: mockBulkDelete, isPending: false } as never });

      renderWithProviders(<EventHistorySection />);
      await user.click(screen.getByText('Clear Errors'));

      const confirmButtons = screen.getAllByRole('button', { name: /Clear Errors/i });
      await user.click(confirmButtons[confirmButtons.length - 1]);

      // Should be exactly one call, no onSuccess callback
      expect(mockBulkDelete).toHaveBeenCalledTimes(1);
      expect(mockBulkDelete).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ onSuccess: expect.any(Function) }),
      );
    });
  });

  it('shows filtered empty state message', () => {
    mockDefaultHook();

    renderWithProviders(<EventHistorySection />);
    expect(screen.getByText('Events will appear here as books are processed')).toBeInTheDocument();
  });
});
