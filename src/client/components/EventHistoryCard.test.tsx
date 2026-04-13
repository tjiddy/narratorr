import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { EventHistoryCard } from './EventHistoryCard';
import type { BookEvent } from '@/lib/api';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  const actualApi = (actual as { api: Record<string, unknown> }).api;
  return {
    ...actual,
    api: {
      ...actualApi,
      getIndexers: vi.fn().mockResolvedValue([
        { id: 3, name: 'DrunkenSlug', type: 'newznab', enabled: true, priority: 1, settings: {}, source: null, sourceIndexerId: null, createdAt: '' },
      ]),
    },
  };
});

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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders event type label, timestamp, and source', () => {
    renderWithProviders(<EventHistoryCard event={createMockEvent()} />);

    expect(screen.getByText('Grabbed')).toBeInTheDocument();
    expect(screen.getByText('auto')).toBeInTheDocument();
    expect(screen.getByText('1h ago')).toBeInTheDocument();
  });

  it('shows book title when showBookTitle is true', () => {
    renderWithProviders(<EventHistoryCard event={createMockEvent()} showBookTitle />);

    expect(screen.getByText(/The Way of Kings/)).toBeInTheDocument();
    expect(screen.getByText(/Brandon Sanderson/)).toBeInTheDocument();
  });

  it('hides book title when showBookTitle is false', () => {
    renderWithProviders(<EventHistoryCard event={createMockEvent()} showBookTitle={false} />);

    expect(screen.queryByText(/The Way of Kings/)).not.toBeInTheDocument();
  });

  it('shows Mark Failed button for actionable event types with download_id', () => {
    const onMarkFailed = vi.fn();
    renderWithProviders(<EventHistoryCard event={createMockEvent()} onMarkFailed={onMarkFailed} />);

    expect(screen.getByText('Mark Failed')).toBeInTheDocument();
  });

  it('hides Mark Failed button for non-actionable event types', () => {
    const onMarkFailed = vi.fn();
    renderWithProviders(
      <EventHistoryCard
        event={createMockEvent({ eventType: 'deleted', downloadId: null })}
        onMarkFailed={onMarkFailed}
      />,
    );

    expect(screen.queryByText('Mark Failed')).not.toBeInTheDocument();
  });

  it('hides Mark Failed button when downloadId is null', () => {
    const onMarkFailed = vi.fn();
    renderWithProviders(
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
    renderWithProviders(<EventHistoryCard event={createMockEvent({ id: 42 })} onMarkFailed={onMarkFailed} />);

    await user.click(screen.getByText('Mark Failed'));

    expect(onMarkFailed).toHaveBeenCalledWith(42);
  });

  it('toggles reason details on click', async () => {
    const user = userEvent.setup();
    const event = createMockEvent({ reason: { indexerId: 3, size: 1024, protocol: 'torrent' } });
    renderWithProviders(<EventHistoryCard event={event} />);

    expect(screen.queryByText('View details')).toBeInTheDocument();
    expect(screen.queryByText('Indexer:')).not.toBeInTheDocument();

    await user.click(screen.getByText('View details'));
    expect(screen.getByText('Indexer:')).toBeInTheDocument();

    await user.click(screen.getByText('Hide details'));
    expect(screen.queryByText('Indexer:')).not.toBeInTheDocument();
  });

  it('renders delete button when onDelete is provided', () => {
    const onDelete = vi.fn();
    renderWithProviders(<EventHistoryCard event={createMockEvent()} onDelete={onDelete} />);

    expect(screen.getByLabelText('Delete event')).toBeInTheDocument();
  });

  it('does not render delete button when onDelete is not provided', () => {
    renderWithProviders(<EventHistoryCard event={createMockEvent()} />);

    expect(screen.queryByLabelText('Delete event')).not.toBeInTheDocument();
  });

  it('calls onDelete with event id when delete button clicked', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    renderWithProviders(<EventHistoryCard event={createMockEvent({ id: 42 })} onDelete={onDelete} />);

    await user.click(screen.getByLabelText('Delete event'));

    expect(onDelete).toHaveBeenCalledWith(42);
  });

  it('disables delete button when isDeleting is true', () => {
    const onDelete = vi.fn();
    renderWithProviders(<EventHistoryCard event={createMockEvent()} onDelete={onDelete} isDeleting />);

    expect(screen.getByLabelText('Delete event')).toBeDisabled();
  });

  it('renders empty state for unknown event type gracefully', () => {
    renderWithProviders(<EventHistoryCard event={createMockEvent({ eventType: 'unknown_type' })} />);

    expect(screen.getByText('unknown_type')).toBeInTheDocument();
  });
});

