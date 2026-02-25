import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LibraryBookCard } from './LibraryBookCard';
import { createMockBook } from '@/__tests__/factories';

function defaultProps(overrides = {}) {
  return {
    book: createMockBook(),
    index: 0,
    isMenuOpen: false,
    onMenuToggle: vi.fn(),
    onMenuClose: vi.fn(),
    onClick: vi.fn(),
    onSearchReleases: vi.fn(),
    onRemove: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LibraryBookCard', () => {
  describe('display', () => {
    it('renders book title', () => {
      render(<LibraryBookCard {...defaultProps()} />);
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    it('renders author name', () => {
      render(<LibraryBookCard {...defaultProps()} />);
      expect(screen.getByText('Brandon Sanderson')).toBeInTheDocument();
    });

    it('has role="link" for accessibility', () => {
      render(<LibraryBookCard {...defaultProps()} />);
      expect(screen.getByRole('link')).toBeInTheDocument();
    });
  });

  describe('cover image', () => {
    it('renders cover image when coverUrl is present', () => {
      render(<LibraryBookCard {...defaultProps()} />);
      expect(screen.getByAltText('The Way of Kings')).toBeInTheDocument();
    });

    it('renders fallback icon when no coverUrl', () => {
      const book = createMockBook({ coverUrl: null });
      render(<LibraryBookCard {...defaultProps({ book })} />);
      expect(screen.queryByAltText('The Way of Kings')).not.toBeInTheDocument();
    });

    it('renders fallback icon when image fails to load', () => {
      render(<LibraryBookCard {...defaultProps()} />);
      const img = screen.getByAltText('The Way of Kings');
      fireEvent.error(img);

      expect(screen.queryByAltText('The Way of Kings')).not.toBeInTheDocument();
    });
  });

  describe('missing indicator', () => {
    it('renders frosted chip with broken-link icon for missing status', () => {
      const book = createMockBook({ status: 'missing' });
      render(<LibraryBookCard {...defaultProps({ book })} />);
      expect(screen.getByTitle('Files missing from disk')).toBeInTheDocument();
    });

    it('renders frosted chip with broken-link icon for failed status', () => {
      const book = createMockBook({ status: 'failed' });
      render(<LibraryBookCard {...defaultProps({ book })} />);
      expect(screen.getByTitle('Files missing from disk')).toBeInTheDocument();
    });

    it('does not render chip for imported status', () => {
      const book = createMockBook({ status: 'imported' });
      render(<LibraryBookCard {...defaultProps({ book })} />);
      expect(screen.queryByTitle('Files missing from disk')).not.toBeInTheDocument();
    });

    it('does not render chip for wanted status', () => {
      const book = createMockBook({ status: 'wanted' });
      render(<LibraryBookCard {...defaultProps({ book })} />);
      expect(screen.queryByTitle('Files missing from disk')).not.toBeInTheDocument();
    });

    it('does not render chip for downloading status', () => {
      const book = createMockBook({ status: 'downloading' });
      render(<LibraryBookCard {...defaultProps({ book })} />);
      expect(screen.queryByTitle('Files missing from disk')).not.toBeInTheDocument();
    });

    it('has tooltip text on the chip', () => {
      const book = createMockBook({ status: 'missing' });
      render(<LibraryBookCard {...defaultProps({ book })} />);
      const chip = screen.getByTitle('Files missing from disk');
      expect(chip).toBeInTheDocument();
    });
  });

  describe('status bar', () => {
    it('renders a status bar element', () => {
      render(<LibraryBookCard {...defaultProps()} />);
      expect(screen.getByTestId('status-bar')).toBeInTheDocument();
    });

    it('has correct color class for wanted status (stone)', () => {
      const book = createMockBook({ status: 'wanted' });
      render(<LibraryBookCard {...defaultProps({ book })} />);
      expect(screen.getByTestId('status-bar').className).toContain('bg-stone');
    });

    it('has correct color class for searching status (sky)', () => {
      const book = createMockBook({ status: 'searching' });
      render(<LibraryBookCard {...defaultProps({ book })} />);
      expect(screen.getByTestId('status-bar').className).toContain('bg-sky');
    });

    it('has correct color class for downloading status (violet)', () => {
      const book = createMockBook({ status: 'downloading' });
      render(<LibraryBookCard {...defaultProps({ book })} />);
      expect(screen.getByTestId('status-bar').className).toContain('bg-violet');
    });

    it('has correct color class for importing status (amber)', () => {
      const book = createMockBook({ status: 'importing' });
      render(<LibraryBookCard {...defaultProps({ book })} />);
      expect(screen.getByTestId('status-bar').className).toContain('bg-amber');
    });

    it('has correct color class for imported status (emerald)', () => {
      const book = createMockBook({ status: 'imported' });
      render(<LibraryBookCard {...defaultProps({ book })} />);
      expect(screen.getByTestId('status-bar').className).toContain('bg-emerald');
    });

    it('has correct color class for missing status (rose)', () => {
      const book = createMockBook({ status: 'missing' });
      render(<LibraryBookCard {...defaultProps({ book })} />);
      expect(screen.getByTestId('status-bar').className).toContain('bg-rose');
    });

    it('has correct color class for failed status (rose)', () => {
      const book = createMockBook({ status: 'failed' });
      render(<LibraryBookCard {...defaultProps({ book })} />);
      expect(screen.getByTestId('status-bar').className).toContain('bg-rose');
    });

    it('has shimmer class for searching status', () => {
      const book = createMockBook({ status: 'searching' });
      render(<LibraryBookCard {...defaultProps({ book })} />);
      expect(screen.getByTestId('status-bar').className).toContain('status-bar-shimmer');
    });

    it('has shimmer class for downloading status', () => {
      const book = createMockBook({ status: 'downloading' });
      render(<LibraryBookCard {...defaultProps({ book })} />);
      expect(screen.getByTestId('status-bar').className).toContain('status-bar-shimmer');
    });

    it('has shimmer class for importing status', () => {
      const book = createMockBook({ status: 'importing' });
      render(<LibraryBookCard {...defaultProps({ book })} />);
      expect(screen.getByTestId('status-bar').className).toContain('status-bar-shimmer');
    });

    it('does NOT have shimmer class for wanted status', () => {
      const book = createMockBook({ status: 'wanted' });
      render(<LibraryBookCard {...defaultProps({ book })} />);
      expect(screen.getByTestId('status-bar').className).not.toContain('status-bar-shimmer');
    });

    it('does NOT have shimmer class for imported status', () => {
      const book = createMockBook({ status: 'imported' });
      render(<LibraryBookCard {...defaultProps({ book })} />);
      expect(screen.getByTestId('status-bar').className).not.toContain('status-bar-shimmer');
    });

    it('does NOT have shimmer class for failed status', () => {
      const book = createMockBook({ status: 'failed' });
      render(<LibraryBookCard {...defaultProps({ book })} />);
      expect(screen.getByTestId('status-bar').className).not.toContain('status-bar-shimmer');
    });

    it('falls back to wanted style for unknown status', () => {
      const book = createMockBook({ status: 'bogus_status' as string });
      render(<LibraryBookCard {...defaultProps({ book })} />);
      expect(screen.getByTestId('status-bar').className).toContain('bg-stone');
    });
  });

  describe('no left-border accent', () => {
    it('does not apply left-border accent class for any status', () => {
      const statuses = ['wanted', 'downloading', 'imported', 'missing', 'failed', 'searching', 'importing'];
      for (const status of statuses) {
        const book = createMockBook({ status });
        const { container, unmount } = render(<LibraryBookCard {...defaultProps({ book })} />);
        const card = container.firstElementChild as HTMLElement;
        expect(card.className).not.toContain('border-l-');
        unmount();
      }
    });
  });

  describe('interactions', () => {
    it('calls onClick when card is clicked', async () => {
      const user = userEvent.setup();
      const props = defaultProps();
      render(<LibraryBookCard {...props} />);

      await user.click(screen.getByRole('link'));
      expect(props.onClick).toHaveBeenCalledTimes(1);
    });

    it('calls onClick when Enter key is pressed', async () => {
      const user = userEvent.setup();
      const props = defaultProps();
      render(<LibraryBookCard {...props} />);

      screen.getByRole('link').focus();
      await user.keyboard('{Enter}');
      expect(props.onClick).toHaveBeenCalledTimes(1);
    });

    it('renders options button with correct aria-label', () => {
      render(<LibraryBookCard {...defaultProps()} />);
      expect(screen.getByLabelText('Book options')).toBeInTheDocument();
    });
  });

  describe('context menu', () => {
    it('shows context menu when isMenuOpen is true', () => {
      render(<LibraryBookCard {...defaultProps({ isMenuOpen: true })} />);
      expect(screen.getByRole('menu')).toBeInTheDocument();
    });

    it('does not show context menu when isMenuOpen is false', () => {
      render(<LibraryBookCard {...defaultProps({ isMenuOpen: false })} />);
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('options button has aria-expanded matching isMenuOpen', () => {
      render(<LibraryBookCard {...defaultProps({ isMenuOpen: true })} />);
      expect(screen.getByLabelText('Book options')).toHaveAttribute('aria-expanded', 'true');
    });
  });

  describe('collapsed series badge', () => {
    it('renders +N more badge when collapsedCount is provided and > 0', () => {
      render(<LibraryBookCard {...defaultProps({ collapsedCount: 4 })} />);
      expect(screen.getByTestId('collapsed-badge')).toBeInTheDocument();
      expect(screen.getByText('+4 more')).toBeInTheDocument();
    });

    it('does not render badge when collapsedCount is 0', () => {
      render(<LibraryBookCard {...defaultProps({ collapsedCount: 0 })} />);
      expect(screen.queryByTestId('collapsed-badge')).not.toBeInTheDocument();
    });

    it('does not render badge when collapsedCount is undefined', () => {
      render(<LibraryBookCard {...defaultProps()} />);
      expect(screen.queryByTestId('collapsed-badge')).not.toBeInTheDocument();
    });
  });

  describe('series and narrator info', () => {
    it('renders narrator text when present', () => {
      render(<LibraryBookCard {...defaultProps()} />);
      expect(screen.getByText('Michael Kramer')).toBeInTheDocument();
    });

    it('renders series with position', () => {
      render(<LibraryBookCard {...defaultProps()} />);
      expect(screen.getByText('The Stormlight Archive #1')).toBeInTheDocument();
    });

    it('renders series without position when position is null', () => {
      const book = createMockBook({ seriesName: 'Cosmere', seriesPosition: null });
      render(<LibraryBookCard {...defaultProps({ book })} />);
      expect(screen.getByText('Cosmere')).toBeInTheDocument();
    });

    it('does not render narrator/series section when both are absent', () => {
      const book = createMockBook({ narrator: null, seriesName: null });
      render(<LibraryBookCard {...defaultProps({ book })} />);
      expect(screen.queryByText('Michael Kramer')).not.toBeInTheDocument();
    });
  });
});
