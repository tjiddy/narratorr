import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockLibraryBook } from '@/__tests__/factories';
import { LibraryModals } from './LibraryModals';

const baseProps = {
  deleteTarget: null,
  isDeleteOpen: false,
  onDeleteConfirm: vi.fn(),
  onDeleteCancel: vi.fn(),
  showRemoveMissingModal: false,
  missingCount: 0,
  onRemoveMissingConfirm: vi.fn(),
  onRemoveMissingCancel: vi.fn(),
  showSearchAllWantedModal: false,
  searchAllWantedMessage: '',
  onSearchAllWantedConfirm: vi.fn(),
  onSearchAllWantedCancel: vi.fn(),
  searchBook: null,
  onSearchBookClose: vi.fn(),
};

describe('LibraryModals', () => {
  describe('delete modal file count label', () => {
    it('shows "Also delete N files from disk" when deleteTarget has audioFileCount', () => {
      const book = createMockLibraryBook({ audioFileCount: 5, path: '/lib/book' });
      renderWithProviders(
        <LibraryModals {...baseProps} deleteTarget={book} isDeleteOpen={true} />,
      );
      expect(screen.getByLabelText('Also delete 5 files from disk')).toBeInTheDocument();
    });

    it('shows "Delete files from disk" when deleteTarget has no audioFileCount', () => {
      const book = createMockLibraryBook({ audioFileCount: null, path: '/lib/book' });
      renderWithProviders(
        <LibraryModals {...baseProps} deleteTarget={book} isDeleteOpen={true} />,
      );
      expect(screen.getByLabelText('Delete files from disk')).toBeInTheDocument();
    });

    it('hides toggle when deleteTarget has no path', () => {
      const book = createMockLibraryBook({ audioFileCount: 5, path: null });
      renderWithProviders(
        <LibraryModals {...baseProps} deleteTarget={book} isDeleteOpen={true} />,
      );
      expect(screen.queryByText(/files from disk/)).not.toBeInTheDocument();
    });
  });
});
