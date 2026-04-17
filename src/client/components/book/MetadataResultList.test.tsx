import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MetadataResultList } from './MetadataResultList';
import { createMockBookMetadata } from '@/__tests__/factories';

const defaultOnSelect = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MetadataResultList', () => {
  it('renders correct number of items up to limit prop', () => {
    const results = Array.from({ length: 4 }, (_, i) =>
      createMockBookMetadata({ asin: `ASIN${i}`, title: `Book ${i}` }),
    );
    render(<MetadataResultList results={results} limit={6} maxHeight="max-h-72" onSelect={defaultOnSelect} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(4);
  });

  it('slices results when count exceeds limit', () => {
    const results = Array.from({ length: 10 }, (_, i) =>
      createMockBookMetadata({ asin: `ASIN${i}`, title: `Book ${i}` }),
    );
    render(<MetadataResultList results={results} limit={6} maxHeight="max-h-72" onSelect={defaultOnSelect} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(6);
  });

  it('applies maxHeight class to scroll container', () => {
    const results = [createMockBookMetadata()];
    const { container } = render(
      <MetadataResultList results={results} limit={8} maxHeight="max-h-72" onSelect={defaultOnSelect} />,
    );
    const scrollContainer = container.querySelector('.max-h-72');
    expect(scrollContainer).toBeTruthy();
  });

  it('renders nothing when results array is empty', () => {
    const { container } = render(
      <MetadataResultList results={[]} limit={8} maxHeight="max-h-72" onSelect={defaultOnSelect} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('passes onSelect callback through to each item — click fires with correct metadata', async () => {
    const onSelect = vi.fn();
    const meta = createMockBookMetadata({ title: 'Clickable Book' });
    render(<MetadataResultList results={[meta]} limit={8} maxHeight="max-h-72" onSelect={onSelect} />);
    await userEvent.click(screen.getByText('Clickable Book'));
    expect(onSelect).toHaveBeenCalledWith(meta);
  });
});
