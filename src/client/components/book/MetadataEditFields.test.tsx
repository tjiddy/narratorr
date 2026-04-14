import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { MetadataEditFields } from './MetadataEditFields';

type EditProps = ComponentProps<typeof MetadataEditFields>;

const defaultProps: EditProps = {
  title: 'The Way of Kings',
  onTitleChange: vi.fn(),
  seriesName: 'The Stormlight Archive',
  onSeriesNameChange: vi.fn(),
  seriesPosition: '1',
  onSeriesPositionChange: vi.fn(),
  positionError: null,
  narrator: 'Michael Kramer',
  onNarratorChange: vi.fn(),
  renameFiles: false,
  onRenameFilesChange: vi.fn(),
  hasPath: true,
  onOpenSearch: vi.fn(),
};

function renderFields(overrides: Partial<EditProps> = {}) {
  return render(<MetadataEditFields {...defaultProps} {...overrides} />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MetadataEditFields', () => {
  describe('form fields', () => {
    it('renders title input with current value', () => {
      renderFields();
      expect(screen.getByLabelText(/title/i)).toHaveValue('The Way of Kings');
    });

    it('renders series name input with current value', () => {
      renderFields();
      expect(screen.getByLabelText(/series$/i)).toHaveValue('The Stormlight Archive');
    });

    it('renders series position input with current value', () => {
      renderFields();
      expect(screen.getByLabelText(/position/i)).toHaveValue('1');
    });

    it('renders narrator input with current value', () => {
      renderFields();
      expect(screen.getByLabelText(/narrator/i)).toHaveValue('Michael Kramer');
    });

    it('calls onTitleChange when title input changes', async () => {
      const onTitleChange = vi.fn();
      renderFields({ onTitleChange });
      await userEvent.clear(screen.getByLabelText(/title/i));
      await userEvent.type(screen.getByLabelText(/title/i), 'New');
      expect(onTitleChange).toHaveBeenCalled();
    });
  });

  describe('series position validation', () => {
    it('shows error message for non-numeric position input', () => {
      renderFields({ positionError: 'Must be a number' });
      expect(screen.getByText('Must be a number')).toBeInTheDocument();
    });

    it('shows no error for valid numeric position', () => {
      renderFields({ positionError: null });
      expect(screen.queryByText('Must be a number')).not.toBeInTheDocument();
    });
  });

  describe('rename files checkbox', () => {
    it('shows rename checkbox when book has path', () => {
      renderFields({ hasPath: true });
      expect(screen.getByText(/Rename files after saving/)).toBeInTheDocument();
    });

    it('hides rename checkbox when book has no path', () => {
      renderFields({ hasPath: false });
      expect(screen.queryByText(/Rename files after saving/)).not.toBeInTheDocument();
    });

    it('toggles rename state on checkbox change', async () => {
      const onRenameFilesChange = vi.fn();
      renderFields({ onRenameFilesChange, hasPath: true });
      await userEvent.click(screen.getByRole('checkbox'));
      expect(onRenameFilesChange).toHaveBeenCalledWith(true);
    });
  });

  describe('search metadata button', () => {
    it('calls onOpenSearch when search metadata button clicked', async () => {
      const onOpenSearch = vi.fn();
      renderFields({ onOpenSearch });
      await userEvent.click(screen.getByText('Search for metadata'));
      expect(onOpenSearch).toHaveBeenCalledOnce();
    });
  });
});