// ============================================================================
// #257 — Merge observability: EventHistoryCard rendering for merge events
// ============================================================================

describe('#257 merge observability — EventHistoryCard', () => {
  it('merge_started renders with label "Merge Started" (not fallback)', () => {
    renderWithProviders(<EventHistoryCard event={createMockEvent({ eventType: 'merge_started' })} />);
    expect(screen.getByText('Merge Started')).toBeInTheDocument();
    expect(screen.queryByText('merge_started')).not.toBeInTheDocument();
  });

  it('merge_failed renders with label "Merge Failed"', () => {
    renderWithProviders(<EventHistoryCard event={createMockEvent({ eventType: 'merge_failed' })} />);
    expect(screen.getByText('Merge Failed')).toBeInTheDocument();
    expect(screen.queryByText('merge_failed')).not.toBeInTheDocument();
  });

  it('merge_failed renders error reason as text', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EventHistoryCard event={createMockEvent({
      eventType: 'merge_failed',
      reason: { error: 'ffmpeg exited with code 1' },
    })} />);

    await user.click(screen.getByText('View details'));
    expect(screen.getByText('ffmpeg exited with code 1')).toBeInTheDocument();
  });

  it('merged renders with label "Merged" (not fallback)', () => {
    renderWithProviders(<EventHistoryCard event={createMockEvent({ eventType: 'merged' })} />);
    expect(screen.getByText('Merged')).toBeInTheDocument();
    expect(screen.queryByText('merged')).not.toBeInTheDocument();
  });

  it('wrong_release renders with label "Wrong Release" (not fallback)', () => {
    renderWithProviders(<EventHistoryCard event={createMockEvent({ eventType: 'wrong_release' })} />);
    expect(screen.getByText('Wrong Release')).toBeInTheDocument();
    expect(screen.queryByText('wrong_release')).not.toBeInTheDocument();
  });

  // #341 — book_added event display
  it('book_added renders with label "Book Added" (not fallback)', () => {
    renderWithProviders(<EventHistoryCard event={createMockEvent({ eventType: 'book_added' })} />);
    expect(screen.getByText('Book Added')).toBeInTheDocument();
    expect(screen.queryByText('book_added')).not.toBeInTheDocument();
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
  });
});

// ============================================================================
// #455 — Event history timeline polish: per-event-type reason rendering
// ============================================================================

