import { describe, it } from 'vitest';

describe('DeleteBookModal', () => {
  describe('single book delete', () => {
    it.todo('renders modal with book title in message');
    it.todo('shows "Also delete N files from disk" when audioFileCount is positive');
    it.todo('shows "Delete files from disk" when audioFileCount is null');
    it.todo('shows "Delete files from disk" when audioFileCount is 0');
    it.todo('hides toggle when book has no path');
    it.todo('calls onConfirm with deleteFiles=true when toggle is checked');
    it.todo('calls onConfirm with deleteFiles=false when toggle is unchecked');
    it.todo('calls onCancel when cancel button is clicked');
    it.todo('resets toggle state on cancel');
  });

  describe('bulk delete', () => {
    it.todo('renders modal with count of selected books');
    it.todo('shows "Also delete N files from disk" with summed audioFileCount');
    it.todo('shows "Delete files from disk" when summed count is 0');
    it.todo('hides toggle when no selected book has a path');
    it.todo('calls onConfirm with deleteFiles flag on confirm');
  });
});
