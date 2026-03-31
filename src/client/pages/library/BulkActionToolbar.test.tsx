import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
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

      await user.click(screen.getByRole('button', { name: /Delete/ }));

      expect(screen.getByLabelText('Also delete 25 files from disk')).toBeInTheDocument();
    });

    it('shows generic label when fileCount is 0', async () => {
      const user = userEvent.setup();
      renderWithProviders(<BulkActionToolbar {...baseProps} fileCount={0} />);

      await user.click(screen.getByRole('button', { name: /Delete/ }));

      expect(screen.getByLabelText('Delete files from disk')).toBeInTheDocument();
    });

    it('hides toggle when hasPath is false', async () => {
      const user = userEvent.setup();
      renderWithProviders(<BulkActionToolbar {...baseProps} hasPath={false} />);

      await user.click(screen.getByRole('button', { name: /Delete/ }));

      expect(screen.queryByText(/files from disk/)).not.toBeInTheDocument();
    });

    it('calls onDelete with deleteFiles=true when toggle is checked and confirmed', async () => {
      const onDelete = vi.fn();
      const user = userEvent.setup();
      renderWithProviders(<BulkActionToolbar {...baseProps} onDelete={onDelete} fileCount={10} />);

      await user.click(screen.getByRole('button', { name: /Delete/ }));
      await user.click(screen.getByLabelText('Also delete 10 files from disk'));
      await user.click(screen.getByRole('button', { name: 'Remove' }));

      expect(onDelete).toHaveBeenCalledWith(true);
    });

    it('calls onDelete with deleteFiles=false when toggle is unchecked and confirmed', async () => {
      const onDelete = vi.fn();
      const user = userEvent.setup();
      renderWithProviders(<BulkActionToolbar {...baseProps} onDelete={onDelete} />);

      await user.click(screen.getByRole('button', { name: /Delete/ }));
      await user.click(screen.getByRole('button', { name: 'Remove' }));

      expect(onDelete).toHaveBeenCalledWith(false);
    });
  });
});
