import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { PathStep } from './PathStep';
import type { FolderEntry } from './useFolderHistory.js';

let capturedProps: Record<string, unknown> = {};

vi.mock('@/components/PathInput', () => ({
  PathInput: (props: Record<string, unknown>) => {
    capturedProps = props;
    return (
      <input
        data-testid="path-input"
        value={props.value as string}
        onChange={(e) => (props.onChange as (v: string) => void)?.(e.target.value)}
        onKeyDown={props.onKeyDown as React.KeyboardEventHandler<HTMLInputElement>}
        placeholder={props.placeholder as string}
      />
    );
  },
}));

function defaultProps(overrides: Partial<{
  scanPath: string;
  setScanPath: (path: string) => void;
  setScanError: (error: string | null) => void;
  scanError: string | null;
  handleScan: () => void;
  isPending: boolean;
  libraryPath: string;
  isInsideLibraryRoot: boolean;
  favorites: FolderEntry[];
  recents: FolderEntry[];
}> = {}) {
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
    ...render(
      <MemoryRouter>
        <PathStep {...props} />
      </MemoryRouter>,
    ),
  };
}

describe('PathStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedProps = {};
  });

  describe('error clearing on path change', () => {
    it('calls setScanError(null) when path input value changes', async () => {
      const user = userEvent.setup();
      const setScanError = vi.fn();
      renderPathStep({ setScanError });

      await user.type(screen.getByTestId('path-input'), 'a');

      expect(setScanError).toHaveBeenCalledWith(null);
    });
  });

  describe('fallbackBrowsePath forwarding', () => {
    it('forwards libraryPath as fallbackBrowsePath to PathInput', () => {
      renderPathStep({ libraryPath: '/my/library' });

      expect(capturedProps.fallbackBrowsePath).toBe('/my/library');
    });

    it('forwards "/" as fallbackBrowsePath when libraryPath is empty', () => {
      renderPathStep({ libraryPath: '' });

      expect(capturedProps.fallbackBrowsePath).toBe('/');
    });
  });

  describe('Enter key scan trigger', () => {
    it('triggers handleScan when Enter is pressed in path input', async () => {
      const user = userEvent.setup();
      const handleScan = vi.fn();
      renderPathStep({ handleScan });

      await user.type(screen.getByTestId('path-input'), '{Enter}');

      expect(handleScan).toHaveBeenCalled();
    });
  });

  describe('scan button disabled states', () => {
    it('disables scan button when scanPath is empty', () => {
      renderPathStep({ scanPath: '' });

      expect(screen.getByRole('button', { name: /scan/i })).toBeDisabled();
    });

    it('disables scan button when scanPath is whitespace-only', () => {
      renderPathStep({ scanPath: '   ' });

      expect(screen.getByRole('button', { name: /scan/i })).toBeDisabled();
    });

    it('disables scan button when isPending is true', () => {
      renderPathStep({ isPending: true });

      expect(screen.getByRole('button', { name: /scanning/i })).toBeDisabled();
    });

    it('disables scan button when isInsideLibraryRoot is true', () => {
      renderPathStep({ isInsideLibraryRoot: true });

      expect(screen.getByRole('button', { name: /scan/i })).toBeDisabled();
    });

    it('enables scan button and calls handleScan when valid path set', async () => {
      const user = userEvent.setup();
      const handleScan = vi.fn();
      renderPathStep({ scanPath: '/valid/path', handleScan });

      const scanButton = screen.getByRole('button', { name: /scan/i });
      expect(scanButton).toBeEnabled();

      await user.click(scanButton);

      expect(handleScan).toHaveBeenCalled();
    });
  });
});
