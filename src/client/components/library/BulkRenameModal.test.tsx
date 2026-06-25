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
  folderMatching: 10,
  importedTotal: 12,
  jobTotal: 12,
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

  it('renders the imported-book denominator and folder-move count when a fileFormat rule is set', async () => {
    renderModal();
    expect(
      await screen.findByText(/Check 12 imported books\. 2 need folder moves\./i),
    ).toBeInTheDocument();
    expect(screen.getByText(/File-level renames are checked per book during the run\./i)).toBeInTheDocument();
  });

  it('renders the folder-format summary with skipped count when no fileFormat rule is set', async () => {
    vi.mocked(api.getBulkRenamePreview).mockResolvedValue({
      ...basePreview,
      fileFormat: '',
      importedTotal: 12,
      jobTotal: 2,
    });
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

  it('renders only the Files section in the expanded panel — no duplicate folder diff (F2)', async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(await screen.findByRole('button', { name: 'Book One' }));
    expect(await screen.findByRole('heading', { name: 'Files' })).toBeInTheDocument();
    expect(screen.getByText('a.m4b')).toBeInTheDocument();
    // bookPlan has a non-null folderMove, but the collapsed header already shows
    // the folder diff — the expanded panel must NOT repeat it as a "Folder" section.
    expect(screen.queryByRole('heading', { name: 'Folder' })).not.toBeInTheDocument();
  });

  it('renders the dialog at max-w-4xl, not max-w-2xl (F1)', async () => {
    renderModal();
    await screen.findByRole('button', { name: 'Book One' });
    expect(document.querySelector('.max-w-4xl')).toBeInTheDocument();
    expect(document.querySelector('.max-w-2xl')).not.toBeInTheDocument();
  });

  it('indents the expanded panel with a left rail and drops the full-width top border (F3)', async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(await screen.findByRole('button', { name: 'Book One' }));
    await screen.findByRole('heading', { name: 'Files' });
    const panel = document.querySelector('.border-l-2');
    expect(panel).toBeInTheDocument();
    expect(panel?.className).toContain('ml-6');
    expect(panel?.className).toContain('pl-4');
    expect(panel?.className).not.toContain('border-t');
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
    await screen.findByRole('heading', { name: 'Files' });
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

  // AC #4 (#1493): zero folder mismatches is only "nothing to rename" when no fileFormat
  // rule exists. With a file rule, file-level renames may still apply, so the run stays
  // available even when every folder already matches.
  describe('0-mismatch empty state', () => {
    it('fileFormat empty: shows "nothing to rename" with no list rows and no Rename All button', async () => {
      vi.mocked(api.getBulkRenamePreview).mockResolvedValue({
        libraryRoot: '/library',
        folderFormat: '{author}/{title}',
        fileFormat: '',
        items: [],
        mismatchedTotal: 0,
        folderMatching: 8,
        importedTotal: 8,
        jobTotal: 0,
      });
      renderModal();
      expect(
        await screen.findByText(/All 8 books already match the current folder format — nothing to rename\./i),
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^rename all$/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^cancel$/i })).toBeInTheDocument();
    });

    it('fileFormat empty: cannot confirm — onConfirm is never reachable', async () => {
      vi.mocked(api.getBulkRenamePreview).mockResolvedValue({
        libraryRoot: '/library',
        folderFormat: '{author}/{title}',
        fileFormat: '',
        items: [],
        mismatchedTotal: 0,
        folderMatching: 8,
        importedTotal: 8,
        jobTotal: 0,
      });
      const { onConfirm } = renderModal();
      await screen.findByText(/nothing to rename/i);
      expect(screen.queryByRole('button', { name: /^rename all$/i })).not.toBeInTheDocument();
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it('fileFormat set + importedTotal === 0: shows "No imported books to rename." with no Rename All button', async () => {
      vi.mocked(api.getBulkRenamePreview).mockResolvedValue({
        libraryRoot: '/library',
        folderFormat: '{author}/{title}',
        fileFormat: '{author} - {title}',
        items: [],
        mismatchedTotal: 0,
        folderMatching: 0,
        importedTotal: 0,
        jobTotal: 0,
      });
      renderModal();
      // hasFileRule === true branch of the empty-state copy (BulkRenameModal.tsx:176-178).
      expect(await screen.findByText(/^No imported books to rename\.$/i)).toBeInTheDocument();
      // The folder-format empty-state copy must NOT render under a file rule.
      expect(screen.queryByText(/nothing to rename/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^rename all$/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^cancel$/i })).toBeInTheDocument();
    });

    it('fileFormat set + importedTotal > 0: stays enabled with zero folder mismatches (no "nothing to rename")', async () => {
      vi.mocked(api.getBulkRenamePreview).mockResolvedValue({
        libraryRoot: '/library',
        folderFormat: '{author}/{title}',
        fileFormat: '{author} - {title}',
        items: [],
        mismatchedTotal: 0,
        folderMatching: 8,
        importedTotal: 8,
        jobTotal: 8,
      });
      renderModal();
      expect(
        await screen.findByText(/Check 8 imported books\. 0 need folder moves\./i),
      ).toBeInTheDocument();
      expect(screen.queryByText(/nothing to rename/i)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^rename all$/i })).toBeInTheDocument();
    });
  });
});
