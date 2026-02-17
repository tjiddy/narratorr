import { describe, it, expect } from 'vitest';
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
});
