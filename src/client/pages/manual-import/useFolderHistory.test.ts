import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFolderHistory } from './useFolderHistory.js';
import type { FolderEntry } from './useFolderHistory.js';

const RECENT_KEY = 'narratorr:recent-folders';
const FAV_KEY = 'narratorr:favorite-folders';

function makeEntry(path: string, lastUsedAt: string): FolderEntry {
  return { path, lastUsedAt };
}

beforeEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useFolderHistory — localStorage validation', () => {
  it('falls back to empty lists when recent-folders key contains corrupted JSON', () => {
    localStorage.setItem(RECENT_KEY, '{invalid json');
    const { result } = renderHook(() => useFolderHistory());
    expect(result.current.recents).toEqual([]);
  });

  it('falls back to empty lists when favorite-folders key contains corrupted JSON', () => {
    localStorage.setItem(FAV_KEY, '{invalid json');
    const { result } = renderHook(() => useFolderHistory());
    expect(result.current.favorites).toEqual([]);
  });

  it('skips entries with missing path field on parse', () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify([
      { lastUsedAt: '2026-01-01T00:00:00.000Z' }, // missing path
      { path: '/valid', lastUsedAt: '2026-01-02T00:00:00.000Z' },
    ]));
    const { result } = renderHook(() => useFolderHistory());
    expect(result.current.recents).toHaveLength(1);
    expect(result.current.recents[0].path).toBe('/valid');
  });

  it('skips entries with missing lastUsedAt field on parse (prevents sort crash)', () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify([
      { path: '/bad' }, // missing lastUsedAt
      { path: '/valid', lastUsedAt: '2026-01-02T00:00:00.000Z' },
    ]));
    const { result } = renderHook(() => useFolderHistory());
    expect(result.current.recents).toHaveLength(1);
    expect(result.current.recents[0].path).toBe('/valid');
  });

  it('does not crash when localStorage.setItem throws QuotaExceededError', () => {
    const { result } = renderHook(() => useFolderHistory());
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    expect(() => {
      act(() => { result.current.addRecent('/audiobooks'); });
    }).not.toThrow();
    // State still updates in memory
    expect(result.current.recents).toHaveLength(1);
    expect(result.current.recents[0].path).toBe('/audiobooks');
  });
});

describe('useFolderHistory — addRecent', () => {
  it('adds a new path to recent folders with current ISO timestamp', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-05T12:00:00.000Z'));
    const { result } = renderHook(() => useFolderHistory());
    act(() => { result.current.addRecent('/audiobooks'); });
    expect(result.current.recents).toHaveLength(1);
    expect(result.current.recents[0]).toEqual({ path: '/audiobooks', lastUsedAt: '2026-03-05T12:00:00.000Z' });
  });

  it('moves an existing path to top of recents with updated timestamp, no duplicate', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    localStorage.setItem(RECENT_KEY, JSON.stringify([
      makeEntry('/audiobooks', '2026-01-01T00:00:00.000Z'),
      makeEntry('/podcasts', '2026-01-02T00:00:00.000Z'),
    ]));
    vi.setSystemTime(new Date('2026-03-05T12:00:00.000Z'));
    const { result } = renderHook(() => useFolderHistory());
    act(() => { result.current.addRecent('/audiobooks'); });
    expect(result.current.recents).toHaveLength(2);
    expect(result.current.recents[0].path).toBe('/audiobooks');
    expect(result.current.recents[0].lastUsedAt).toBe('2026-03-05T12:00:00.000Z');
    expect(result.current.recents[1].path).toBe('/podcasts');
  });

  it('evicts the oldest lastUsedAt entry when cap of 15 is exceeded', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const existing: FolderEntry[] = Array.from({ length: 15 }, (_, i) => ({
      path: `/folder${i}`,
      lastUsedAt: new Date(2026, 0, i + 1).toISOString(),
    }));
    localStorage.setItem(RECENT_KEY, JSON.stringify(existing));
    vi.setSystemTime(new Date('2026-03-05T12:00:00.000Z'));
    const { result } = renderHook(() => useFolderHistory());
    act(() => { result.current.addRecent('/new-folder'); });
    expect(result.current.recents).toHaveLength(15);
    expect(result.current.recents[0].path).toBe('/new-folder');
    // Oldest was /folder0 (Jan 1) — should be evicted
    expect(result.current.recents.every(e => e.path !== '/folder0')).toBe(true);
  });

  it('adds a favorited path to recents (scan history is orthogonal to favorites)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    localStorage.setItem(FAV_KEY, JSON.stringify([makeEntry('/audiobooks', '2026-01-01T00:00:00.000Z')]));
    vi.setSystemTime(new Date('2026-03-05T12:00:00.000Z'));
    const { result } = renderHook(() => useFolderHistory());
    act(() => { result.current.addRecent('/audiobooks'); });
    expect(result.current.recents).toHaveLength(1);
    expect(result.current.recents[0].path).toBe('/audiobooks');
    expect(result.current.favorites).toHaveLength(1); // unchanged
    expect(result.current.favorites[0].lastUsedAt).toBe('2026-01-01T00:00:00.000Z'); // not overwritten
  });
});

