import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { NamingTokenModal } from './NamingTokenModal';

vi.mock('@core/utils/index.js', () => ({
  renderTemplate: (template: string, _tokens: unknown, options?: { separator?: string; case?: string }) => {
    let result = template;
    if (options?.separator && options.separator !== 'space') result = `[sep:${options.separator}] ${result}`;
    if (options?.case && options.case !== 'default') result = `[case:${options.case}] ${result}`;
    return result;
  },
  renderFilename: (template: string, _tokens: unknown, options?: { separator?: string; case?: string }) => {
    let result = template;
    if (options?.separator && options.separator !== 'space') result = `[sep:${options.separator}] ${result}`;
    if (options?.case && options.case !== 'default') result = `[case:${options.case}] ${result}`;
    return result;
  },
  FOLDER_ALLOWED_TOKENS: ['author', 'authorLastFirst', 'title', 'titleSort', 'series', 'seriesPosition', 'year', 'narrator', 'narratorLastFirst'],
  FILE_ALLOWED_TOKENS: ['author', 'authorLastFirst', 'title', 'titleSort', 'series', 'seriesPosition', 'year', 'narrator', 'narratorLastFirst', 'trackNumber', 'trackTotal', 'partName'],
  FOLDER_TOKEN_GROUPS: [
    { label: 'Author', tokens: ['author', 'authorLastFirst'] },
    { label: 'Title', tokens: ['title', 'titleSort'] },
    { label: 'Series', tokens: ['series', 'seriesPosition'] },
    { label: 'Narrator', tokens: ['narrator', 'narratorLastFirst'] },
    { label: 'Metadata', tokens: ['year'] },
  ],
  FILE_ONLY_TOKEN_GROUP: { label: 'File-specific', tokens: ['trackNumber', 'trackTotal', 'partName'] },
}));

const defaultProps = {
  isOpen: true,
  onClose: vi.fn(),
  onInsert: vi.fn(),
  scope: 'folder' as const,
  currentFormat: '{author}/{title}',
  previewTokens: { author: 'Brandon Sanderson', title: 'The Way of Kings' },
};