describe('#455 event reason rendering', () => {
  describe('details toggle with empty/null reason', () => {
    it('hides details toggle when reason is null', () => {
      renderWithProviders(<EventHistoryCard event={createMockEvent({ reason: null })} />);
      expect(screen.queryByText('View details')).not.toBeInTheDocument();
    });

    it('hides details toggle when reason is empty object {}', () => {
      renderWithProviders(<EventHistoryCard event={createMockEvent({ reason: {} })} />);
      expect(screen.queryByText('View details')).not.toBeInTheDocument();
    });

    // #464 — all-null reason should not show toggle (reviewer suggestion F1)
    it('hides details toggle when all reason values are null/undefined', () => {
      renderWithProviders(<EventHistoryCard event={createMockEvent({
        eventType: 'grabbed',
        reason: { indexerId: undefined, size: undefined, protocol: undefined },
      })} />);
      expect(screen.queryByText('View details')).not.toBeInTheDocument();
    });
  });

  describe('grabbed event summary line', () => {
    it('shows indexer name, protocol, and formatted size inline', async () => {
      renderWithProviders(<EventHistoryCard event={createMockEvent({
        eventType: 'grabbed',
        reason: { indexerId: 3, size: 2000000000, protocol: 'usenet' },
      })} />);

      // Summary should be visible without expanding — uses getEventSummary
      // Before indexer data loads, falls back to ID
      expect(await screen.findByText(/DrunkenSlug/)).toBeInTheDocument();
      expect(screen.getByText(/Usenet/)).toBeInTheDocument();
      expect(screen.getByText(/1\.86 GB/)).toBeInTheDocument();
    });

    it('falls back to raw indexer ID when indexer not found', () => {
      renderWithProviders(<EventHistoryCard event={createMockEvent({
        eventType: 'grabbed',
        reason: { indexerId: 99, size: 1000, protocol: 'torrent' },
      })} />);

      expect(screen.getByText(/99/)).toBeInTheDocument();
    });

    it('shows "0 B" for size: 0 (falsy but valid)', () => {
      renderWithProviders(<EventHistoryCard event={createMockEvent({
        eventType: 'grabbed',
        reason: { indexerId: 3, size: 0, protocol: 'torrent' },
      })} />);

      expect(screen.getByText(/0 B/)).toBeInTheDocument();
    });
  });

  describe('grabbed event details', () => {
    it('renders key-value pairs instead of raw JSON on expand', async () => {
      const user = userEvent.setup();
      renderWithProviders(<EventHistoryCard event={createMockEvent({
        eventType: 'grabbed',
        reason: { indexerId: 3, size: 1048576, protocol: 'torrent' },
      })} />);

      await user.click(screen.getByText('View details'));
      expect(screen.getByText('Indexer:')).toBeInTheDocument();
      expect(screen.getByText('Protocol:')).toBeInTheDocument();
      expect(screen.getByText('Size:')).toBeInTheDocument();
      // Should NOT contain raw JSON
      expect(screen.queryByText(/"indexerId"/)).not.toBeInTheDocument();
    });
  });

  describe('imported event details', () => {
    it('auto import shows targetPath, fileCount, and formatted totalSize', async () => {
      const user = userEvent.setup();
      renderWithProviders(<EventHistoryCard event={createMockEvent({
        eventType: 'imported',
        reason: { targetPath: '/library/Author/Title', fileCount: 12, totalSize: 1073741824 },
      })} />);

      await user.click(screen.getByText('View details'));
      expect(screen.getByText('/library/Author/Title')).toBeInTheDocument();
      expect(screen.getByText('12')).toBeInTheDocument();
      expect(screen.getByText('1 GB')).toBeInTheDocument();
    });

    it('manual import shows targetPath and mode', async () => {
      const user = userEvent.setup();
      renderWithProviders(<EventHistoryCard event={createMockEvent({
        eventType: 'imported',
        reason: { targetPath: '/library/Author/Title', mode: 'copy' },
      })} />);

      await user.click(screen.getByText('View details'));
      expect(screen.getByText('/library/Author/Title')).toBeInTheDocument();
      expect(screen.getByText('Copy')).toBeInTheDocument();
    });
  });

  describe('error event details', () => {
    it('import_failed shows error as plain text', async () => {
      const user = userEvent.setup();
      renderWithProviders(<EventHistoryCard event={createMockEvent({
        eventType: 'import_failed',
        reason: { error: 'ffmpeg exited with code 1' },
      })} />);

      await user.click(screen.getByText('View details'));
      expect(screen.getByText('ffmpeg exited with code 1')).toBeInTheDocument();
      // Not wrapped in JSON
      expect(screen.queryByText(/"error"/)).not.toBeInTheDocument();
    });

    it('merge_failed shows error as plain text', async () => {
      const user = userEvent.setup();
      renderWithProviders(<EventHistoryCard event={createMockEvent({
        eventType: 'merge_failed',
        reason: { error: 'unsupported format' },
      })} />);

      await user.click(screen.getByText('View details'));
      expect(screen.getByText('unsupported format')).toBeInTheDocument();
    });
  });

  describe('held_for_review event details', () => {
    it('shows human-readable hold reasons', async () => {
      const user = userEvent.setup();
      renderWithProviders(<EventHistoryCard event={createMockEvent({
        eventType: 'held_for_review',
        reason: {
          action: 'held',
          mbPerHour: 128,
          existingMbPerHour: 64,
          narratorMatch: false,
          existingNarrator: 'John Smith',
          downloadNarrator: 'Jane Doe',
          durationDelta: 0.05,
          existingDuration: 36000,
          downloadedDuration: 37800,
          codec: 'mp3',
          channels: 2,
          existingCodec: 'mp3',
          existingChannels: 2,
          probeFailure: false,
          probeError: null,
          holdReasons: ['narrator_mismatch', 'duration_delta'],
        },
      })} />);

      await user.click(screen.getByText('View details'));
      expect(screen.getByText('narrator mismatch')).toBeInTheDocument();
      expect(screen.getByText('duration delta')).toBeInTheDocument();
    });

    it('shows quality comparison data', async () => {
      const user = userEvent.setup();
      renderWithProviders(<EventHistoryCard event={createMockEvent({
        eventType: 'held_for_review',
        reason: {
          action: 'held',
          mbPerHour: 128,
          existingMbPerHour: 64,
          narratorMatch: null,
          existingNarrator: null,
          downloadNarrator: null,
          durationDelta: null,
          existingDuration: null,
          downloadedDuration: null,
          codec: null,
          channels: null,
          existingCodec: null,
          existingChannels: null,
          probeFailure: false,
          probeError: null,
          holdReasons: [],
        },
      })} />);

      await user.click(screen.getByText('View details'));
      expect(screen.getByText('Quality Comparison')).toBeInTheDocument();
      expect(screen.getByText('128 MB/hr')).toBeInTheDocument();
      expect(screen.getByText('64 MB/hr')).toBeInTheDocument();
    });
  });

  describe('generic fallback', () => {
    it('unknown event type with reason renders as key-value pairs, not JSON', async () => {
      const user = userEvent.setup();
      renderWithProviders(<EventHistoryCard event={createMockEvent({
        eventType: 'some_future_type',
        reason: { foo: 'bar', count: 42 },
      })} />);

      await user.click(screen.getByText('View details'));
      expect(screen.getByText('Foo:')).toBeInTheDocument();
      expect(screen.getByText('bar')).toBeInTheDocument();
      expect(screen.getByText('42')).toBeInTheDocument();
      // Not raw JSON dump
      expect(screen.queryByText(/"foo"/)).not.toBeInTheDocument();
    });
  });

  describe('interaction', () => {
    it('clicking View details expands formatted details', async () => {
      const user = userEvent.setup();
      renderWithProviders(<EventHistoryCard event={createMockEvent({
        eventType: 'download_completed',
        reason: { progress: 1 },
      })} />);

      expect(screen.queryByText('Progress:')).not.toBeInTheDocument();
      await user.click(screen.getByText('View details'));
      expect(screen.getByText('Progress:')).toBeInTheDocument();
    });

    it('clicking Hide details collapses them', async () => {
      const user = userEvent.setup();
      renderWithProviders(<EventHistoryCard event={createMockEvent({
        eventType: 'download_completed',
        reason: { progress: 1 },
      })} />);

      await user.click(screen.getByText('View details'));
      expect(screen.getByText('Progress:')).toBeInTheDocument();

      await user.click(screen.getByText('Hide details'));
      expect(screen.queryByText('Progress:')).not.toBeInTheDocument();
    });
  });
});

