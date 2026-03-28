import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { DirectoryBrowserModal } from './DirectoryBrowserModal';

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual('@/lib/api');
  return {
    ...actual,
    api: {
      browseDirectory: vi.fn(),
    },
  };
});

import { api } from '@/lib/api';

const mockBrowse = api.browseDirectory as ReturnType<typeof vi.fn>;

const defaultProps = {
  isOpen: true,
  initialPath: '/media',
  onSelect: vi.fn(),
  onClose: vi.fn(),
};

function renderModal(overrides?: Partial<typeof defaultProps>) {
  return renderWithProviders(
    <DirectoryBrowserModal {...defaultProps} {...overrides} />,
  );
}

describe('DirectoryBrowserModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBrowse.mockResolvedValue({ dirs: ['audiobooks', 'music', 'podcasts'], parent: '/' });
  });

  it('renders modal when open', async () => {
    renderModal();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Browse Directories')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    renderModal({ isOpen: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('fetches and displays directory listing on open', async () => {
    renderModal();
    await screen.findByText('audiobooks');
    expect(screen.getByText('music')).toBeInTheDocument();
    expect(screen.getByText('podcasts')).toBeInTheDocument();
  });

  it('shows breadcrumb for current path', async () => {
    renderModal({ initialPath: '/media/audiobooks' });
    await screen.findByText('media');
    expect(screen.getByText('audiobooks')).toBeInTheDocument();
  });

  it('navigates to breadcrumb segment on click', async () => {
    const user = userEvent.setup();
    mockBrowse
      .mockResolvedValueOnce({ dirs: ['subfolder'], parent: '/media' })
      .mockResolvedValueOnce({ dirs: ['audiobooks', 'music'], parent: '/' });

    renderModal({ initialPath: '/media/audiobooks' });
    await screen.findByText('subfolder');

    // Click the "media" breadcrumb
    const mediaCrumb = screen.getByRole('button', { name: 'media' });
    await user.click(mediaCrumb);

    await screen.findByText('music');
    expect(mockBrowse).toHaveBeenCalledWith('/media');
  });

  it('navigates into directory on click', async () => {
    const user = userEvent.setup();
    mockBrowse
      .mockResolvedValueOnce({ dirs: ['audiobooks', 'music'], parent: '/' })
      .mockResolvedValueOnce({ dirs: ['author1', 'author2'], parent: '/media' });

    renderModal({ initialPath: '/media' });
    await screen.findByText('audiobooks');

    await user.click(screen.getByText('audiobooks'));

    await screen.findByText('author1');
    expect(screen.getByText('author2')).toBeInTheDocument();
  });

  it('calls onSelect with current path and closes on Select click', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    renderModal({ onSelect });
    await screen.findByText('audiobooks');

    await user.click(screen.getByRole('button', { name: 'Select' }));

    expect(onSelect).toHaveBeenCalledWith('/media');
  });

  it('closes without selecting on Cancel click', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSelect = vi.fn();

    renderModal({ onClose, onSelect });
    await screen.findByText('audiobooks');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('closes on Escape key', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    renderModal({ onClose });
    await screen.findByText('audiobooks');

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
  });

  it('closes on backdrop click', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    renderModal({ onClose });
    await screen.findByText('audiobooks');

    const backdrop = screen.getByTestId('modal-backdrop');
    await user.click(backdrop);

    expect(onClose).toHaveBeenCalled();
  });

  it('shows loading state while fetching', () => {
    mockBrowse.mockReturnValue(new Promise(() => {})); // never resolves
    renderModal();

    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
  });

  it('shows empty state when no subdirectories', async () => {
    mockBrowse.mockResolvedValue({ dirs: [], parent: '/' });
    renderModal();

    await screen.findByText('No subdirectories');
  });

  it('shows error state on fetch failure', async () => {
    mockBrowse.mockRejectedValue(new Error('ENOENT: no such file or directory'));
    renderModal();

    await screen.findByText('ENOENT: no such file or directory');
  });

  it('shows current path in footer', async () => {
    renderModal({ initialPath: '/media/audiobooks' });
    await waitFor(() => {
      expect(screen.getByTitle('/media/audiobooks')).toBeInTheDocument();
    });
  });

  describe('Windows path parsing', () => {
    it('parses Windows absolute path C:\\Users\\Author\\Book into correct breadcrumbs', async () => {
      renderModal({ initialPath: 'C:\\Users\\Author\\Book' });
      await screen.findByText('Users');
      expect(screen.getByText('Author')).toBeInTheDocument();
      expect(screen.getByText('Book')).toBeInTheDocument();
      expect(screen.getByText('C:/')).toBeInTheDocument();
    });

    it('normalizes mixed separators (C:\\Users/Author) correctly', async () => {
      renderModal({ initialPath: 'C:\\Users/Author' });
      await screen.findByText('Users');
      expect(screen.getByText('Author')).toBeInTheDocument();
      expect(screen.getByText('C:/')).toBeInTheDocument();
    });
  });

  it('calls onClose when backdrop is clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderModal({ onClose });
    await screen.findByRole('dialog');
    await user.click(screen.getByTestId('modal-backdrop'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