describe('useFolderHistory — promoteToFavorite', () => {
  it('moves full entry (including lastUsedAt) from recents to favorites', () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify([makeEntry('/audiobooks', '2026-01-01T00:00:00.000Z')]));
    const { result } = renderHook(() => useFolderHistory());
    act(() => { result.current.promoteToFavorite('/audiobooks'); });
    expect(result.current.favorites).toHaveLength(1);
    expect(result.current.favorites[0]).toEqual({ path: '/audiobooks', lastUsedAt: '2026-01-01T00:00:00.000Z' });
    expect(result.current.recents).toHaveLength(0);
  });

  it('removes the recent entry after promotion', () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify([
      makeEntry('/audiobooks', '2026-01-01T00:00:00.000Z'),
      makeEntry('/podcasts', '2026-01-02T00:00:00.000Z'),
    ]));
    const { result } = renderHook(() => useFolderHistory());
    act(() => { result.current.promoteToFavorite('/audiobooks'); });
    expect(result.current.recents).toHaveLength(1);
    expect(result.current.recents[0].path).toBe('/podcasts');
  });

  it('persists favorites to localStorage after promotion', () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify([makeEntry('/audiobooks', '2026-01-01T00:00:00.000Z')]));
    const { result } = renderHook(() => useFolderHistory());
    act(() => { result.current.promoteToFavorite('/audiobooks'); });
    const stored = JSON.parse(localStorage.getItem(FAV_KEY) ?? '[]') as FolderEntry[];
    expect(stored).toHaveLength(1);
    expect(stored[0].path).toBe('/audiobooks');
  });

  it('removes the recent copy when path is already in favorites (no duplicate, no timestamp overwrite)', () => {
    const favEntry = makeEntry('/audiobooks', '2026-01-01T00:00:00.000Z');
    const recentEntry = makeEntry('/audiobooks', '2026-03-01T00:00:00.000Z');
    localStorage.setItem(FAV_KEY, JSON.stringify([favEntry]));
    localStorage.setItem(RECENT_KEY, JSON.stringify([recentEntry]));
    const { result } = renderHook(() => useFolderHistory());
    act(() => { result.current.promoteToFavorite('/audiobooks'); });
    expect(result.current.recents).toHaveLength(0); // recent copy removed
    expect(result.current.favorites).toHaveLength(1); // only one favorite
    expect(result.current.favorites[0].lastUsedAt).toBe('2026-01-01T00:00:00.000Z'); // NOT overwritten
  });
});

describe('useFolderHistory — demoteToRecent', () => {
  it('moves full entry (including lastUsedAt) from favorites to recents', () => {
    localStorage.setItem(FAV_KEY, JSON.stringify([makeEntry('/audiobooks', '2026-01-01T00:00:00.000Z')]));
    const { result } = renderHook(() => useFolderHistory());
    act(() => { result.current.demoteToRecent('/audiobooks'); });
    expect(result.current.recents).toHaveLength(1);
    expect(result.current.recents[0]).toEqual({ path: '/audiobooks', lastUsedAt: '2026-01-01T00:00:00.000Z' });
    expect(result.current.favorites).toHaveLength(0);
  });

  it('removes the favorite entry after demotion', () => {
    localStorage.setItem(FAV_KEY, JSON.stringify([
      makeEntry('/audiobooks', '2026-01-01T00:00:00.000Z'),
      makeEntry('/podcasts', '2026-01-02T00:00:00.000Z'),
    ]));
    const { result } = renderHook(() => useFolderHistory());
    act(() => { result.current.demoteToRecent('/audiobooks'); });
    expect(result.current.favorites).toHaveLength(1);
    expect(result.current.favorites[0].path).toBe('/podcasts');
  });

  it('persists recents to localStorage after demotion', () => {
    localStorage.setItem(FAV_KEY, JSON.stringify([makeEntry('/audiobooks', '2026-01-01T00:00:00.000Z')]));
    const { result } = renderHook(() => useFolderHistory());
    act(() => { result.current.demoteToRecent('/audiobooks'); });
    const stored = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as FolderEntry[];
    expect(stored).toHaveLength(1);
    expect(stored[0].path).toBe('/audiobooks');
  });

  it('keeps single recent entry with max(favorite.lastUsedAt, recent.lastUsedAt) when path already exists in recents', () => {
    const favEntry = makeEntry('/audiobooks', '2026-03-01T00:00:00.000Z'); // newer
    const recentEntry = makeEntry('/audiobooks', '2026-01-01T00:00:00.000Z'); // older
    localStorage.setItem(FAV_KEY, JSON.stringify([favEntry]));
    localStorage.setItem(RECENT_KEY, JSON.stringify([recentEntry]));
    const { result } = renderHook(() => useFolderHistory());
    act(() => { result.current.demoteToRecent('/audiobooks'); });
    expect(result.current.favorites).toHaveLength(0);
    expect(result.current.recents).toHaveLength(1);
    expect(result.current.recents[0].lastUsedAt).toBe('2026-03-01T00:00:00.000Z'); // max kept
  });

  it('re-sorts recents by lastUsedAt descending after demotion collision', () => {
    const favEntry = makeEntry('/a', '2026-01-15T00:00:00.000Z');
    const existingRecents: FolderEntry[] = [
      makeEntry('/b', '2026-01-20T00:00:00.000Z'),
      makeEntry('/a', '2026-01-10T00:00:00.000Z'), // older than fav
      makeEntry('/c', '2026-01-05T00:00:00.000Z'),
    ];
    localStorage.setItem(FAV_KEY, JSON.stringify([favEntry]));
    localStorage.setItem(RECENT_KEY, JSON.stringify(existingRecents));
    const { result } = renderHook(() => useFolderHistory());
    act(() => { result.current.demoteToRecent('/a'); });
    expect(result.current.recents[0].path).toBe('/b'); // Jan 20
    expect(result.current.recents[1].path).toBe('/a'); // Jan 15 (fav timestamp wins)
    expect(result.current.recents[2].path).toBe('/c'); // Jan 5
  });
});

  it('enforces the 15-entry cap when demoting a favorite into a full recents list', () => {
    const fullRecents: FolderEntry[] = Array.from({ length: 15 }, (_, i) => ({
      path: `/folder${i}`,
      lastUsedAt: new Date(2026, 0, i + 1).toISOString(),
    }));
    const favEntry = makeEntry('/new-from-fav', '2026-03-01T00:00:00.000Z');
    localStorage.setItem(RECENT_KEY, JSON.stringify(fullRecents));
    localStorage.setItem(FAV_KEY, JSON.stringify([favEntry]));
    const { result } = renderHook(() => useFolderHistory());
    act(() => { result.current.demoteToRecent('/new-from-fav'); });
    expect(result.current.recents).toHaveLength(15);
    expect(result.current.recents[0].path).toBe('/new-from-fav'); // newest at top
    expect(result.current.recents.some(e => e.path === '/folder0')).toBe(false); // oldest evicted
  });

