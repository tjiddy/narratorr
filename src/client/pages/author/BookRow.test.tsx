import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BookRow } from './BookRow';
import { createMockBookMetadata } from '@/__tests__/factories';

vi.mock('@/lib/api', () => ({
  api: {
    getSettings: vi.fn().mockResolvedValue({
      quality: { grabFloor: 0, protocolPreference: 'none', minSeeders: 0, searchImmediately: false, monitorForUpgrades: false, rejectWords: '', requiredWords: '' },
    }),
  },
}));

function renderBookRow(props: Partial<Parameters<typeof BookRow>[0]> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const defaultProps = {
    book: createMockBookMetadata(),
    inLibrary: false,
    onAdd: vi.fn(),
    isAdding: false,
    ...props,
  };
  return render(
    <QueryClientProvider client={queryClient}>
      <BookRow {...defaultProps} />
    </QueryClientProvider>,
  );
}

describe('BookRow', () => {
  it('renders book title', () => {
    renderBookRow();
    expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
  });

  it('renders series position before title', () => {
    renderBookRow();
    expect(screen.getByText('#1')).toBeInTheDocument();
  });

  it('does not render series position when no series', () => {
    renderBookRow({ book: createMockBookMetadata({ series: [] }) });
    expect(screen.queryByText('#1')).not.toBeInTheDocument();
  });

  it('renders narrator names', () => {
    renderBookRow();
    expect(screen.getByText('Michael Kramer, Kate Reading')).toBeInTheDocument();
  });

  it('renders duration', () => {
    renderBookRow();
    expect(screen.getByText('45h')).toBeInTheDocument();
  });

  it('shows check icon when inLibrary', () => {
    renderBookRow({ inLibrary: true });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByLabelText('In library')).toBeInTheDocument();
  });

  it('shows Add popover button when not in library', () => {
    renderBookRow();
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('disables button when isAdding', () => {
    renderBookRow({ isAdding: true });
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('opens popover and calls onAdd with overrides when Add to Library is clicked', async () => {
    const handleAdd = vi.fn();
    const user = userEvent.setup();
    renderBookRow({ onAdd: handleAdd });

    // Click to open popover
    await user.click(screen.getByRole('button'));

    // Click Add to Library
    const addButton = await screen.findByRole('button', { name: /add to library/i });
    await user.click(addButton);

    expect(handleAdd).toHaveBeenCalledWith({
      searchImmediately: false,
      monitorForUpgrades: false,
    });
  });

  it('renders cover image when available', () => {
    renderBookRow();
    expect(screen.getByAltText('Cover of The Way of Kings')).toBeInTheDocument();
  });

  it('renders fallback when no cover', () => {
    renderBookRow({ book: createMockBookMetadata({ coverUrl: undefined }) });
    expect(screen.queryByAltText('Cover of The Way of Kings')).not.toBeInTheDocument();
  });
});
