import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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

    const mediaCrumb = screen.getByRole('button', { name: 'media' });
    await user.click(mediaCrumb);

    await screen.findByText('music');
    expect(mockBrowse).toHaveBeenCalledWith('/media', 'legacy');
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

  it('does not close on backdrop click (backdrop-click dismissal removed)', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    renderModal({ onClose });
    await screen.findByText('audiobooks');

    const backdrop = screen.getByTestId('modal-backdrop');
    await user.click(backdrop);

    expect(onClose).not.toHaveBeenCalled();
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

  it('does not call onClose when backdrop is clicked (backdrop-click dismissal removed)', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderModal({ onClose });
    await screen.findByRole('dialog');
    await user.click(screen.getByTestId('modal-backdrop'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not call onClose when Escape is pressed while closed', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal({ isOpen: false, onClose });
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });

  describe('ARIA attributes (#484)', () => {
    it('renders tabIndex={-1} on the dialog element', async () => {
      renderModal();
      const dialog = await screen.findByRole('dialog');
      expect(dialog).toHaveAttribute('tabIndex', '-1');
    });

    it('renders aria-labelledby linked to the heading id instead of aria-label', async () => {
      renderModal();
      const dialog = await screen.findByRole('dialog');
      expect(dialog).toHaveAttribute('aria-labelledby', 'directory-browser-modal-title');
      expect(dialog).not.toHaveAttribute('aria-label');
      const heading = document.getElementById('directory-browser-modal-title');
      expect(heading).toBeInTheDocument();
      expect(heading!.tagName).toBe('H2');
    });
  });
});
describe('height-capped card layout', () => {
  it('constrains the dialog wrapper and lets the listing scroll within the card', async () => {
    renderModal();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveClass('flex', 'flex-col', 'min-h-0', 'flex-1');
    const scrollBody = dialog.querySelector('.overflow-y-auto');
    expect(scrollBody).not.toBeNull();
    expect(scrollBody).toHaveClass('flex-1');
  });
});

/**
 * #2435 AC20 — opt-in file selection, and the query identity that keeps the two response shapes
 * from sharing a cache entry (spec-review F9).
 */
describe('DirectoryBrowserModal — selectableFiles (#2435)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBrowse.mockResolvedValue({ dirs: ['Disc 1'], parent: '/', files: ['book.m4b', 'part2.mp3'] });
  });

  it('requests the legacy capability and lists no files when the prop is omitted', async () => {
    mockBrowse.mockResolvedValue({ dirs: ['Disc 1'], parent: '/' });
    renderWithProviders(<DirectoryBrowserModal {...defaultProps} />);

    await screen.findByText('Disc 1');
    expect(mockBrowse).toHaveBeenCalledWith('/media', 'legacy');
  });

  it('requests the audio capability and lists the returned files', async () => {
    renderWithProviders(<DirectoryBrowserModal {...defaultProps} selectableFiles />);

    expect(await screen.findByText('book.m4b')).toBeInTheDocument();
    expect(screen.getByText('part2.mp3')).toBeInTheDocument();
    expect(mockBrowse).toHaveBeenCalledWith('/media', 'audio');
  });

  // The interaction the action's premise rests on: a directory-only picker cannot express this.
  it('submits the selected FILE path, not the containing directory', async () => {
    const onSelect = vi.fn();
    renderWithProviders(<DirectoryBrowserModal {...defaultProps} selectableFiles onSelect={onSelect} />);

    await userEvent.click(await screen.findByText('book.m4b'));
    await userEvent.click(screen.getByRole('button', { name: 'Select' }));

    expect(onSelect).toHaveBeenCalledWith('/media/book.m4b');
  });

  it('submits the directory when no file is chosen', async () => {
    const onSelect = vi.fn();
    renderWithProviders(<DirectoryBrowserModal {...defaultProps} selectableFiles onSelect={onSelect} />);

    await screen.findByText('book.m4b');
    await userEvent.click(screen.getByRole('button', { name: 'Select' }));

    expect(onSelect).toHaveBeenCalledWith('/media');
  });

  it('clears a pending file selection when the user navigates into a directory', async () => {
    const onSelect = vi.fn();
    renderWithProviders(<DirectoryBrowserModal {...defaultProps} selectableFiles onSelect={onSelect} />);

    await userEvent.click(await screen.findByText('book.m4b'));
    await userEvent.click(screen.getByText('Disc 1'));
    await userEvent.click(screen.getByRole('button', { name: 'Select' }));

    expect(onSelect).toHaveBeenCalledWith('/media/Disc 1');
  });

  /**
   * F9: the production QueryClient treats results as fresh for a minute. Keyed on path alone, the
   * picker that opened SECOND would render the first one's shape without calling its query fn.
   * Driven in both orders against one shared client, because only one order reproduces the bug.
   */
  it.each([
    ['legacy first', ['legacy', 'audio']],
    ['audio first', ['audio', 'legacy']],
  ] as const)('keeps the two capabilities on separate cache entries — %s', async (_label, order) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
    mockBrowse.mockImplementation((_path: string, capability: string) =>
      Promise.resolve(capability === 'audio'
        ? { dirs: ['Disc 1'], parent: '/', files: ['book.m4b'] }
        : { dirs: ['Disc 1'], parent: '/' }));

    for (const capability of order) {
      const view = render(
        <QueryClientProvider client={client}>
          <DirectoryBrowserModal {...defaultProps} selectableFiles={capability === 'audio'} />
        </QueryClientProvider>,
      );
      await screen.findByText('Disc 1');
      if (capability === 'audio') {
        // The whole point: the audio picker must receive `files` regardless of who cached first.
        expect(await screen.findByText('book.m4b')).toBeInTheDocument();
      } else {
        await waitFor(() => expect(screen.queryByText('book.m4b')).not.toBeInTheDocument());
      }
      view.unmount();
    }

    expect(mockBrowse.mock.calls.map((c) => c[1])).toEqual([...order]);
  });
});

