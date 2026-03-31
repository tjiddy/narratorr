import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EventHistoryCard } from './EventHistoryCard';
import type { BookEvent } from '@/lib/api';

function createMockEvent(overrides?: Partial<BookEvent>): BookEvent {
  return {
    id: 1,
    bookId: 1,
    downloadId: 5,
    bookTitle: 'The Way of Kings',
    authorName: 'Brandon Sanderson',
    eventType: 'grabbed',
    source: 'auto',
    reason: null,
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    ...overrides,
  };
}

describe('EventHistoryCard', () => {
  it('renders event type label, timestamp, and source', () => {
    render(<EventHistoryCard event={createMockEvent()} />);

    expect(screen.getByText('Grabbed')).toBeInTheDocument();
    expect(screen.getByText('auto')).toBeInTheDocument();
    expect(screen.getByText('1h ago')).toBeInTheDocument();
  });

  it('shows book title when showBookTitle is true', () => {
    render(<EventHistoryCard event={createMockEvent()} showBookTitle />);

    expect(screen.getByText(/The Way of Kings/)).toBeInTheDocument();
    expect(screen.getByText(/Brandon Sanderson/)).toBeInTheDocument();
  });

  it('hides book title when showBookTitle is false', () => {
    render(<EventHistoryCard event={createMockEvent()} showBookTitle={false} />);

    expect(screen.queryByText(/The Way of Kings/)).not.toBeInTheDocument();
  });

  it('shows Mark Failed button for actionable event types with download_id', () => {
    const onMarkFailed = vi.fn();
    render(<EventHistoryCard event={createMockEvent()} onMarkFailed={onMarkFailed} />);

    expect(screen.getByText('Mark Failed')).toBeInTheDocument();
  });

  it('hides Mark Failed button for non-actionable event types', () => {
    const onMarkFailed = vi.fn();
    render(
      <EventHistoryCard
        event={createMockEvent({ eventType: 'deleted', downloadId: null })}
        onMarkFailed={onMarkFailed}
      />,
    );

    expect(screen.queryByText('Mark Failed')).not.toBeInTheDocument();
  });

  it('hides Mark Failed button when downloadId is null', () => {
    const onMarkFailed = vi.fn();
    render(
      <EventHistoryCard
        event={createMockEvent({ downloadId: null })}
        onMarkFailed={onMarkFailed}
      />,
    );

    expect(screen.queryByText('Mark Failed')).not.toBeInTheDocument();
  });

  it('calls onMarkFailed with event id when button clicked', async () => {
    const user = userEvent.setup();
    const onMarkFailed = vi.fn();
    render(<EventHistoryCard event={createMockEvent({ id: 42 })} onMarkFailed={onMarkFailed} />);

    await user.click(screen.getByText('Mark Failed'));

    expect(onMarkFailed).toHaveBeenCalledWith(42);
  });

  it('toggles reason details on click', async () => {
    const user = userEvent.setup();
    const event = createMockEvent({ reason: { score: 95, protocol: 'torrent' } });
    render(<EventHistoryCard event={event} />);

    expect(screen.queryByText(/"score": 95/)).not.toBeInTheDocument();

    await user.click(screen.getByText('View details'));
    expect(screen.getByText(/"score": 95/)).toBeInTheDocument();

    await user.click(screen.getByText('Hide details'));
    expect(screen.queryByText(/"score": 95/)).not.toBeInTheDocument();
  });

  it('renders delete button when onDelete is provided', () => {
    const onDelete = vi.fn();
    render(<EventHistoryCard event={createMockEvent()} onDelete={onDelete} />);

    expect(screen.getByLabelText('Delete event')).toBeInTheDocument();
  });

  it('does not render delete button when onDelete is not provided', () => {
    render(<EventHistoryCard event={createMockEvent()} />);

    expect(screen.queryByLabelText('Delete event')).not.toBeInTheDocument();
  });

  it('calls onDelete with event id when delete button clicked', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(<EventHistoryCard event={createMockEvent({ id: 42 })} onDelete={onDelete} />);

    await user.click(screen.getByLabelText('Delete event'));

    expect(onDelete).toHaveBeenCalledWith(42);
  });

  it('disables delete button when isDeleting is true', () => {
    const onDelete = vi.fn();
    render(<EventHistoryCard event={createMockEvent()} onDelete={onDelete} isDeleting />);

    expect(screen.getByLabelText('Delete event')).toBeDisabled();
  });

  it('renders empty state for unknown event type gracefully', () => {
    render(<EventHistoryCard event={createMockEvent({ eventType: 'unknown_type' })} />);

    expect(screen.getByText('unknown_type')).toBeInTheDocument();
  });
});