describe('NamingTokenModal', () => {
  describe('folder-scoped modal', () => {
    it('shows Author, Title, Series, Narrator, Metadata groups', () => {
      renderWithProviders(<NamingTokenModal {...defaultProps} />);
      expect(screen.getByText('Author')).toBeInTheDocument();
      expect(screen.getByText('Title')).toBeInTheDocument();
      expect(screen.getByText('Series')).toBeInTheDocument();
      expect(screen.getByText('Narrator')).toBeInTheDocument();
      expect(screen.getByText('Metadata')).toBeInTheDocument();
    });

    it('does not show File-specific group', () => {
      renderWithProviders(<NamingTokenModal {...defaultProps} />);
      expect(screen.queryByText('File-specific')).not.toBeInTheDocument();
      expect(screen.queryByText('{trackNumber}')).not.toBeInTheDocument();
    });

    it('shows correct tokens per group — Author (2), Title (2), Series (2), Narrator (2), Metadata (1)', () => {
      renderWithProviders(<NamingTokenModal {...defaultProps} />);
      expect(screen.getByText('{author}')).toBeInTheDocument();
      expect(screen.getByText('{authorLastFirst}')).toBeInTheDocument();
      expect(screen.getByText('{title}')).toBeInTheDocument();
      expect(screen.getByText('{titleSort}')).toBeInTheDocument();
      expect(screen.getByText('{series}')).toBeInTheDocument();
      expect(screen.getByText('{seriesPosition}')).toBeInTheDocument();
      expect(screen.getByText('{narrator}')).toBeInTheDocument();
      expect(screen.getByText('{narratorLastFirst}')).toBeInTheDocument();
      expect(screen.getByText('{year}')).toBeInTheDocument();
    });
  });

  describe('file-scoped modal', () => {
    it('shows all groups including File-specific', () => {
      renderWithProviders(<NamingTokenModal {...defaultProps} scope="file" />);
      expect(screen.getByText('File-specific')).toBeInTheDocument();
    });

    it('shows File-specific tokens: trackNumber, trackTotal, partName', () => {
      renderWithProviders(<NamingTokenModal {...defaultProps} scope="file" />);
      expect(screen.getByText('{trackNumber}')).toBeInTheDocument();
      expect(screen.getByText('{trackTotal}')).toBeInTheDocument();
      expect(screen.getByText('{partName}')).toBeInTheDocument();
    });
  });

  describe('token insertion', () => {
    it('calls onInsert with token name when token row is clicked', async () => {
      const onInsert = vi.fn();
      const user = userEvent.setup();
      renderWithProviders(<NamingTokenModal {...defaultProps} onInsert={onInsert} />);
      await user.click(screen.getByText('{author}'));
      expect(onInsert).toHaveBeenCalledWith('author');
    });
  });

  describe('syntax reference', () => {
    it('shows {token}, {token:00}, and {token? text} syntax examples', () => {
      renderWithProviders(<NamingTokenModal {...defaultProps} />);
      expect(screen.getByText('{token}')).toBeInTheDocument();
      expect(screen.getByText('{token:00}')).toBeInTheDocument();
      expect(screen.getByText('{token? text}')).toBeInTheDocument();
    });

    it('shows "Good to know" section with space collapsing, illegal chars, 255-char notes', () => {
      renderWithProviders(<NamingTokenModal {...defaultProps} />);
      expect(screen.getByText('Good to know')).toBeInTheDocument();
      expect(screen.getByText(/spaces are collapsed/i)).toBeInTheDocument();
      expect(screen.getByText(/illegal filesystem characters/i)).toBeInTheDocument();
      expect(screen.getByText(/255 characters/i)).toBeInTheDocument();
    });
  });

  describe('live preview', () => {
    it('footer shows rendered preview of current format value', () => {
      renderWithProviders(<NamingTokenModal {...defaultProps} />);
      expect(screen.getByText('Preview')).toBeInTheDocument();
      // The mock renderTemplate returns the template as-is when no options
      expect(screen.getByText('{author}/{title}')).toBeInTheDocument();
    });

    it('preview reflects namingOptions — separator and case tags appear', () => {
      renderWithProviders(
        <NamingTokenModal
          {...defaultProps}
          namingOptions={{ separator: 'period', case: 'upper' }}
        />,
      );
      // Mock prepends [sep:period] and [case:upper] when non-default options are passed
      expect(screen.getByText(/\[sep:period\]/)).toBeInTheDocument();
      expect(screen.getByText(/\[case:upper\]/)).toBeInTheDocument();
    });
  });

  describe('prefix conditional syntax reference', () => {
    it('shows prefix syntax example: {text?token}', () => {
      renderWithProviders(<NamingTokenModal {...defaultProps} />);
      expect(screen.getByText('{text?token}')).toBeInTheDocument();
    });

    it('shows combined prefix+suffix syntax example: {pre?token?suf}', () => {
      renderWithProviders(<NamingTokenModal {...defaultProps} />);
      expect(screen.getByText('{pre?token?suf}')).toBeInTheDocument();
    });

    it('explains disambiguation: prefix vs suffix in Good to know', () => {
      renderWithProviders(<NamingTokenModal {...defaultProps} />);
      expect(screen.getByText(/prefix.*not a token name/i)).toBeInTheDocument();
    });

    it('existing suffix syntax {token? text} still documented', () => {
      renderWithProviders(<NamingTokenModal {...defaultProps} />);
      expect(screen.getByText('{token? text}')).toBeInTheDocument();
    });
  });

  describe('close behavior', () => {
    it('closes when X button is clicked', async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      renderWithProviders(<NamingTokenModal {...defaultProps} onClose={onClose} />);
      await user.click(screen.getByLabelText('Close'));
      expect(onClose).toHaveBeenCalled();
    });

    it('does not close when backdrop is clicked (closeOnBackdropClick={false})', () => {
      const onClose = vi.fn();
      renderWithProviders(<NamingTokenModal {...defaultProps} onClose={onClose} />);
      fireEvent.click(screen.getByTestId('modal-backdrop'));
      expect(onClose).not.toHaveBeenCalled();
    });

    it('does not render when isOpen is false', () => {
      renderWithProviders(<NamingTokenModal {...defaultProps} isOpen={false} />);
      expect(screen.queryByText('Folder Token Reference')).not.toBeInTheDocument();
    });
  });

  describe('ARIA and dialog semantics (#484)', () => {
    it('renders role="dialog" and aria-modal="true" on the dialog element', () => {
      renderWithProviders(<NamingTokenModal {...defaultProps} />);
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
    });

    it('renders tabIndex={-1} on the dialog element', () => {
      renderWithProviders(<NamingTokenModal {...defaultProps} />);
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('tabIndex', '-1');
    });

    it('renders aria-labelledby linked to the heading id', () => {
      renderWithProviders(<NamingTokenModal {...defaultProps} />);
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-labelledby', 'naming-token-modal-title');
      const heading = document.getElementById('naming-token-modal-title');
      expect(heading).toBeInTheDocument();
      expect(heading!.tagName).toBe('H2');
    });

    it('dialog element receives focus on open via modalRef', () => {
      renderWithProviders(<NamingTokenModal {...defaultProps} />);
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveFocus();
    });
  });

  describe('Escape key (#484)', () => {
    it('calls onClose when Escape is pressed while isOpen=true', async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      renderWithProviders(<NamingTokenModal {...defaultProps} onClose={onClose} />);
      await user.keyboard('{Escape}');
      expect(onClose).toHaveBeenCalledOnce();
    });

    it('does not call onClose when Escape is pressed while isOpen=false', async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      renderWithProviders(<NamingTokenModal {...defaultProps} isOpen={false} onClose={onClose} />);
      await user.keyboard('{Escape}');
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});
