import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { LibraryActionsMenu, type LibraryActionsMenuProps } from './LibraryActionsMenu';
import { useBulkOperation } from '@/hooks/useBulkOperation';
import type { BulkOpType, BulkJobFailure } from '@/lib/api';
import { api } from '@/lib/api';
import { toast } from 'sonner';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/hooks/useBulkOperation', () => ({
  useBulkOperation: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      getBulkRetagCount: vi.fn(),
      getBulkRenamePreview: vi.fn(),
      getBookRenamePreview: vi.fn(),
    },
  };
});

const mockStartJob = vi.fn();

interface BulkOverrides {
  isRunning?: boolean;
  jobType?: BulkOpType | null;
  completed?: number;
  total?: number;
  failures?: number;
  failureDetails?: BulkJobFailure[];
}

function mockBulk(overrides: BulkOverrides = {}) {
  vi.mocked(useBulkOperation).mockReturnValue({
    isRunning: overrides.isRunning ?? false,
    jobType: overrides.jobType ?? null,
    progress: {
      completed: overrides.completed ?? 0,
      total: overrides.total ?? 0,
      failures: overrides.failures ?? 0,
      failureDetails: overrides.failureDetails ?? [],
    },
    startJob: mockStartJob,
  });
}

function defaultProps(overrides: Partial<LibraryActionsMenuProps> = {}): LibraryActionsMenuProps {
  return {
    missingCount: 0,
    onRemoveMissing: vi.fn(),
    onSearchAllWanted: vi.fn(),
    isSearchingAllWanted: false,
    onRescan: vi.fn(),
    isRescanning: false,
    writeOpf: false,
    ...overrides,
  };
}

function renderMenu(props: Partial<LibraryActionsMenuProps> = {}, bulk: BulkOverrides = {}): LibraryActionsMenuProps {
  mockBulk(bulk);
  const merged = defaultProps(props);
  renderWithProviders(<LibraryActionsMenu {...merged} />);
  return merged;
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /library actions/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStartJob.mockResolvedValue(undefined);
  mockBulk();
  (api.getBulkRetagCount as ReturnType<typeof vi.fn>).mockResolvedValue({ total: 15 });
  (api.getBulkRenamePreview as ReturnType<typeof vi.fn>).mockResolvedValue({
    libraryRoot: '/library',
    folderFormat: '{author}/{title}',
    fileFormat: '{author} - {title}',
    items: [{ bookId: 1, title: 'Book One', from: 'Author/Old One', to: 'Author/Book One' }],
    mismatchedTotal: 5,
    folderMatching: 10,
    importedTotal: 15,
    jobTotal: 15,
  });
  (api.getBookRenamePreview as ReturnType<typeof vi.fn>).mockResolvedValue({
    libraryRoot: '/library',
    folderFormat: '{author}/{title}',
    fileFormat: '{author} - {title}',
    folderMove: { from: 'Author/Old One', to: 'Author/Book One' },
    fileRenames: [],
  });
});