/**
 * #2478 AC16–AC18 — the opt-in gate. Without the prop the modal keeps today's
 * "submits the directory when no file is chosen" contract, which the suite above already pins;
 * under it, the confirm button stays disabled until the user says which thing they mean.
 */
describe('DirectoryBrowserModal — requireExplicitSelection (#2478)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBrowse.mockResolvedValue({ dirs: ['Disc 1'], parent: '/', files: ['book.m4b'] });
  });

  function renderGated(overrides?: Partial<typeof defaultProps>) {
    return renderWithProviders(
      <DirectoryBrowserModal {...defaultProps} {...overrides} selectableFiles requireExplicitSelection />,
    );
  }

  const confirm = () => screen.getByRole('button', { name: 'Select' });
  const useFolder = () => screen.getByRole('button', { name: 'Use this folder' });

  it('keeps the confirm button disabled until something is explicitly chosen', async () => {
    const onSelect = vi.fn();
    renderGated({ onSelect });
    await screen.findByText('book.m4b');

    expect(confirm()).toBeDisabled();
    await userEvent.click(confirm());
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('enables on a file click and submits that file path', async () => {
    const onSelect = vi.fn();
    renderGated({ onSelect });

    await userEvent.click(await screen.findByText('book.m4b'));
    expect(confirm()).toBeEnabled();
    await userEvent.click(confirm());

    expect(onSelect).toHaveBeenCalledWith('/media/book.m4b');
  });

  it('enables on the folder affordance and submits the current directory', async () => {
    const onSelect = vi.fn();
    renderGated({ onSelect });
    await screen.findByText('book.m4b');

    await userEvent.click(useFolder());
    expect(confirm()).toBeEnabled();
    await userEvent.click(confirm());

    expect(onSelect).toHaveBeenCalledWith('/media');
  });

  /**
   * Enablement alone is not enough: a visually working toggle carrying no `aria-pressed` passes
   * the two tests above while failing the accessibility half of AC17.
   */
  describe('the folder affordance reports its pressed state', () => {
    it('reads false initially, true when chosen, and false again when toggled off', async () => {
      renderGated();
      await screen.findByText('book.m4b');

      expect(useFolder()).toHaveAttribute('aria-pressed', 'false');
      await userEvent.click(useFolder());
      expect(useFolder()).toHaveAttribute('aria-pressed', 'true');
      await userEvent.click(useFolder());
      expect(useFolder()).toHaveAttribute('aria-pressed', 'false');
      expect(confirm()).toBeDisabled();
    });

    it('reads false again after navigating into a directory', async () => {
      renderGated();
      await screen.findByText('book.m4b');
      await userEvent.click(useFolder());

      await userEvent.click(screen.getByText('Disc 1'));

      expect(useFolder()).toHaveAttribute('aria-pressed', 'false');
      expect(confirm()).toBeDisabled();
    });

    it('reads false again after a breadcrumb click', async () => {
      renderGated();
      await screen.findByText('book.m4b');
      await userEvent.click(useFolder());

      await userEvent.click(screen.getByRole('button', { name: '/' }));

      expect(useFolder()).toHaveAttribute('aria-pressed', 'false');
      expect(confirm()).toBeDisabled();
    });

    it('reads false again after a close and reopen', async () => {
      function Harness() {
        const [open, setOpen] = useState(false);
        return (
          <>
            <button type="button" onClick={() => setOpen(true)}>open browser</button>
            <DirectoryBrowserModal
              {...defaultProps}
              selectableFiles
              requireExplicitSelection
              isOpen={open}
              onClose={() => setOpen(false)}
            />
          </>
        );
      }
      renderWithProviders(<Harness />);

      await userEvent.click(screen.getByRole('button', { name: 'open browser' }));
      await screen.findByText('book.m4b');
      await userEvent.click(useFolder());
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      await userEvent.click(screen.getByRole('button', { name: 'open browser' }));
      await screen.findByText('book.m4b');

      expect(useFolder()).toHaveAttribute('aria-pressed', 'false');
      expect(confirm()).toBeDisabled();
    });
  });

  it('re-disables after a file selection when the user navigates into a directory', async () => {
    renderGated();

    await userEvent.click(await screen.findByText('book.m4b'));
    expect(confirm()).toBeEnabled();
    await userEvent.click(screen.getByText('Disc 1'));

    expect(confirm()).toBeDisabled();
  });

  it('re-disables after a file selection when the user clicks a breadcrumb', async () => {
    renderGated();

    await userEvent.click(await screen.findByText('book.m4b'));
    await userEvent.click(screen.getByRole('button', { name: '/' }));

    expect(confirm()).toBeDisabled();
  });

  // Today's file toggle: clicking the selected file again clears it.
  it('re-disables when the already-selected file is clicked a second time', async () => {
    renderGated();

    await userEvent.click(await screen.findByText('book.m4b'));
    await userEvent.click(screen.getByText('book.m4b'));

    expect(confirm()).toBeDisabled();
  });

  it('composes with selectDisabled — an explicit choice cannot re-enable a pending confirm', async () => {
    renderGated({ selectDisabled: true } as Partial<typeof defaultProps>);
    await screen.findByText('book.m4b');

    await userEvent.click(useFolder());

    expect(confirm()).toBeDisabled();
  });

  it('renders no folder affordance at all when the prop is omitted', async () => {
    renderWithProviders(<DirectoryBrowserModal {...defaultProps} selectableFiles />);
    await screen.findByText('book.m4b');

    expect(screen.queryByRole('button', { name: 'Use this folder' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select' })).toBeEnabled();
  });
});
