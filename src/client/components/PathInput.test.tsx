import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import type { FieldError, UseFormRegisterReturn } from 'react-hook-form';
import { PathInput } from './PathInput';

const mockBrowseDirectory = vi.fn();
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual('@/lib/api');
  return {
    ...actual,
    api: {
      ...(actual as { api: object }).api,
      browseDirectory: (...args: unknown[]) => mockBrowseDirectory(...args),
    },
  };
});

function makeRegistration(overrides?: Partial<UseFormRegisterReturn>): UseFormRegisterReturn {
  return {
    name: 'path',
    ref: vi.fn(),
    onChange: vi.fn(),
    onBlur: vi.fn(),
    disabled: false,
    ...overrides,
  };
}

beforeEach(() => {
  mockBrowseDirectory.mockResolvedValue({ dirs: [], parent: '/' });
});

describe('PathInput', () => {
  describe('rendering', () => {
    it('renders a distinctly labeled Browse button alongside the text input', () => {
      renderWithProviders(<PathInput value="" onChange={vi.fn()} />);
      expect(screen.getByRole('button', { name: /browse/i })).toBeInTheDocument();
      expect(screen.getByRole('textbox')).toBeInTheDocument();
    });

    it('decorative folder icon is not focusable and does not respond to click', async () => {
      const onChange = vi.fn();
      renderWithProviders(<PathInput value="" onChange={onChange} />);
      const icon = document.querySelector('[data-testid="path-input-icon"]');
      expect(icon).not.toBeNull();
      expect(icon).not.toHaveFocus();
      // clicking the icon must not open the modal
      await userEvent.click(icon!);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('renders error message text when error prop is supplied', () => {
      const error: FieldError = { type: 'required', message: 'Path is required' };
      renderWithProviders(<PathInput value="" onChange={vi.fn()} error={error} />);
      expect(screen.getByText('Path is required')).toBeInTheDocument();
    });

    it('renders without error message when error is absent', () => {
      renderWithProviders(<PathInput value="" onChange={vi.fn()} />);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('controlled mode (value/onChange)', () => {
    it('typing in the input calls onChange callback with the new string value', async () => {
      const onChange = vi.fn();
      renderWithProviders(<PathInput value="/path" onChange={onChange} />);
      await userEvent.type(screen.getByRole('textbox'), 'x');
      expect(onChange).toHaveBeenCalledWith('/pathx');
    });

    it('value prop sets the displayed text', () => {
      renderWithProviders(<PathInput value="/my/path" onChange={vi.fn()} />);
      expect(screen.getByRole('textbox')).toHaveValue('/my/path');
    });
  });

  describe('browse interaction', () => {
    it('clicking Browse opens the DirectoryBrowserModal', async () => {
      renderWithProviders(<PathInput value="" onChange={vi.fn()} />);
      await userEvent.click(screen.getByRole('button', { name: /browse/i }));
      expect(await screen.findByRole('dialog')).toBeInTheDocument();
    });

    it('selecting a path from the modal calls onChange with the selected path string', async () => {
      const onChange = vi.fn();
      mockBrowseDirectory.mockResolvedValue({ dirs: ['music'], parent: '/' });
      renderWithProviders(<PathInput value="" onChange={onChange} />);

      await userEvent.click(screen.getByRole('button', { name: /browse/i }));
      await screen.findByRole('dialog');
      await userEvent.click(await screen.findByRole('button', { name: 'Select' }));

      expect(onChange).toHaveBeenCalledWith('/');
    });

    it('modal is no longer visible after path selection', async () => {
      renderWithProviders(<PathInput value="" onChange={vi.fn()} />);
      await userEvent.click(screen.getByRole('button', { name: /browse/i }));
      await screen.findByRole('dialog');
      await userEvent.click(await screen.findByRole('button', { name: 'Select' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('closing the modal without selecting a path does not call onChange', async () => {
      const onChange = vi.fn();
      renderWithProviders(<PathInput value="" onChange={onChange} />);
      await userEvent.click(screen.getByRole('button', { name: /browse/i }));
      await screen.findByRole('dialog');
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('browse seeding', () => {
    it('when value is non-empty, the modal opens with that value as initialPath', async () => {
      renderWithProviders(<PathInput value="/existing/path" onChange={vi.fn()} />);
      await userEvent.click(screen.getByRole('button', { name: /browse/i }));
      await screen.findByRole('dialog');
      await waitFor(() => {
        expect(mockBrowseDirectory).toHaveBeenCalledWith('/existing/path');
      });
    });

    it('when value is empty and fallbackBrowsePath is provided, the modal opens with fallbackBrowsePath as initialPath', async () => {
      renderWithProviders(<PathInput value="" onChange={vi.fn()} fallbackBrowsePath="/fallback" />);
      await userEvent.click(screen.getByRole('button', { name: /browse/i }));
      await screen.findByRole('dialog');
      await waitFor(() => {
        expect(mockBrowseDirectory).toHaveBeenCalledWith('/fallback');
      });
    });

    it('when both value and fallbackBrowsePath are absent, the modal opens at /', async () => {
      renderWithProviders(<PathInput value="" onChange={vi.fn()} />);
      await userEvent.click(screen.getByRole('button', { name: /browse/i }));
      await screen.findByRole('dialog');
      await waitFor(() => {
        expect(mockBrowseDirectory).toHaveBeenCalledWith('/');
      });
    });
  });

  describe('RHF registration mode', () => {
    it('selecting a path via Browse calls registration.onChange so RHF field value is updated', async () => {
      const registration = makeRegistration();
      renderWithProviders(<PathInput value="" onChange={vi.fn()} registration={registration} />);

      await userEvent.click(screen.getByRole('button', { name: /browse/i }));
      await screen.findByRole('dialog');
      await userEvent.click(await screen.findByRole('button', { name: 'Select' }));

      expect(registration.onChange).toHaveBeenCalledWith(
        expect.objectContaining({ target: expect.objectContaining({ value: '/' }) }),
      );
    });

    it('spreading registration onto PathInput exposes the input name for RHF field tracking', () => {
      const registration = makeRegistration({ name: 'libraryPath' });
      renderWithProviders(<PathInput value="" onChange={vi.fn()} registration={registration} />);
      expect(screen.getByRole('textbox')).toHaveAttribute('name', 'libraryPath');
    });
  });

  describe('focus management', () => {
    it('after the modal closes (path selected), focus returns to the Browse button', async () => {
      renderWithProviders(<PathInput value="" onChange={vi.fn()} />);
      const browseButton = screen.getByRole('button', { name: /browse/i });
      await userEvent.click(browseButton);
      await screen.findByRole('dialog');
      await userEvent.click(await screen.findByRole('button', { name: 'Select' }));
      await waitFor(() => {
        expect(browseButton).toHaveFocus();
      });
    });

    it('after the modal is dismissed without selection, focus returns to the Browse button', async () => {
      renderWithProviders(<PathInput value="" onChange={vi.fn()} />);
      const browseButton = screen.getByRole('button', { name: /browse/i });
      await userEvent.click(browseButton);
      await screen.findByRole('dialog');
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      await waitFor(() => {
        expect(browseButton).toHaveFocus();
      });
    });
  });
});