// ============================================================================
// #537 — Retry button for download_failed events
// ============================================================================

describe('#537 retry button on download_failed events', () => {
  it('shows Retry button for download_failed event with downloadId AND bookId', () => {
    const onRetry = vi.fn();
    renderWithProviders(<EventHistoryCard event={createMockEvent({ eventType: 'download_failed', downloadId: 5, bookId: 2 })} onRetry={onRetry} />);
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('hides Retry button for download_failed event with null bookId', () => {
    const onRetry = vi.fn();
    renderWithProviders(<EventHistoryCard event={createMockEvent({ eventType: 'download_failed', downloadId: 5, bookId: null })} onRetry={onRetry} />);
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('hides Retry button for download_failed event with null downloadId', () => {
    const onRetry = vi.fn();
    renderWithProviders(<EventHistoryCard event={createMockEvent({ eventType: 'download_failed', downloadId: null, bookId: 2 })} onRetry={onRetry} />);
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('hides Retry button for non-download_failed event types (import_failed, grabbed)', () => {
    const onRetry = vi.fn();
    renderWithProviders(<EventHistoryCard event={createMockEvent({ eventType: 'import_failed', downloadId: 5, bookId: 2 })} onRetry={onRetry} />);
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();

    const { unmount } = renderWithProviders(<EventHistoryCard event={createMockEvent({ eventType: 'grabbed', downloadId: 5, bookId: 2 })} onRetry={onRetry} />);
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    unmount();
  });

  it('calls onRetry with downloadId when Retry clicked', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    renderWithProviders(<EventHistoryCard event={createMockEvent({ eventType: 'download_failed', downloadId: 5, bookId: 2 })} onRetry={onRetry} />);

    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledWith(5);
  });

  it('disables Retry button when isRetrying is true', () => {
    const onRetry = vi.fn();
    renderWithProviders(<EventHistoryCard event={createMockEvent({ eventType: 'download_failed', downloadId: 5, bookId: 2 })} onRetry={onRetry} isRetrying />);
    expect(screen.getByRole('button', { name: /retry/i })).toBeDisabled();
  });
});
