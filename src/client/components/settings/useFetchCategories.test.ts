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

function makeOptions(overrides: { clientId?: number; isDirty?: boolean } = {}) {
  return {
    ...(overrides.clientId !== undefined && { clientId: overrides.clientId }),
    ...(overrides.isDirty !== undefined && { isDirty: overrides.isDirty }),
    getValues: mockGetValues as never,
  };
}

describe('useFetchCategories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('successful fetch in create-mode (no clientId) routes to getClientCategoriesFromConfig and exposes categories + showDropdown', async () => {
    (downloadClientsApi.getClientCategoriesFromConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      categories: ['audiobooks', 'movies'],
    });

    const { result } = renderHook((props) => useFetchCategories(props), { initialProps: makeOptions() });

    await act(async () => {
      await result.current.fetchCategories();
    });

    expect(downloadClientsApi.getClientCategoriesFromConfig).toHaveBeenCalledTimes(1);
    expect(downloadClientsApi.getClientCategories).not.toHaveBeenCalled();
    expect(result.current.categories).toEqual(['audiobooks', 'movies']);
    expect(result.current.showDropdown).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('successful fetch in clean edit-mode (clientId set, isDirty=false) routes to getClientCategories(clientId)', async () => {
    (downloadClientsApi.getClientCategories as ReturnType<typeof vi.fn>).mockResolvedValue({
      categories: ['tv', 'movies'],
    });

    const { result } = renderHook(
      (props) => useFetchCategories(props),
      { initialProps: makeOptions({ clientId: 5, isDirty: false }) },
    );

    await act(async () => {
      await result.current.fetchCategories();
    });

    expect(downloadClientsApi.getClientCategories).toHaveBeenCalledWith(5);
    expect(downloadClientsApi.getClientCategoriesFromConfig).not.toHaveBeenCalled();
    expect(result.current.categories).toEqual(['tv', 'movies']);
    expect(result.current.showDropdown).toBe(true);
  });

  // #844 — id forwarding for sentinel resolution
  it('forwards clientId as id when editing a dirty client (isDirty=true)', async () => {
    (downloadClientsApi.getClientCategoriesFromConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      categories: ['audiobooks'],
    });

    const { result } = renderHook(
      (props) => useFetchCategories(props),
      { initialProps: makeOptions({ clientId: 7, isDirty: true }) },
    );

    await act(async () => {
      await result.current.fetchCategories();
    });

    expect(downloadClientsApi.getClientCategoriesFromConfig).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7 }),
    );
  });

  it('omits id on the create-mode path (no clientId)', async () => {
    (downloadClientsApi.getClientCategoriesFromConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      categories: ['audiobooks'],
    });

    const { result } = renderHook((props) => useFetchCategories(props), { initialProps: makeOptions() });

    await act(async () => {
      await result.current.fetchCategories();
    });

    const call = (downloadClientsApi.getClientCategoriesFromConfig as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call).not.toHaveProperty('id');
  });

  it('sets error, clears categories, and hides dropdown when fetch returns an error', async () => {
    (downloadClientsApi.getClientCategoriesFromConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      categories: [],
      error: 'Connection failed',
    });

    const { result } = renderHook((props) => useFetchCategories(props), { initialProps: makeOptions() });

    await act(async () => {
      await result.current.fetchCategories();
    });

    expect(result.current.error).toBe('Connection failed');
    expect(result.current.categories).toEqual([]);
    expect(result.current.showDropdown).toBe(false);
  });

  it('sets error, clears categories, and hides dropdown when fetch rejects (getErrorMessage path)', async () => {
    (downloadClientsApi.getClientCategoriesFromConfig as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Network error'),
    );

    const { result } = renderHook((props) => useFetchCategories(props), { initialProps: makeOptions() });

    await act(async () => {
      await result.current.fetchCategories();
    });

    expect(result.current.error).toBe('Network error');
    expect(result.current.categories).toEqual([]);
    expect(result.current.showDropdown).toBe(false);
    expect(result.current.fetching).toBe(false);
  });
});
