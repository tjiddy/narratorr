import { describe, it, expect, vi } from 'vitest';
import { screen, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { BulkActionToolbar } from './BulkActionToolbar';

const baseProps = {
  selectedCount: 3,
  onDelete: vi.fn(),
  isDeleting: false,
  onSearch: vi.fn(),
  isSearching: false,
  onSetStatus: vi.fn(),
  isSettingStatus: false,
  hasPath: true,
  fileCount: 25,
};

describe('BulkActionToolbar', () => {
  describe('file count in delete toggle', () => {
    it('shows file count label when fileCount > 0', async () => {
      const user = userEvent.setup();
      renderWithProviders(<BulkActionToolbar {...baseProps} fileCount={25} />);

      await user.click(screen.getByRole('button', { name: /Remove/ }));

      expect(screen.getByLabelText('Also delete 25 files from disk')).toBeInTheDocument();
    });

    it('shows generic label when fileCount is 0', async () => {
      const user = userEvent.setup();
      renderWithProviders(<BulkActionToolbar {...baseProps} fileCount={0} />);

      await user.click(screen.getByRole('button', { name: /Remove/ }));

      expect(screen.getByLabelText('Delete files from disk')).toBeInTheDocument();
    });

    it('hides toggle when hasPath is false', async () => {
      const user = userEvent.setup();
      renderWithProviders(<BulkActionToolbar {...baseProps} hasPath={false} />);

      await user.click(screen.getByRole('button', { name: /Remove/ }));

      expect(screen.queryByText(/files from disk/)).not.toBeInTheDocument();
    });

    it('calls onDelete with deleteFiles=true when toggle is checked and confirmed', async () => {
      const onDelete = vi.fn();
      const user = userEvent.setup();
      renderWithProviders(<BulkActionToolbar {...baseProps} onDelete={onDelete} fileCount={10} />);

      await user.click(screen.getByRole('button', { name: /Remove/ }));
      await user.click(screen.getByLabelText('Also delete 10 files from disk'));
      const dialog = screen.getByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

      expect(onDelete).toHaveBeenCalledWith(true);
    });

    it('calls onDelete with deleteFiles=false when toggle is unchecked and confirmed', async () => {
      const onDelete = vi.fn();
      const user = userEvent.setup();
      renderWithProviders(<BulkActionToolbar {...baseProps} onDelete={onDelete} />);

      await user.click(screen.getByRole('button', { name: /Remove/ }));
      const dialog = screen.getByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

      expect(onDelete).toHaveBeenCalledWith(false);
    });
  });

  describe('status menu outside-close', () => {
    it('closes the status menu when mousedown fires outside the menu', async () => {
      const user = userEvent.setup();
      renderWithProviders(<BulkActionToolbar {...baseProps} />);

      await user.click(screen.getByRole('button', { name: /Set Status/ }));
      expect(screen.getByText('Wanted')).toBeInTheDocument();

      fireEvent.mouseDown(document.body);

      expect(screen.queryByText('Wanted')).not.toBeInTheDocument();
    });
  });

  describe('button label terminology', () => {
    it('renders bulk toolbar trigger button with "Remove" label (not "Delete")', () => {
      renderWithProviders(<BulkActionToolbar {...baseProps} />);

      expect(screen.getByRole('button', { name: /Remove/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Delete$/ })).not.toBeInTheDocument();
    });

    it('disabled state preserved with "Remove" label', () => {
      renderWithProviders(<BulkActionToolbar {...baseProps} isDeleting={true} />);

      const removeButton = screen.getByRole('button', { name: /Remove/ });
      expect(removeButton).toBeDisabled();
    });
  });
});
