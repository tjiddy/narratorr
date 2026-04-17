import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFetchCategories } from './useFetchCategories';

vi.mock('@/lib/api/download-clients', () => ({
  downloadClientsApi: {
    getClientCategories: vi.fn(),
    getClientCategoriesFromConfig: vi.fn(),
  },
}));

import { downloadClientsApi } from '@/lib/api/download-clients';

const mockGetValues = vi.fn().mockReturnValue({
  name: 'Test',
  type: 'qbittorrent',
  enabled: true,
  priority: 50,
  settings: { host: 'localhost', port: 8080 },
});

function makeOptions(overrides: { selectedType?: string; clientId?: number; isDirty?: boolean } = {}) {
  return {
    selectedType: overrides.selectedType ?? 'qbittorrent',
    clientId: overrides.clientId,
    isDirty: overrides.isDirty,
    getValues: mockGetValues as never,
  };
}

describe('useFetchCategories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('selectedType reset effect', () => {
    it('clears categories array when selectedType changes', async () => {
      (downloadClientsApi.getClientCategoriesFromConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        categories: ['audiobooks', 'movies'],
      });

      const { result, rerender } = renderHook(
        (props) => useFetchCategories(props),
        { initialProps: makeOptions() },
      );

      await act(async () => {
        await result.current.fetchCategories();
      });

      expect(result.current.categories).toEqual(['audiobooks', 'movies']);

      rerender(makeOptions({ selectedType: 'sabnzbd' }));

      expect(result.current.categories).toEqual([]);
    });

    it('clears error to null when selectedType changes', async () => {
      (downloadClientsApi.getClientCategoriesFromConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        categories: [],
        error: 'Connection failed',
      });

      const { result, rerender } = renderHook(
        (props) => useFetchCategories(props),
        { initialProps: makeOptions() },
      );

      await act(async () => {
        await result.current.fetchCategories();
      });

      expect(result.current.error).toBe('Connection failed');

      rerender(makeOptions({ selectedType: 'sabnzbd' }));

      expect(result.current.error).toBeNull();
    });

    it('hides dropdown when selectedType changes', async () => {
      (downloadClientsApi.getClientCategoriesFromConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        categories: ['audiobooks'],
      });

      const { result, rerender } = renderHook(
        (props) => useFetchCategories(props),
        { initialProps: makeOptions() },
      );

      await act(async () => {
        await result.current.fetchCategories();
      });

      expect(result.current.showDropdown).toBe(true);

      rerender(makeOptions({ selectedType: 'sabnzbd' }));

      expect(result.current.showDropdown).toBe(false);
    });

    it('sets error, clears categories, and hides dropdown when fetch rejects', async () => {
      (downloadClientsApi.getClientCategoriesFromConfig as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Network error'),
      );

      const { result } = renderHook(
        (props) => useFetchCategories(props),
        { initialProps: makeOptions() },
      );

      await act(async () => {
        await result.current.fetchCategories();
      });

      expect(result.current.error).toBe('Network error');
      expect(result.current.categories).toEqual([]);
      expect(result.current.showDropdown).toBe(false);
      expect(result.current.fetching).toBe(false);
    });

    it('clears previously fetched categories when selectedType changes', async () => {
      (downloadClientsApi.getClientCategories as ReturnType<typeof vi.fn>).mockResolvedValue({
        categories: ['tv', 'movies', 'audiobooks'],
      });

      const { result, rerender } = renderHook(
        (props) => useFetchCategories(props),
        { initialProps: makeOptions({ clientId: 5, isDirty: false }) },
      );

      await act(async () => {
        await result.current.fetchCategories();
      });

      expect(result.current.categories).toEqual(['tv', 'movies', 'audiobooks']);
      expect(result.current.showDropdown).toBe(true);
      expect(result.current.error).toBeNull();

      rerender(makeOptions({ selectedType: 'transmission', clientId: 5, isDirty: false }));

      expect(result.current.categories).toEqual([]);
      expect(result.current.showDropdown).toBe(false);
      expect(result.current.error).toBeNull();
    });
  });
});
