/**
 * Isolated test for replace semantics — mocks useSearchParams to capture
 * the options argument passed to setSearchParams. Separate file because
 * vi.mock is file-scoped and the main test file needs real useSearchParams.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Capture setSearchParams calls
const mockSetSearchParams = vi.fn();

vi.mock('react-router-dom', async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- vi.mock requires dynamic import
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useSearchParams: () => {
      const [params] = actual.useSearchParams();
      return [params, mockSetSearchParams] as const;
    },
  };
});

import { useLibraryFilters } from './useLibraryFilters';

function createWrapper(route = '/library') {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>;
  };
}

describe('useLibraryFilters — replace semantics (mocked setSearchParams)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockSetSearchParams.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls setSearchParams with { replace: true } on every URL sync', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper() });

    // Trigger a filter change to cause URL sync
    act(() => { result.current.actions.setStatusFilter('wanted'); });

    // setSearchParams should have been called with (URLSearchParams, { replace: true })
    expect(mockSetSearchParams).toHaveBeenCalled();

    // Every call must include { replace: true }
    for (const call of mockSetSearchParams.mock.calls) {
      const [params, options] = call;
      expect(params).toBeInstanceOf(URLSearchParams);
      expect(options).toEqual({ replace: true });
    }
  });

  it('passes correct params alongside replace option when multiple filters active', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper() });

    act(() => {
      result.current.actions.setStatusFilter('wanted');
      result.current.actions.setSortField('title');
    });

    // Get the last call (after both state changes settle)
    const lastCall = mockSetSearchParams.mock.calls.at(-1)!;
    const [params, options] = lastCall;

    expect(options).toEqual({ replace: true });
    expect(params.get('status')).toBe('wanted');
    expect(params.get('sortField')).toBe('title');
  });
});
