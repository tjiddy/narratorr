import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { CoverImage } from '@/components/CoverImage';

describe('CoverImage', () => {
  it('renders img when src is provided', () => {
    renderWithProviders(
      <CoverImage src="https://example.com/cover.jpg" alt="Test Book" fallback={<span>No Cover</span>} />,
    );

    const img = screen.getByAltText('Test Book');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', 'https://example.com/cover.jpg');
  });

  it('shows fallback when src is null', () => {
    renderWithProviders(
      <CoverImage src={null} alt="Test Book" fallback={<span>No Cover</span>} />,
    );

    expect(screen.getByText('No Cover')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('shows fallback when src is undefined', () => {
    renderWithProviders(
      <CoverImage src={undefined} alt="Test Book" fallback={<span>No Cover</span>} />,
    );

    expect(screen.getByText('No Cover')).toBeInTheDocument();
  });

  it('shows fallback when src is empty string', () => {
    renderWithProviders(
      <CoverImage src="" alt="Test Book" fallback={<span>No Cover</span>} />,
    );

    expect(screen.getByText('No Cover')).toBeInTheDocument();
  });

  it('shows fallback on image load error', () => {
    renderWithProviders(
      <CoverImage src="https://example.com/broken.jpg" alt="Test Book" fallback={<span>No Cover</span>} />,
    );

    const img = screen.getByAltText('Test Book');
    fireEvent.error(img);

    expect(screen.getByText('No Cover')).toBeInTheDocument();
    expect(screen.queryByAltText('Test Book')).not.toBeInTheDocument();
  });

  it('applies className to container', () => {
    const { container } = renderWithProviders(
      <CoverImage src="https://example.com/cover.jpg" alt="Test" fallback={<span>FB</span>} className="w-20 h-20" />,
    );

    const wrapper = container.querySelector('.w-20.h-20');
    expect(wrapper).toBeInTheDocument();
  });

  describe('className isolation', () => {
    it('does not apply className to the inner ring overlay element', () => {
      const { container } = renderWithProviders(
        <CoverImage src="https://example.com/cover.jpg" alt="Test" fallback={<span>FB</span>} className="w-20 h-20" />,
      );

      // The ring overlay (absolute inset-0 ring-1) should NOT have w-20 or h-20
      const ringElement = container.querySelector('.ring-1.ring-inset');
      expect(ringElement).toBeInTheDocument();
      expect(ringElement).not.toHaveClass('w-20');
      expect(ringElement).not.toHaveClass('h-20');
    });

    it('applies className only to the outer wrapper div', () => {
      const { container } = renderWithProviders(
        <CoverImage src="https://example.com/cover.jpg" alt="Test" fallback={<span>FB</span>} className="w-20 h-20" />,
      );

      // The outer wrapper should have both className and its own classes
      const outerDiv = container.firstElementChild;
      expect(outerDiv).toHaveClass('w-20', 'h-20', 'relative', 'overflow-hidden');
    });
  });

  describe('URL_BASE resolveUrl integration', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('prefixes app-relative cover URLs with URL_BASE', async () => {
      // Mock resolveUrl to simulate URL_BASE = /narratorr
      vi.spyOn(await import('@/lib/url-utils'), 'resolveUrl').mockImplementation(
        (url) => {
          if (!url) return undefined;
          if (url.startsWith('http://') || url.startsWith('https://')) return url;
          return `/narratorr${url}`;
        },
      );

      // Re-import component to pick up mocked resolveUrl
      const { CoverImage: PrefixedCoverImage } = await import('@/components/CoverImage');

      renderWithProviders(
        <PrefixedCoverImage src="/api/books/1/cover" alt="Prefixed Cover" fallback={<span>No Cover</span>} />,
      );

      const img = screen.getByAltText('Prefixed Cover');
      expect(img).toHaveAttribute('src', '/narratorr/api/books/1/cover');
    });

    it('leaves absolute cover URLs unchanged', () => {
      renderWithProviders(
        <CoverImage src="https://cdn.example.com/cover.jpg" alt="Absolute Cover" fallback={<span>No Cover</span>} />,
      );

      const img = screen.getByAltText('Absolute Cover');
      expect(img).toHaveAttribute('src', 'https://cdn.example.com/cover.jpg');
    });
  });
});
