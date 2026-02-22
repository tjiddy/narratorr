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

  describe('status border', () => {
    it('applies border class for wanted status', () => {
      const book = createMockBook({ status: 'wanted' });
      const { container } = render(<LibraryBookCard {...defaultProps({ book })} />);
      const card = container.firstElementChild as HTMLElement;
      expect(card.className).toContain('border-l-amber-500');
    });

    it('applies border class for downloading status', () => {
      const book = createMockBook({ status: 'downloading' });
      const { container } = render(<LibraryBookCard {...defaultProps({ book })} />);
      const card = container.firstElementChild as HTMLElement;
      expect(card.className).toContain('border-l-blue-500');
    });

    it('does not apply border class for imported status', () => {
      const book = createMockBook({ status: 'imported' });
      const { container } = render(<LibraryBookCard {...defaultProps({ book })} />);
      const card = container.firstElementChild as HTMLElement;
      expect(card.className).not.toContain('border-l-');
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
