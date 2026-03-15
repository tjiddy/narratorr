import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { BookEventHistory } from './BookEventHistory';

vi.mock('@/hooks/useEventHistory', () => ({
  useBookEventHistory: vi.fn(),
}));

import { useBookEventHistory } from '@/hooks/useEventHistory';

const mockUseBookEventHistory = vi.mocked(useBookEventHistory);

describe('BookEventHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading spinner while loading', () => {
    mockUseBookEventHistory.mockReturnValue({
      events: [],
      isLoading: true,
      isError: false,
      markFailedMutation: { mutate: vi.fn(), isPending: false } as never,
      deleteMutation: { mutate: vi.fn(), isPending: false } as never,
    });

    renderWithProviders(<BookEventHistory bookId={1} />);
    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
  });

  it('shows empty state when no events', () => {
    mockUseBookEventHistory.mockReturnValue({
      events: [],
      isLoading: false,
      isError: false,
      markFailedMutation: { mutate: vi.fn(), isPending: false } as never,
      deleteMutation: { mutate: vi.fn(), isPending: false } as never,
    });

    renderWithProviders(<BookEventHistory bookId={1} />);
    expect(screen.getByText('No history yet')).toBeInTheDocument();
  });

  it('clicking delete button on event card calls deleteMutation.mutate with event id', async () => {
    const user = userEvent.setup();
    const mockDeleteMutate = vi.fn();
    mockUseBookEventHistory.mockReturnValue({
      events: [
        { id: 7, bookId: 1, downloadId: 5, bookTitle: 'Test', authorName: null, eventType: 'grabbed', source: 'auto', reason: null, createdAt: new Date().toISOString() },
      ],
      isLoading: false,
      isError: false,
      markFailedMutation: { mutate: vi.fn(), isPending: false } as never,
      deleteMutation: { mutate: mockDeleteMutate, isPending: false } as never,
    });

    renderWithProviders(<BookEventHistory bookId={1} />);

    await user.click(screen.getByLabelText('Delete event'));

    expect(mockDeleteMutate).toHaveBeenCalledWith(7);
  });

  it('renders event cards for each event', () => {
    mockUseBookEventHistory.mockReturnValue({
      events: [
        { id: 1, bookId: 1, downloadId: 5, bookTitle: 'Test', authorName: null, eventType: 'grabbed', source: 'auto', reason: null, createdAt: new Date().toISOString() },
        { id: 2, bookId: 1, downloadId: null, bookTitle: 'Test', authorName: null, eventType: 'imported', source: 'auto', reason: null, createdAt: new Date().toISOString() },
      ],
      isLoading: false,
      isError: false,
      markFailedMutation: { mutate: vi.fn(), isPending: false } as never,
      deleteMutation: { mutate: vi.fn(), isPending: false } as never,
    });

    renderWithProviders(<BookEventHistory bookId={1} />);
    expect(screen.getByText('Grabbed')).toBeInTheDocument();
    expect(screen.getByText('Imported')).toBeInTheDocument();
  });
});
