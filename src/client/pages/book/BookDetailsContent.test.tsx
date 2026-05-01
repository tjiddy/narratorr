import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { BookDetailsContent } from './BookDetailsContent';
import { createMockBook } from '@/__tests__/factories';
import type { BookWithAuthor } from '@/lib/api';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/hooks/useLibrary', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    useBookFiles: vi.fn().mockReturnValue({ data: [], isLoading: false, isError: false }),
  };
});

function makeBook(overrides: Partial<BookWithAuthor> = {}): BookWithAuthor {
  return createMockBook({ audioCodec: 'AAC', ...overrides });
}

describe('BookDetailsContent — Location section wiring', () => {
  it('renders the Location section when libraryBook.path is a non-empty string', () => {
    renderWithProviders(
      <BookDetailsContent
        libraryBook={makeBook({ status: 'imported', path: '/library/book/story.m4b' })}
        merged={{}}
      />,
    );

    expect(screen.getByRole('heading', { name: /^location$/i })).toBeInTheDocument();
    expect(screen.getByText('/library/book/story.m4b')).toBeInTheDocument();
  });

  it('does not render the Location section when libraryBook.path is null', () => {
    renderWithProviders(
      <BookDetailsContent
        libraryBook={makeBook({ status: 'wanted', path: null })}
        merged={{}}
      />,
    );

    expect(screen.queryByRole('heading', { name: /^location$/i })).not.toBeInTheDocument();
  });

  it('does not render the Location section when libraryBook.path is an empty string', () => {
    renderWithProviders(
      <BookDetailsContent
        libraryBook={makeBook({ status: 'imported', path: '' })}
        merged={{}}
      />,
    );

    expect(screen.queryByRole('heading', { name: /^location$/i })).not.toBeInTheDocument();
  });

  it('renders the Location section before the Files section in document order', () => {
    renderWithProviders(
      <BookDetailsContent
        libraryBook={makeBook({ status: 'imported', path: '/library/book/story.m4b' })}
        merged={{}}
      />,
    );

    const locationHeading = screen.getByRole('heading', { name: /^location$/i });
    const filesButton = screen.getByRole('button', { name: /^files \(/i });

    expect(
      locationHeading.compareDocumentPosition(filesButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
