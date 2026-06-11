import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { renderWithProviders } from '../../__tests__/helpers.js';
import { BulkRenameModal } from './BulkRenameModal.js';
import { api, RenameConflictError, type BulkRenamePreview, type RenamePreviewResult } from '@/lib/api';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getBulkRenamePreview: vi.fn(),
      getBookRenamePreview: vi.fn(),
    },
  };
});

const basePreview: BulkRenamePreview = {
  libraryRoot: '/library',
  folderFormat: '{author}/{title}',
  fileFormat: '{author} - {title}',
  items: [
    { bookId: 1, title: 'Book One', from: 'Author/Old One', to: 'Author/Book One' },
    { bookId: 2, title: 'Book Two', from: 'Author/Old Two', to: 'Author/Book Two' },
  ],
  mismatchedTotal: 2,
  alreadyMatching: 10,
};

const bookPlan: RenamePreviewResult = {
  libraryRoot: '/library',
  folderFormat: '{author}/{title}',
  fileFormat: '{author} - {title}',
  folderMove: { from: 'Author/Old One', to: 'Author/Book One' },
  fileRenames: [{ from: 'a.m4b', to: 'Author - Book One.m4b' }],
};

function renderModal(props: Partial<React.ComponentProps<typeof BulkRenameModal>> = {}) {
  const onClose = vi.fn();
  const onConfirm = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = renderWithProviders(
    <BulkRenameModal isOpen onClose={onClose} onConfirm={onConfirm} {...props} />,
    { queryClient },
  );
  return { ...result, onClose, onConfirm, queryClient };
}

describe('BulkRenameModal', () => {
  beforeEach(() => {
    vi.mocked(api.getBulkRenamePreview).mockReset();
    vi.mocked(api.getBookRenamePreview).mockReset();
    vi.mocked(api.getBulkRenamePreview).mockResolvedValue(basePreview);
    vi.mocked(api.getBookRenamePreview).mockResolvedValue(bookPlan);
  });

  it('renders the folder summary referencing "folder format" and the skipped count', async () => {
    renderModal();
    expect(await screen.findByText(/Rename 2 books to match the current folder format\./i)).toBeInTheDocument();
    expect(screen.getByText(/10 books already match and will be skipped\./i)).toBeInTheDocument();
  });

  it('fires the bulk-preview query but zero per-book preview calls until a row is expanded', async () => {
    renderModal();
    await screen.findByRole('button', { name: 'Book One' });
    expect(api.getBulkRenamePreview).toHaveBeenCalledTimes(1);
    expect(api.getBookRenamePreview).not.toHaveBeenCalled();
  });

  it('expanding a single row fires exactly one per-book preview call', async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(await screen.findByRole('button', { name: 'Book One' }));
    await waitFor(() => {
      expect(api.getBookRenamePreview).toHaveBeenCalledTimes(1);
    });
    expect(api.getBookRenamePreview).toHaveBeenCalledWith(1);
  });

  it('renders the folder + file diff via the shared sections when a row is expanded', async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(await screen.findByRole('button', { name: 'Book One' }));
    expect(await screen.findByRole('heading', { name: 'Folder' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Files' })).toBeInTheDocument();
    expect(screen.getByText('a.m4b')).toBeInTheDocument();
  });

  it('shows "No file changes" when the expanded book has no file renames', async () => {
    vi.mocked(api.getBookRenamePreview).mockResolvedValue({ ...bookPlan, fileRenames: [] });
    const user = userEvent.setup();
    renderModal();
    await user.click(await screen.findByRole('button', { name: 'Book One' }));
    expect(await screen.findByText('No file changes')).toBeInTheDocument();
  });

  it('shows a loading state while the per-book preview is pending', async () => {
    let resolvePlan!: (p: RenamePreviewResult) => void;
    vi.mocked(api.getBookRenamePreview).mockReturnValue(
      new Promise<RenamePreviewResult>((resolve) => { resolvePlan = resolve; }),
    );
    const user = userEvent.setup();
    renderModal();
    await user.click(await screen.findByRole('button', { name: 'Book One' }));
    expect(await screen.findByText(/loading preview/i)).toBeInTheDocument();
    resolvePlan(bookPlan);
    await screen.findByRole('heading', { name: 'Folder' });
  });

  it('renders the shared ConflictBanner inline when the per-book preview rejects with a conflict', async () => {
    vi.mocked(api.getBookRenamePreview).mockRejectedValue(
      new RenameConflictError('Target belongs to another book', { id: 99, title: 'Conflicting Book' }),
    );
    const user = userEvent.setup();
    renderModal();
    await user.click(await screen.findByRole('button', { name: 'Book One' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Conflicting Book' });
    expect(link).toHaveAttribute('href', '/books/99');
  });

  it('renders the "…and N more" affordance when mismatchedTotal exceeds the returned rows', async () => {
    vi.mocked(api.getBulkRenamePreview).mockResolvedValue({
      ...basePreview,
      mismatchedTotal: 952,
    });
    renderModal();
    expect(await screen.findByText(/…and 950 more/i)).toBeInTheDocument();
  });

  it('confirms via "Rename All", closing then calling onConfirm', async () => {
    const user = userEvent.setup();
    const { onConfirm, onClose } = renderModal();
    await screen.findByRole('button', { name: 'Book One' });
    await user.click(screen.getByRole('button', { name: /^rename all$/i }));
    expect(onConfirm).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('cancels without side effects', async () => {
    const user = userEvent.setup();
    const { onConfirm, onClose } = renderModal();
    await screen.findByRole('button', { name: 'Book One' });
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onClose).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('fires zero queries when isOpen is false', () => {
    renderModal({ isOpen: false });
    expect(api.getBulkRenamePreview).not.toHaveBeenCalled();
  });

  describe('0-mismatch empty state (AC #5)', () => {
    beforeEach(() => {
      vi.mocked(api.getBulkRenamePreview).mockResolvedValue({
        libraryRoot: '/library',
        folderFormat: '{author}/{title}',
        fileFormat: '{author} - {title}',
        items: [],
        mismatchedTotal: 0,
        alreadyMatching: 8,
      });
    });

    it('shows the "nothing to rename" summary with no list rows and no Rename All button', async () => {
      renderModal();
      expect(
        await screen.findByText(/All 8 books already match the current folder format — nothing to rename\./i),
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^rename all$/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^cancel$/i })).toBeInTheDocument();
    });

    it('cannot confirm — onConfirm is never reachable', async () => {
      const { onConfirm } = renderModal();
      await screen.findByText(/nothing to rename/i);
      expect(screen.queryByRole('button', { name: /^rename all$/i })).not.toBeInTheDocument();
      expect(onConfirm).not.toHaveBeenCalled();
    });
  });
});
