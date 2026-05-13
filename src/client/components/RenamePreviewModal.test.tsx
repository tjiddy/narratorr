import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { renderWithProviders } from '@/__tests__/helpers';
import { RenamePreviewModal } from './RenamePreviewModal';
import { api, RenameConflictError, type RenamePreviewResult } from '@/lib/api';

vi.mock('@/lib/api', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- vi.mock requires dynamic import
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getBookRenamePreview: vi.fn(),
    },
  };
});

const fullPlan: RenamePreviewResult = {
  libraryRoot: '/library',
  folderFormat: '{author}/{title}',
  fileFormat: '{author} - {title}',
  folderMove: { from: 'Wrong/Old', to: 'Brandon Sanderson/The Way of Kings' },
  fileRenames: [
    { from: 'a.m4b', to: 'Brandon Sanderson - The Way of Kings.m4b' },
    { from: 'b.m4b', to: 'Brandon Sanderson - The Way of Kings (2).m4b' },
  ],
};

const emptyPlan: RenamePreviewResult = {
  libraryRoot: '/library',
  folderFormat: '{author}/{title}',
  fileFormat: '{author} - {title}',
  folderMove: null,
  fileRenames: [],
};

function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderModal(props: Partial<React.ComponentProps<typeof RenamePreviewModal>> = {}) {
  const onClose = vi.fn();
  const onConfirm = vi.fn();
  const queryClient = freshClient();
  const result = renderWithProviders(
    <RenamePreviewModal
      bookId={42}
      isOpen
      onClose={onClose}
      onConfirm={onConfirm}
      {...props}
    />,
    { queryClient },
  );
  return { ...result, onClose, onConfirm, queryClient };
}

describe('RenamePreviewModal', () => {
  beforeEach(() => {
    vi.mocked(api.getBookRenamePreview).mockReset();
  });

  it('renders the header banner with libraryRoot, folderFormat, and fileFormat', async () => {
    vi.mocked(api.getBookRenamePreview).mockResolvedValue(fullPlan);
    renderModal();

    expect(await screen.findByText('/library')).toBeInTheDocument();
    expect(screen.getByText('{author}/{title}')).toBeInTheDocument();
    expect(screen.getByText('{author} - {title}')).toBeInTheDocument();
  });

  it('renders folder move section only when folderMove is non-null', async () => {
    vi.mocked(api.getBookRenamePreview).mockResolvedValue(fullPlan);
    renderModal();

    expect(await screen.findByText('Wrong/Old')).toBeInTheDocument();
    expect(screen.getByText('Brandon Sanderson/The Way of Kings')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Folder' })).toBeInTheDocument();
  });

  it('omits folder move section when folderMove is null', async () => {
    vi.mocked(api.getBookRenamePreview).mockResolvedValue({
      ...fullPlan,
      folderMove: null,
    });
    renderModal();

    await screen.findByText('a.m4b');
    expect(screen.queryByRole('heading', { name: 'Folder' })).not.toBeInTheDocument();
  });

  it('renders one row per file rename with bare filenames', async () => {
    vi.mocked(api.getBookRenamePreview).mockResolvedValue(fullPlan);
    renderModal();

    expect(await screen.findByText('a.m4b')).toBeInTheDocument();
    expect(screen.getByText('Brandon Sanderson - The Way of Kings.m4b')).toBeInTheDocument();
    expect(screen.getByText('b.m4b')).toBeInTheDocument();
  });

  it('omits files section when fileRenames is empty but folder moves', async () => {
    vi.mocked(api.getBookRenamePreview).mockResolvedValue({
      ...fullPlan,
      fileRenames: [],
    });
    renderModal();

    await screen.findByText('Wrong/Old');
    expect(screen.queryByRole('heading', { name: 'Files' })).not.toBeInTheDocument();
  });

  it('shows empty state with no Rename button when plan is fully empty', async () => {
    vi.mocked(api.getBookRenamePreview).mockResolvedValue(emptyPlan);
    renderModal();

    expect(
      await screen.findByText('Files already match your template — nothing to rename.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('shows conflict alert + link to conflicting book on RenameConflictError', async () => {
    vi.mocked(api.getBookRenamePreview).mockRejectedValue(
      new RenameConflictError('Target path belongs to another book', { id: 99, title: 'Conflicting Book' }),
    );
    renderModal();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Conflicting Book' });
    expect(link).toHaveAttribute('href', '/books/99');
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
  });

  it('renders a generic error alert and hides Rename on non-conflict preview failures', async () => {
    vi.mocked(api.getBookRenamePreview).mockRejectedValue(new Error('Server exploded'));
    renderModal();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Server exploded');
    // Conflict-specific link should NOT render for a generic error
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('calls onClose when cancel is clicked', async () => {
    vi.mocked(api.getBookRenamePreview).mockResolvedValue(fullPlan);
    const { onClose } = renderModal();
    const user = userEvent.setup();

    await screen.findByText('a.m4b');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalled();
  });

  it('calls onConfirm when Rename is clicked', async () => {
    vi.mocked(api.getBookRenamePreview).mockResolvedValue(fullPlan);
    const { onConfirm, onClose } = renderModal();
    const user = userEvent.setup();

    await screen.findByText('a.m4b');
    await user.click(screen.getByRole('button', { name: 'Rename' }));

    expect(onConfirm).toHaveBeenCalled();
    // Rename closes the modal in the same click
    expect(onClose).toHaveBeenCalled();
  });

  it('fires exactly one preview request when isOpen=true', async () => {
    vi.mocked(api.getBookRenamePreview).mockResolvedValue(fullPlan);
    renderModal();

    await screen.findByText('a.m4b');
    expect(api.getBookRenamePreview).toHaveBeenCalledTimes(1);
  });

  it('fires zero preview requests when isOpen=false', () => {
    vi.mocked(api.getBookRenamePreview).mockResolvedValue(fullPlan);
    renderModal({ isOpen: false });

    expect(api.getBookRenamePreview).not.toHaveBeenCalled();
  });

  it('refetches on unmount + remount (close + reopen)', async () => {
    vi.mocked(api.getBookRenamePreview).mockResolvedValue(fullPlan);
    const queryClient = freshClient();
    const { unmount } = renderWithProviders(
      <RenamePreviewModal bookId={42} isOpen onClose={() => {}} onConfirm={() => {}} />,
      { queryClient },
    );

    await screen.findByText('a.m4b');
    expect(api.getBookRenamePreview).toHaveBeenCalledTimes(1);

    unmount();

    renderWithProviders(
      <RenamePreviewModal bookId={42} isOpen onClose={() => {}} onConfirm={() => {}} />,
      { queryClient },
    );

    await waitFor(() => {
      expect(api.getBookRenamePreview).toHaveBeenCalledTimes(2);
    });
  });
});
