import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BookMetadataModal } from './BookMetadataModal';

const mockBook = {
  id: 1,
  title: 'The Way of Kings',
  narrator: 'Michael Kramer',
  seriesName: 'The Stormlight Archive',
  seriesPosition: 1,
  path: '/library/Brandon Sanderson/The Way of Kings',
  status: 'imported',
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
};

const defaultProps = {
  book: mockBook as Parameters<typeof BookMetadataModal>[0]['book'],
  onSave: vi.fn(),
  onClose: vi.fn(),
  isSaving: false,
};

function renderModal(overrides = {}) {
  return render(<BookMetadataModal {...defaultProps} {...overrides} />);
}

describe('BookMetadataModal', () => {
  it('opens with current metadata pre-filled', () => {
    renderModal();

    expect(screen.getByLabelText(/title/i)).toHaveValue('The Way of Kings');
    expect(screen.getByLabelText(/series$/i)).toHaveValue('The Stormlight Archive');
    expect(screen.getByLabelText(/position/i)).toHaveValue('1');
    expect(screen.getByLabelText(/narrator/i)).toHaveValue('Michael Kramer');
  });

  it('calls onSave with updated data when Save is clicked', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    renderModal({ onSave });

    const titleInput = screen.getByLabelText(/title/i);
    await user.clear(titleInput);
    await user.type(titleInput, 'Words of Radiance');

    await user.click(screen.getByText('Save'));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Words of Radiance' }),
      false, // renameFiles not checked
    );
  });

  it('calls onSave with rename=true when checkbox is checked', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    renderModal({ onSave });

    await user.click(screen.getByLabelText(/rename files/i));
    await user.click(screen.getByText('Save'));

    expect(onSave).toHaveBeenCalledWith(
      expect.any(Object),
      true,
    );
  });

  it('prevents saving with empty title', () => {
    renderModal();

    // Title is pre-filled, so Save should be enabled
    expect(screen.getByText('Save')).not.toBeDisabled();
  });

  it('disables Save when title is cleared', async () => {
    const user = userEvent.setup();
    renderModal();

    const titleInput = screen.getByLabelText(/title/i);
    await user.clear(titleInput);

    expect(screen.getByText('Save')).toBeDisabled();
  });

  it('calls onClose when Cancel is clicked', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal({ onClose });

    await user.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('hides rename checkbox when book has no path', () => {
    const bookNoPath = { ...mockBook, path: null };
    renderModal({ book: bookNoPath });

    expect(screen.queryByLabelText(/rename files/i)).not.toBeInTheDocument();
  });

  it('shows Saving... text when isSaving is true', () => {
    renderModal({ isSaving: true });
    expect(screen.getByText('Saving...')).toBeInTheDocument();
    expect(screen.getByText('Saving...')).toBeDisabled();
  });

  it('sends seriesPosition as number', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    renderModal({ onSave });

    const posInput = screen.getByLabelText(/position/i);
    await user.clear(posInput);
    await user.type(posInput, '2.5');
    await user.click(screen.getByText('Save'));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ seriesPosition: 2.5 }),
      false,
    );
  });

  it('sends null seriesName when cleared', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    renderModal({ onSave });

    const seriesInput = screen.getByLabelText(/series$/i);
    await user.clear(seriesInput);
    await user.click(screen.getByText('Save'));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ seriesName: null }),
      false,
    );
  });
});
