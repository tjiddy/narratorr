import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BookRow } from './BookRow';
import { createMockBookMetadata } from '@/__tests__/factories';

describe('BookRow', () => {
  const onAdd = vi.fn();

  it('renders book title', () => {
    render(<BookRow book={createMockBookMetadata()} inLibrary={false} onAdd={onAdd} isAdding={false} />);
    expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
  });

  it('renders series position before title', () => {
    render(<BookRow book={createMockBookMetadata()} inLibrary={false} onAdd={onAdd} isAdding={false} />);
    expect(screen.getByText('#1')).toBeInTheDocument();
  });

  it('does not render series position when no series', () => {
    render(<BookRow book={createMockBookMetadata({ series: [] })} inLibrary={false} onAdd={onAdd} isAdding={false} />);
    expect(screen.queryByText('#1')).not.toBeInTheDocument();
  });

  it('renders narrator names', () => {
    render(<BookRow book={createMockBookMetadata()} inLibrary={false} onAdd={onAdd} isAdding={false} />);
    expect(screen.getByText('Michael Kramer, Kate Reading')).toBeInTheDocument();
  });

  it('renders duration', () => {
    render(<BookRow book={createMockBookMetadata()} inLibrary={false} onAdd={onAdd} isAdding={false} />);
    expect(screen.getByText('45h')).toBeInTheDocument();
  });

  it('shows check icon when inLibrary', () => {
    const { container } = render(<BookRow book={createMockBookMetadata()} inLibrary={true} onAdd={onAdd} isAdding={false} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    // Check icon is rendered in a span, not a button
    expect(container.querySelector('.text-success')).toBeInTheDocument();
  });

  it('shows Add button when not in library', () => {
    render(<BookRow book={createMockBookMetadata()} inLibrary={false} onAdd={onAdd} isAdding={false} />);
    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('title', 'Add "The Way of Kings" to library');
  });

  it('disables button when isAdding', () => {
    render(<BookRow book={createMockBookMetadata()} inLibrary={false} onAdd={onAdd} isAdding={true} />);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('calls onAdd when button is clicked', async () => {
    const handleAdd = vi.fn();
    const user = userEvent.setup();
    render(<BookRow book={createMockBookMetadata()} inLibrary={false} onAdd={handleAdd} isAdding={false} />);

    await user.click(screen.getByRole('button'));
    expect(handleAdd).toHaveBeenCalledTimes(1);
  });

  it('renders cover image when available', () => {
    render(<BookRow book={createMockBookMetadata()} inLibrary={false} onAdd={onAdd} isAdding={false} />);
    expect(screen.getByAltText('Cover of The Way of Kings')).toBeInTheDocument();
  });

  it('renders fallback when no cover', () => {
    render(<BookRow book={createMockBookMetadata({ coverUrl: undefined })} inLibrary={false} onAdd={onAdd} isAdding={false} />);
    expect(screen.queryByAltText('Cover of The Way of Kings')).not.toBeInTheDocument();
  });
});
