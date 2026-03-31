import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { DeleteBookModal } from './DeleteBookModal';

const defaultProps = {
  isOpen: true,
  title: 'Remove from Library',
  message: 'Are you sure you want to remove "The Way of Kings"?',
  fileCount: 12,
  hasPath: true,
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
};

describe('DeleteBookModal', () => {
  describe('single book delete', () => {
    it('renders modal with book title in message', () => {
      renderWithProviders(<DeleteBookModal {...defaultProps} />);
      expect(screen.getByText(/The Way of Kings/)).toBeInTheDocument();
    });

    it('shows "Also delete N files from disk" when audioFileCount is positive', () => {
      renderWithProviders(<DeleteBookModal {...defaultProps} fileCount={12} />);
      expect(screen.getByLabelText('Also delete 12 files from disk')).toBeInTheDocument();
    });

    it('shows "Delete files from disk" when audioFileCount is null', () => {
      renderWithProviders(<DeleteBookModal {...defaultProps} fileCount={null} />);
      expect(screen.getByLabelText('Delete files from disk')).toBeInTheDocument();
    });

    it('shows "Delete files from disk" when audioFileCount is 0', () => {
      renderWithProviders(<DeleteBookModal {...defaultProps} fileCount={0} />);
      expect(screen.getByLabelText('Delete files from disk')).toBeInTheDocument();
    });

    it('hides toggle when book has no path', () => {
      renderWithProviders(<DeleteBookModal {...defaultProps} hasPath={false} />);
      expect(screen.queryByText(/files from disk/)).not.toBeInTheDocument();
    });

    it('calls onConfirm with deleteFiles=true when toggle is checked', async () => {
      const onConfirm = vi.fn();
      const user = userEvent.setup();
      renderWithProviders(<DeleteBookModal {...defaultProps} onConfirm={onConfirm} />);

      await user.click(screen.getByLabelText('Also delete 12 files from disk'));
      await user.click(screen.getByRole('button', { name: 'Remove' }));

      expect(onConfirm).toHaveBeenCalledWith(true);
    });

    it('calls onConfirm with deleteFiles=false when toggle is unchecked', async () => {
      const onConfirm = vi.fn();
      const user = userEvent.setup();
      renderWithProviders(<DeleteBookModal {...defaultProps} onConfirm={onConfirm} />);

      await user.click(screen.getByRole('button', { name: 'Remove' }));

      expect(onConfirm).toHaveBeenCalledWith(false);
    });

    it('calls onCancel when cancel button is clicked', async () => {
      const onCancel = vi.fn();
      const user = userEvent.setup();
      renderWithProviders(<DeleteBookModal {...defaultProps} onCancel={onCancel} />);

      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(onCancel).toHaveBeenCalled();
    });

    it('resets toggle state on cancel', async () => {
      const user = userEvent.setup();
      const onCancel = vi.fn();
      const { rerender } = renderWithProviders(
        <DeleteBookModal {...defaultProps} onCancel={onCancel} />,
      );

      // Check the toggle
      await user.click(screen.getByLabelText('Also delete 12 files from disk'));
      expect(screen.getByLabelText('Also delete 12 files from disk')).toBeChecked();

      // Cancel
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      // Re-render as open — toggle should be reset
      rerender(<DeleteBookModal {...defaultProps} onCancel={onCancel} />);
      expect(screen.getByLabelText('Also delete 12 files from disk')).not.toBeChecked();
    });

    it('shows singular "file" when audioFileCount is 1', () => {
      renderWithProviders(<DeleteBookModal {...defaultProps} fileCount={1} />);
      expect(screen.getByLabelText('Also delete 1 file from disk')).toBeInTheDocument();
    });
  });
});
