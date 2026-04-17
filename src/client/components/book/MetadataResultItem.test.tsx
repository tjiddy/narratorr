import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MetadataResultItem } from './MetadataResultItem';
import { createMockBookMetadata } from '@/__tests__/factories';

const defaultOnSelect = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

function renderItem(props: Partial<React.ComponentProps<typeof MetadataResultItem>> = {}) {
  const meta = props.meta ?? createMockBookMetadata();
  return render(
    <MetadataResultItem
      meta={meta}
      onSelect={defaultOnSelect}
      {...props}
    />,
  );
}

describe('MetadataResultItem', () => {
  describe('shared rows (always present)', () => {
    it('renders cover image when coverUrl is provided', () => {
      const { container } = renderItem({ meta: createMockBookMetadata({ coverUrl: 'https://example.com/cover.jpg' }) });
      const img = container.querySelector('img');
      expect(img).toBeTruthy();
      expect(img!.getAttribute('src')).toContain('cover.jpg');
    });

    it('renders placeholder icon when coverUrl is undefined', () => {
      renderItem({ meta: createMockBookMetadata({ coverUrl: undefined }) });
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
    });

    it('renders custom placeholderIcon when provided and no cover', () => {
      renderItem({
        meta: createMockBookMetadata({ coverUrl: undefined }),
        placeholderIcon: <span data-testid="custom-placeholder">icon</span>,
      });
      expect(screen.getByTestId('custom-placeholder')).toBeInTheDocument();
    });

    it('renders title text', () => {
      renderItem({ meta: createMockBookMetadata({ title: 'My Audiobook' }) });
      expect(screen.getByText('My Audiobook')).toBeInTheDocument();
    });

    it('renders single author name', () => {
      renderItem({ meta: createMockBookMetadata({ authors: [{ name: 'Jane Doe' }] }) });
      expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    });

    it('renders multiple authors comma-separated', () => {
      renderItem({
        meta: createMockBookMetadata({ authors: [{ name: 'Jane Doe' }, { name: 'John Smith' }] }),
      });
      expect(screen.getByText('Jane Doe, John Smith')).toBeInTheDocument();
    });
  });

  describe('conditional rows — narrators', () => {
    it('renders narrators when showNarrators is true (default) and narrators array is non-empty', () => {
      renderItem({ meta: createMockBookMetadata({ narrators: ['Michael Kramer'] }) });
      expect(screen.getByText('Michael Kramer')).toBeInTheDocument();
    });

    it('hides narrators when narrators array is empty', () => {
      renderItem({ meta: createMockBookMetadata({ narrators: [] }) });
      expect(screen.queryByText(/Michael Kramer/)).not.toBeInTheDocument();
    });

    it('hides narrators when narrators is undefined', () => {
      renderItem({ meta: createMockBookMetadata({ narrators: undefined }) });
      expect(screen.queryByText(/Kramer/)).not.toBeInTheDocument();
    });

    it('hides narrators when showNarrators is false even if data exists', () => {
      renderItem({
        meta: createMockBookMetadata({ narrators: ['Michael Kramer'] }),
        showNarrators: false,
      });
      expect(screen.queryByText('Michael Kramer')).not.toBeInTheDocument();
    });
  });

  describe('conditional rows — series', () => {
    it('renders series with position when showSeries is true', () => {
      renderItem({
        meta: createMockBookMetadata({ series: [{ name: 'Stormlight Archive', position: 1 }] }),
        showSeries: true,
      });
      expect(screen.getByText('Stormlight Archive #1')).toBeInTheDocument();
    });

    it('renders series name only when position is undefined', () => {
      renderItem({
        meta: createMockBookMetadata({ series: [{ name: 'Stormlight Archive' }] }),
        showSeries: true,
      });
      expect(screen.getByText('Stormlight Archive')).toBeInTheDocument();
    });

    it('renders series with position 0 correctly', () => {
      renderItem({
        meta: createMockBookMetadata({ series: [{ name: 'Prelude', position: 0 }] }),
        showSeries: true,
      });
      expect(screen.getByText('Prelude #0')).toBeInTheDocument();
    });

    it('hides series when showSeries is false (default)', () => {
      renderItem({
        meta: createMockBookMetadata({ series: [{ name: 'Stormlight Archive', position: 1 }] }),
      });
      expect(screen.queryByText(/Stormlight Archive/)).not.toBeInTheDocument();
    });

    it('hides series when series array is empty', () => {
      renderItem({
        meta: createMockBookMetadata({ series: [] }),
        showSeries: true,
      });
      expect(screen.queryByText(/Stormlight/)).not.toBeInTheDocument();
    });
  });

  describe('conditional rows — duration', () => {
    it('renders duration when showDuration is true and duration > 0', () => {
      renderItem({
        meta: createMockBookMetadata({ duration: 692 }),
        showDuration: true,
      });
      expect(screen.getByText('11h 32m')).toBeInTheDocument();
    });

    it('hides duration when showDuration is false (default)', () => {
      renderItem({
        meta: createMockBookMetadata({ duration: 692 }),
      });
      expect(screen.queryByText('11h 32m')).not.toBeInTheDocument();
    });

    it('hides duration when duration is undefined', () => {
      renderItem({
        meta: createMockBookMetadata({ duration: undefined }),
        showDuration: true,
      });
      expect(screen.queryByText(/\d+h \d+m/)).not.toBeInTheDocument();
    });

    it('hides duration when duration is zero', () => {
      renderItem({
        meta: createMockBookMetadata({ duration: 0 }),
        showDuration: true,
      });
      expect(screen.queryByText(/\d+h \d+m/)).not.toBeInTheDocument();
    });

    it('hides duration when duration is negative', () => {
      renderItem({
        meta: createMockBookMetadata({ duration: -10 }),
        showDuration: true,
      });
      expect(screen.queryByText(/\d+h \d+m/)).not.toBeInTheDocument();
    });

    it('formats duration as minutes — 692 becomes 11h 32m', () => {
      renderItem({
        meta: createMockBookMetadata({ duration: 692 }),
        showDuration: true,
      });
      expect(screen.getByText('11h 32m')).toBeInTheDocument();
    });
  });

  describe('conditional rows — library badge', () => {
    it('renders library badge when showLibraryBadge is true and book matches library', () => {
      renderItem({
        meta: createMockBookMetadata({ asin: 'B003P2WO5E' }),
        showLibraryBadge: true,
        libraryBooks: [{ asin: 'B003P2WO5E', title: 'The Way of Kings', authorName: 'Brandon Sanderson', authorSlug: 'brandon-sanderson' }],
      });
      // CheckCircleIcon is the badge indicator — it renders as an SVG
      const buttons = screen.getAllByRole('button');
      // The badge should be inside the button
      expect(buttons[0].querySelector('svg:last-child')).toBeTruthy();
    });

    it('hides library badge when showLibraryBadge is false (default)', () => {
      renderItem({
        meta: createMockBookMetadata({ asin: 'B003P2WO5E' }),
        libraryBooks: [{ asin: 'B003P2WO5E', title: 'The Way of Kings', authorName: 'Brandon Sanderson', authorSlug: 'brandon-sanderson' }],
      });
      // Only the cover placeholder and metadata text — no trailing CheckCircle icon
      const button = screen.getByRole('button');
      const svgs = button.querySelectorAll(':scope > svg');
      expect(svgs).toHaveLength(0);
    });

    it('hides library badge when book does not match library', () => {
      renderItem({
        meta: createMockBookMetadata({ asin: 'B003P2WO5E' }),
        showLibraryBadge: true,
        libraryBooks: [{ asin: 'DIFFERENT', title: 'Other Book', authorName: 'Other Author', authorSlug: 'other-author' }],
      });
      const button = screen.getByRole('button');
      const svgs = button.querySelectorAll(':scope > svg');
      expect(svgs).toHaveLength(0);
    });
  });

  describe('interaction', () => {
    it('calls onSelect with full BookMetadata on click', async () => {
      const onSelect = vi.fn();
      const meta = createMockBookMetadata({ title: 'Click Target' });
      render(<MetadataResultItem meta={meta} onSelect={onSelect} />);
      await userEvent.click(screen.getByRole('button'));
      expect(onSelect).toHaveBeenCalledWith(meta);
    });

    it('button has type="button"', () => {
      renderItem();
      expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
    });
  });

  describe('boundary — minimal card', () => {
    it('renders only cover + title + authors when all optional rows disabled', () => {
      renderItem({
        meta: createMockBookMetadata({
          narrators: ['Should Not Show'],
          series: [{ name: 'Should Not Show', position: 1 }],
          duration: 600,
        }),
        showNarrators: false,
        showSeries: false,
        showDuration: false,
        showLibraryBadge: false,
      });
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      expect(screen.getByText('Brandon Sanderson')).toBeInTheDocument();
      expect(screen.queryByText('Should Not Show')).not.toBeInTheDocument();
      expect(screen.queryByText(/\d+h \d+m/)).not.toBeInTheDocument();
    });
  });
});
