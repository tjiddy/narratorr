import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { PathStep } from './PathStep';
import type { FolderEntry } from './useFolderHistory.js';

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

function defaultProps(overrides: {
  scanPath?: string;
  setScanPath?: (path: string) => void;
  setScanError?: (error: string | null) => void;
  scanError?: string | null;
  handleScan?: () => void;
  isPending?: boolean;
  libraryPath?: string;
  isInsideLibraryRoot?: boolean;
  favorites?: FolderEntry[];
  recents?: FolderEntry[];
} = {}) {
  return {
    scanPath: overrides.scanPath ?? '/some/path',
    setScanPath: overrides.setScanPath ?? vi.fn(),
    setScanError: overrides.setScanError ?? vi.fn(),
    scanError: overrides.scanError ?? null,
    handleScan: overrides.handleScan ?? vi.fn(),
    isPending: overrides.isPending ?? false,
    libraryPath: overrides.libraryPath ?? '/media/audiobooks',
    isInsideLibraryRoot: overrides.isInsideLibraryRoot ?? false,
    folderHistory: {
      favorites: overrides.favorites ?? [],
      recents: overrides.recents ?? [],
      promoteToFavorite: vi.fn(),
      demoteToRecent: vi.fn(),
      removeRecent: vi.fn(),
      removeFavorite: vi.fn(),
    },
  };
}

function renderPathStep(overrides: Parameters<typeof defaultProps>[0] = {}) {
  const props = defaultProps(overrides);
  return {
    props,
    ...renderWithProviders(<PathStep {...props} />),
  };
}

describe('PathStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBrowseDirectory.mockResolvedValue({ dirs: [], parent: '/' });
  });

  describe('error clearing on path change', () => {
    it('calls setScanError(null) when path input value changes', async () => {
      const user = userEvent.setup();
      const setScanError = vi.fn();
      renderPathStep({ setScanError });

      await user.type(screen.getByRole('textbox'), 'a');

      expect(setScanError).toHaveBeenCalledWith(null);
    });
  });

  describe('fallbackBrowsePath forwarding', () => {
    it('Browse modal uses libraryPath when scanPath is empty', async () => {
      const user = userEvent.setup();
      renderPathStep({ scanPath: '', libraryPath: '/my/library' });

      await user.click(screen.getByRole('button', { name: /browse/i }));
      await screen.findByRole('dialog');

      await waitFor(() => {
        expect(mockBrowseDirectory).toHaveBeenCalledWith('/my/library');
      });
    });

    it('Browse modal falls back to "/" when both scanPath and libraryPath are empty', async () => {
      const user = userEvent.setup();
      renderPathStep({ scanPath: '', libraryPath: '' });

      await user.click(screen.getByRole('button', { name: /browse/i }));
      await screen.findByRole('dialog');

      await waitFor(() => {
        expect(mockBrowseDirectory).toHaveBeenCalledWith('/');
      });
    });
  });

  describe('Enter key scan trigger', () => {
    it('triggers handleScan when Enter is pressed in path input', async () => {
      const user = userEvent.setup();
      const handleScan = vi.fn();
      renderPathStep({ handleScan });

      await user.type(screen.getByRole('textbox'), '{Enter}');

      expect(handleScan).toHaveBeenCalled();
    });
  });

  describe('scan button disabled states', () => {
    it('disables scan button when scanPath is empty', () => {
      renderPathStep({ scanPath: '' });

      expect(screen.getByRole('button', { name: /scan$/i })).toBeDisabled();
    });

    it('disables scan button when scanPath is whitespace-only', () => {
      renderPathStep({ scanPath: '   ' });

      expect(screen.getByRole('button', { name: /scan$/i })).toBeDisabled();
    });

    it('disables scan button when isPending is true', () => {
      renderPathStep({ isPending: true });

      expect(screen.getByRole('button', { name: /scanning/i })).toBeDisabled();
    });

    it('disables scan button when isInsideLibraryRoot is true', () => {
      renderPathStep({ isInsideLibraryRoot: true });

      expect(screen.getByRole('button', { name: /scan$/i })).toBeDisabled();
    });

    it('enables scan button and calls handleScan when valid path set', async () => {
      const user = userEvent.setup();
      const handleScan = vi.fn();
      renderPathStep({ scanPath: '/valid/path', handleScan });

      const scanButton = screen.getByRole('button', { name: /scan$/i });
      expect(scanButton).toBeEnabled();

      await user.click(scanButton);

      expect(handleScan).toHaveBeenCalled();
    });
  });
});