describe('useFolderHistory — removeRecent / removeFavorite', () => {
  it('removes a recent entry, does not affect favorites', () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify([
      makeEntry('/audiobooks', '2026-01-01T00:00:00.000Z'),
      makeEntry('/podcasts', '2026-01-02T00:00:00.000Z'),
    ]));
    localStorage.setItem(FAV_KEY, JSON.stringify([makeEntry('/audiobooks', '2026-01-01T00:00:00.000Z')]));
    const { result } = renderHook(() => useFolderHistory());
    act(() => { result.current.removeRecent('/audiobooks'); });
    expect(result.current.recents).toHaveLength(1);
    expect(result.current.recents[0].path).toBe('/podcasts');
    expect(result.current.favorites).toHaveLength(1); // unchanged
  });

  it('removes a favorite entry, does not affect recents', () => {
    localStorage.setItem(FAV_KEY, JSON.stringify([
      makeEntry('/audiobooks', '2026-01-01T00:00:00.000Z'),
      makeEntry('/podcasts', '2026-01-02T00:00:00.000Z'),
    ]));
    localStorage.setItem(RECENT_KEY, JSON.stringify([makeEntry('/audiobooks', '2026-01-01T00:00:00.000Z')]));
    const { result } = renderHook(() => useFolderHistory());
    act(() => { result.current.removeFavorite('/audiobooks'); });
    expect(result.current.favorites).toHaveLength(1);
    expect(result.current.favorites[0].path).toBe('/podcasts');
    expect(result.current.recents).toHaveLength(1); // unchanged
  });
});


describe('useFolderHistory — persistence', () => {
  it('recents persist across hook remounts (reads from localStorage on init)', () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify([
      makeEntry('/b', '2026-01-20T00:00:00.000Z'),
      makeEntry('/a', '2026-01-10T00:00:00.000Z'),
    ]));
    const { result } = renderHook(() => useFolderHistory());
    expect(result.current.recents).toHaveLength(2);
    expect(result.current.recents[0].path).toBe('/b');
  });

  it('favorites persist across hook remounts (reads from localStorage on init)', () => {
    localStorage.setItem(FAV_KEY, JSON.stringify([makeEntry('/audiobooks', '2026-01-01T00:00:00.000Z')]));
    const { result } = renderHook(() => useFolderHistory());
    expect(result.current.favorites).toHaveLength(1);
    expect(result.current.favorites[0].path).toBe('/audiobooks');
  });

  it('recents are sorted by lastUsedAt descending on initial load', () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify([
      makeEntry('/a', '2026-01-01T00:00:00.000Z'), // oldest
      makeEntry('/c', '2026-03-01T00:00:00.000Z'), // newest
      makeEntry('/b', '2026-02-01T00:00:00.000Z'),
    ]));
    const { result } = renderHook(() => useFolderHistory());
    expect(result.current.recents[0].path).toBe('/c');
    expect(result.current.recents[1].path).toBe('/b');
    expect(result.current.recents[2].path).toBe('/a');
  });
});