describe('LibraryActionsMenu', () => {
  describe('trigger', () => {
    it('renders a labeled "Library Actions" trigger', () => {
      renderMenu();
      expect(screen.getByRole('button', { name: /library actions/i })).toHaveTextContent('Library Actions');
    });

    it('opens and closes the menu when the trigger is toggled', async () => {
      const user = userEvent.setup();
      renderMenu();
      const trigger = screen.getByRole('button', { name: /library actions/i });

      await user.click(trigger);
      expect(screen.getByRole('menu')).toBeInTheDocument();

      await user.click(trigger);
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('renders the menu into a document.body portal', async () => {
      const user = userEvent.setup();
      renderMenu();
      await openMenu(user);
      expect(document.body.querySelector('[role="menu"]')).toBeInTheDocument();
    });
  });

  describe('menu contents and grouping', () => {
    it('renders all actions in the grouped order (writeOpf + missing present)', async () => {
      const user = userEvent.setup();
      renderMenu({ writeOpf: true, missingCount: 3 });
      await openMenu(user);

      const labels = screen.getAllByRole('menuitem').map((el) => el.textContent);
      expect(labels).toEqual([
        'Import Files',
        'Import Existing Library',
        'Refresh Library',
        'Search Wanted',
        'Rename All Books',
        'Re-tag All Books',
        'Write / refresh sidecars',
        'Remove Missing Books',
      ]);
    });

    it('keeps Import Files (/import) and Import Existing Library (/library-import) as distinct destinations', async () => {
      const user = userEvent.setup();
      renderMenu();
      await openMenu(user);

      expect(screen.getByRole('menuitem', { name: /import files/i })).toHaveAttribute('href', '/import');
      expect(screen.getByRole('menuitem', { name: /import existing library/i })).toHaveAttribute('href', '/library-import');
    });

    it('renders dividers between the four groups (excluded from menuitem roving query)', async () => {
      const user = userEvent.setup();
      renderMenu({ writeOpf: true, missingCount: 2 });
      await openMenu(user);

      const menu = screen.getByRole('menu');
      expect(menu.querySelectorAll('.border-t')).toHaveLength(3);
    });
  });

  describe('Refresh Library', () => {
    it('calls onRescan when clicked', async () => {
      const user = userEvent.setup();
      const props = renderMenu();
      await openMenu(user);
      await user.click(screen.getByRole('menuitem', { name: /refresh library/i }));
      expect(props.onRescan).toHaveBeenCalledTimes(1);
    });

    it('is disabled while rescanning and does not call onRescan', async () => {
      const user = userEvent.setup();
      const props = renderMenu({ isRescanning: true });
      await openMenu(user);
      const item = screen.getByRole('menuitem', { name: /refresh library/i });
      expect(item).toBeDisabled();
      await user.click(item);
      expect(props.onRescan).not.toHaveBeenCalled();
    });
  });

  describe('Search Wanted', () => {
    it('calls onSearchAllWanted when clicked', async () => {
      const user = userEvent.setup();
      const props = renderMenu();
      await openMenu(user);
      await user.click(screen.getByRole('menuitem', { name: /search wanted/i }));
      expect(props.onSearchAllWanted).toHaveBeenCalledTimes(1);
    });

    it('is disabled while a wanted search is pending', async () => {
      const user = userEvent.setup();
      renderMenu({ isSearchingAllWanted: true });
      await openMenu(user);
      expect(screen.getByRole('menuitem', { name: /search wanted/i })).toBeDisabled();
    });
  });

  describe('Remove Missing Books (conditional on missingCount)', () => {
    it('is present and calls onRemoveMissing when missingCount > 0', async () => {
      const user = userEvent.setup();
      const props = renderMenu({ missingCount: 5 });
      await openMenu(user);
      await user.click(screen.getByRole('menuitem', { name: /remove missing books/i }));
      expect(props.onRemoveMissing).toHaveBeenCalledTimes(1);
    });

    it('is absent when missingCount is 0', async () => {
      const user = userEvent.setup();
      renderMenu({ missingCount: 0 });
      await openMenu(user);
      expect(screen.queryByRole('menuitem', { name: /remove missing books/i })).not.toBeInTheDocument();
    });
  });

  describe('Write / refresh sidecars (conditional on writeOpf)', () => {
    it('is present when writeOpf is true', async () => {
      const user = userEvent.setup();
      renderMenu({ writeOpf: true });
      await openMenu(user);
      expect(screen.getByRole('menuitem', { name: /write \/ refresh sidecars/i })).toBeInTheDocument();
    });

    it('is absent when writeOpf is false (the default)', async () => {
      const user = userEvent.setup();
      renderMenu({ writeOpf: false });
      await openMenu(user);
      expect(screen.queryByRole('menuitem', { name: /sidecars/i })).not.toBeInTheDocument();
    });

    it('confirming the sidecar modal starts the write_metadata_sidecars job', async () => {
      const user = userEvent.setup();
      renderMenu({ writeOpf: true });
      await openMenu(user);
      await user.click(screen.getByRole('menuitem', { name: /write \/ refresh sidecars/i }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /write sidecars/i }));
      expect(mockStartJob).toHaveBeenCalledWith('write_metadata_sidecars');
    });
  });

  describe('bulk flows', () => {
    it('Rename All Books opens the preview modal and confirming starts the rename job', async () => {
      const user = userEvent.setup();
      renderMenu();
      await openMenu(user);
      await user.click(screen.getByRole('menuitem', { name: /rename all books/i }));
      const dialog = await screen.findByRole('dialog');
      await within(dialog).findByText(/Check 15 imported books\. 5 need folder moves\./i);
      await user.click(within(dialog).getByRole('button', { name: /^rename all$/i }));
      expect(mockStartJob).toHaveBeenCalledWith('rename');
    });

    it('Re-tag All Books fetches a count, shows the confirm modal, and confirming starts the retag job', async () => {
      const user = userEvent.setup();
      renderMenu();
      await openMenu(user);
      await user.click(screen.getByRole('menuitem', { name: /re-tag all books/i }));
      const dialog = await screen.findByRole('dialog');
      expect(api.getBulkRetagCount).toHaveBeenCalled();
      expect(within(dialog).getByText(/15 books/i)).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: /^re-tag all$/i }));
      expect(mockStartJob).toHaveBeenCalledWith('retag');
    });

    it('cancelling a bulk modal does not start a job', async () => {
      const user = userEvent.setup();
      renderMenu();
      await openMenu(user);
      await user.click(screen.getByRole('menuitem', { name: /rename all books/i }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /cancel/i }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(mockStartJob).not.toHaveBeenCalled();
    });

    it('surfaces a toast when the retag count prefetch rejects', async () => {
      const user = userEvent.setup();
      (api.getBulkRetagCount as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Server error'));
      renderMenu();
      await openMenu(user);
      await user.click(screen.getByRole('menuitem', { name: /re-tag all books/i }));
      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Server error');
      });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  describe('single-active-bulk-operation guard', () => {
    it('disables all bulk items while a bulk job runs and tags non-running ones with the "already running" title', async () => {
      const user = userEvent.setup();
      renderMenu({ writeOpf: true }, { isRunning: true, jobType: 'rename', completed: 3, total: 10 });
      await openMenu(user);

      const retag = screen.getByRole('menuitem', { name: /re-tag all books/i });
      const sidecars = screen.getByRole('menuitem', { name: /write \/ refresh sidecars/i });
      expect(retag).toBeDisabled();
      expect(sidecars).toBeDisabled();
      expect(retag).toHaveAttribute('title', 'A bulk operation is already running.');
    });

    it('excludes disabled bulk items from the roving-focus set', async () => {
      const user = userEvent.setup();
      renderMenu({ writeOpf: true, missingCount: 2 }, { isRunning: true, jobType: 'rename' });
      await openMenu(user);

      const focusable = screen.getAllByRole('menuitem').filter((el) => !el.hasAttribute('disabled'));
      const labels = focusable.map((el) => el.textContent);
      expect(labels).toEqual([
        'Import Files',
        'Import Existing Library',
        'Refresh Library',
        'Search Wanted',
        'Remove Missing Books',
      ]);
    });

    it('does not dispatch a second bulk start when a disabled bulk item is clicked', async () => {
      const user = userEvent.setup();
      renderMenu({}, { isRunning: true, jobType: 'rename' });
      await openMenu(user);
      await user.click(screen.getByRole('menuitem', { name: /re-tag all books/i }));
      expect(api.getBulkRetagCount).not.toHaveBeenCalled();
      expect(mockStartJob).not.toHaveBeenCalled();
    });

    it('keeps non-bulk actions enabled and dispatching while a bulk job runs', async () => {
      const user = userEvent.setup();
      const props = renderMenu({ missingCount: 1 }, { isRunning: true, jobType: 'retag' });
      await openMenu(user);

      const refresh = screen.getByRole('menuitem', { name: /refresh library/i });
      const search = screen.getByRole('menuitem', { name: /search wanted/i });
      const removeMissing = screen.getByRole('menuitem', { name: /remove missing books/i });
      expect(refresh).toBeEnabled();
      expect(search).toBeEnabled();
      expect(removeMissing).toBeEnabled();

      await user.click(refresh);
      expect(props.onRescan).toHaveBeenCalledTimes(1);
    });

    it('reflects the retag-count prefetch as a busy trigger that also disables other bulk items', async () => {
      const user = userEvent.setup();
      (api.getBulkRetagCount as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
      renderMenu();
      await openMenu(user);
      await user.click(screen.getByRole('menuitem', { name: /re-tag all books/i }));

      const trigger = screen.getByRole('button', { name: /library actions/i });
      await waitFor(() => {
        expect(trigger.textContent).toMatch(/loading/i);
      });

      await user.click(trigger);
      expect(screen.getByRole('menuitem', { name: /rename all books/i })).toBeDisabled();
      expect(screen.getByRole('menuitem', { name: /re-tag all books/i })).toBeDisabled();
    });
  });

  describe('progress + failure feedback on the trigger', () => {
    it('shows the running label and N/total on the trigger while a job runs', () => {
      renderMenu({}, { isRunning: true, jobType: 'rename', completed: 3, total: 10 });
      const trigger = screen.getByRole('button', { name: /library actions/i });
      expect(trigger.textContent).toMatch(/Renaming 3\/10/);
    });

    it('shows the failure count near the trigger even when the menu is closed', () => {
      renderMenu({}, { isRunning: true, jobType: 'retag', completed: 5, total: 10, failures: 2 });
      expect(screen.getByText(/2 failures/i)).toBeInTheDocument();
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  });

  describe('named failure disclosure', () => {
    const liveCase: BulkJobFailure = { bookId: 226, title: "Captain's Fury", error: 'ENOENT' };

    function failureDisclosure() {
      return screen.getByRole('button', { name: /failure/i });
    }

    it('renders nothing new when there are no failures', () => {
      renderMenu({}, { isRunning: true, jobType: 'rename', completed: 5, total: 10, failures: 0 });
      expect(screen.queryByText(/failure/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /failure/i })).not.toBeInTheDocument();
    });

    it('reads "1 failure" while collapsed, with the detail hidden', () => {
      renderMenu({}, { isRunning: true, jobType: 'write_metadata_sidecars', failures: 1, failureDetails: [liveCase] });
      expect(screen.getByText(/1 failure/i)).toBeInTheDocument();
      expect(failureDisclosure()).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByText(/Captain's Fury/)).not.toBeInTheDocument();
    });

    it('names the book when expanded — the live #2159 case', async () => {
      const user = userEvent.setup();
      renderMenu({}, { isRunning: true, jobType: 'write_metadata_sidecars', failures: 1, failureDetails: [liveCase] });

      await user.click(failureDisclosure());

      expect(screen.getByText("Captain's Fury (book 226): ENOENT")).toBeInTheDocument();
      expect(failureDisclosure()).toHaveAttribute('aria-expanded', 'true');
    });

    it('ends the expanded list with "…and N more" when the count exceeds the retained rows', async () => {
      const user = userEvent.setup();
      const failureDetails = Array.from({ length: 50 }, (_, i) => ({ bookId: i + 1, title: `Book ${i + 1}`, error: 'ENOENT' }));
      renderMenu({}, { isRunning: false, jobType: 'rename', failures: 60, failureDetails });

      await user.click(failureDisclosure());

      expect(screen.getByText('…and 10 more')).toBeInTheDocument();
      expect(screen.getByText('Book 1 (book 1): ENOENT')).toBeInTheDocument();
      expect(screen.getByText('Book 50 (book 50): ENOENT')).toBeInTheDocument();
    });

    it('omits the "…and N more" row when every failure is named', async () => {
      const user = userEvent.setup();
      renderMenu({}, { isRunning: false, failures: 1, failureDetails: [liveCase] });

      await user.click(failureDisclosure());

      expect(screen.queryByText(/and \d+ more/)).not.toBeInTheDocument();
    });

    it('still discloses the named failures after the job completes', async () => {
      const user = userEvent.setup();
      renderMenu({}, { isRunning: false, jobType: null, completed: 694, total: 694, failures: 1, failureDetails: [liveCase] });

      expect(screen.getByText(/1 failure/i)).toBeInTheDocument();
      await user.click(failureDisclosure());
      expect(screen.getByText("Captain's Fury (book 226): ENOENT")).toBeInTheDocument();
    });

    describe('z-index scale (CSS-1)', () => {
      it('failure panel has z-30 class (dropdown scale)', async () => {
        const user = userEvent.setup();
        renderMenu({}, { isRunning: true, failures: 1, failureDetails: [liveCase] });

        await user.click(failureDisclosure());

        const panel = screen.getByText("Captain's Fury (book 226): ENOENT").closest('ul')!;
        expect(panel).toHaveClass('z-30');
        expect(panel).not.toHaveClass('z-20');
      });
    });

    it('collapses again on a second click', async () => {
      const user = userEvent.setup();
      renderMenu({}, { isRunning: true, failures: 1, failureDetails: [liveCase] });

      await user.click(failureDisclosure());
      expect(screen.getByText("Captain's Fury (book 226): ENOENT")).toBeInTheDocument();
      await user.click(failureDisclosure());
      expect(screen.queryByText("Captain's Fury (book 226): ENOENT")).not.toBeInTheDocument();
    });
  });

  describe('accessibility / keyboard', () => {
    it('focuses the first enabled item on open and wraps with ArrowUp/ArrowDown across the full set', async () => {
      const user = userEvent.setup();
      renderMenu({ writeOpf: true, missingCount: 2 });
      await openMenu(user);

      expect(screen.getByRole('menuitem', { name: /import files/i })).toHaveFocus();
      await user.keyboard('{ArrowUp}');
      expect(screen.getByRole('menuitem', { name: /remove missing books/i })).toHaveFocus();
      await user.keyboard('{ArrowDown}');
      expect(screen.getByRole('menuitem', { name: /import files/i })).toHaveFocus();
    });

    it('closes on Escape and returns focus to the trigger', async () => {
      const user = userEvent.setup();
      renderMenu();
      const trigger = screen.getByRole('button', { name: /library actions/i });
      await user.click(trigger);
      expect(screen.getByRole('menu')).toBeInTheDocument();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });

    it('closes on outside click and returns focus to the trigger', async () => {
      const user = userEvent.setup();
      mockBulk();
      renderWithProviders(
        <div>
          <LibraryActionsMenu {...defaultProps()} />
          <div data-testid="outside" />
        </div>,
      );
      const trigger = screen.getByRole('button', { name: /library actions/i });
      await user.click(trigger);
      expect(screen.getByRole('menu')).toBeInTheDocument();
      fireEvent.mouseDown(screen.getByTestId('outside'));
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });
  });
});
