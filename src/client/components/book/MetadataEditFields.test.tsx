import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { MetadataEditFields } from './MetadataEditFields';

type EditProps = ComponentProps<typeof MetadataEditFields>;

const defaultProps: EditProps = {
  title: 'The Way of Kings',
  onTitleChange: vi.fn(),
  author: 'Brandon Sanderson',
  onAuthorChange: vi.fn(),
  seriesName: 'The Stormlight Archive',
  onSeriesNameChange: vi.fn(),
  seriesPosition: '1',
  onSeriesPositionChange: vi.fn(),
  positionError: null,
  narrator: 'Michael Kramer',
  onNarratorChange: vi.fn(),
  description: 'An epic fantasy novel.',
  onDescriptionChange: vi.fn(),
  publishedDate: '2010-08-31',
  onPublishedDateChange: vi.fn(),
  genres: 'Fantasy, Epic',
  onGenresChange: vi.fn(),
  coverUrl: 'https://example.com/cover.jpg',
  onCoverUrlChange: vi.fn(),
  renameFiles: false,
  onRenameFilesChange: vi.fn(),
  hasPath: true,
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

    it('renders author input with current value', () => {
      renderFields();
      expect(screen.getByLabelText(/^author$/i)).toHaveValue('Brandon Sanderson');
    });

    it('renders published date input with current value', () => {
      renderFields();
      expect(screen.getByLabelText(/published date/i)).toHaveValue('2010-08-31');
    });

    it('renders genres input with current value', () => {
      renderFields();
      expect(screen.getByLabelText(/genres/i)).toHaveValue('Fantasy, Epic');
    });

    it('renders cover URL input with current value', () => {
      renderFields();
      expect(screen.getByLabelText(/cover url/i)).toHaveValue('https://example.com/cover.jpg');
    });

    it('renders description input with current value', () => {
      renderFields();
      expect(screen.getByLabelText(/description/i)).toHaveValue('An epic fantasy novel.');
    });

    it('calls onTitleChange when title input changes', async () => {
      const onTitleChange = vi.fn();
      renderFields({ onTitleChange });
      await userEvent.clear(screen.getByLabelText(/title/i));
      await userEvent.type(screen.getByLabelText(/title/i), 'New');
      expect(onTitleChange).toHaveBeenCalled();
    });

    it('calls onAuthorChange when author input changes', async () => {
      const onAuthorChange = vi.fn();
      renderFields({ onAuthorChange });
      await userEvent.type(screen.getByLabelText(/^author$/i), '!');
      expect(onAuthorChange).toHaveBeenCalled();
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

  describe('embedded search removed (#1609)', () => {
    it('does not render a "Search for metadata" button', () => {
      renderFields();
      expect(screen.queryByText('Search for metadata')).not.toBeInTheDocument();
    });

    it('documents that subtitle/publisher/duration are not editable here', () => {
      renderFields();
      expect(screen.getByText(/Subtitle and publisher come from the matched metadata/i)).toBeInTheDocument();
    });
  });
});
