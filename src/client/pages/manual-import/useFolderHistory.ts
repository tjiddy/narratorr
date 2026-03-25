import { useState, useCallback } from 'react';

export type FolderEntry = { path: string; lastUsedAt: string };

const RECENT_KEY = 'narratorr:recent-folders';
const FAV_KEY = 'narratorr:favorite-folders';
const MAX_RECENTS = 15;

function readStorage(key: string): FolderEntry[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is FolderEntry =>
        typeof (e as FolderEntry)?.path === 'string' &&
        typeof (e as FolderEntry)?.lastUsedAt === 'string',
    );
  } catch {
    return [];
  }
}

function writeStorage(key: string, entries: FolderEntry[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(entries));
  } catch {
    // quota exceeded or storage unavailable — noop
  }
}

function sortByRecency(entries: FolderEntry[]): FolderEntry[] {
  return [...entries].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
}

export function useFolderHistory() {
  const [recents, setRecents] = useState<FolderEntry[]>(() =>
    sortByRecency(readStorage(RECENT_KEY)),
  );
  const [favorites, setFavorites] = useState<FolderEntry[]>(() => readStorage(FAV_KEY));

  const addRecent = useCallback((path: string) => {
    setRecents(prev => {
      const now = new Date().toISOString();
      const filtered = prev.filter(e => e.path !== path);
      const updated = sortByRecency([{ path, lastUsedAt: now }, ...filtered]);
      const capped = updated.slice(0, MAX_RECENTS);
      writeStorage(RECENT_KEY, capped);
      return capped;
    });
  }, []);

  const promoteToFavorite = useCallback((path: string) => {
    setRecents(prev => {
      const entry = prev.find(e => e.path === path);
      const newRecents = prev.filter(e => e.path !== path);
      writeStorage(RECENT_KEY, newRecents);

      setFavorites(prevFavs => {
        const alreadyFavorited = prevFavs.some(e => e.path === path);
        if (alreadyFavorited) {
          // Just remove the recent copy — keep existing favorite unchanged
          return prevFavs;
        }
        const toAdd = entry ?? { path, lastUsedAt: new Date().toISOString() };
        const newFavs = [...prevFavs, toAdd];
        writeStorage(FAV_KEY, newFavs);
        return newFavs;
      });

      return newRecents;
    });
  }, []);

  const demoteToRecent = useCallback((path: string) => {
    setFavorites(prev => {
      const entry = prev.find(e => e.path === path);
      const newFavs = prev.filter(e => e.path !== path);
      writeStorage(FAV_KEY, newFavs);

      setRecents(prevRecents => {
        const existing = prevRecents.find(e => e.path === path);
        let newRecents: FolderEntry[];
        if (existing) {
          // Keep max timestamp, re-sort
          const favLastUsed = entry?.lastUsedAt ?? new Date().toISOString();
          const maxTime = favLastUsed > existing.lastUsedAt ? favLastUsed : existing.lastUsedAt;
          const others = prevRecents.filter(e => e.path !== path);
          newRecents = sortByRecency([{ path, lastUsedAt: maxTime }, ...others]);
        } else {
          const toAdd = entry ?? { path, lastUsedAt: new Date().toISOString() };
          newRecents = sortByRecency([toAdd, ...prevRecents]).slice(0, MAX_RECENTS);
        }
        writeStorage(RECENT_KEY, newRecents);
        return newRecents;
      });

      return newFavs;
    });
  }, []);

  const removeRecent = useCallback((path: string) => {
    setRecents(prev => {
      const updated = prev.filter(e => e.path !== path);
      writeStorage(RECENT_KEY, updated);
      return updated;
    });
  }, []);

  const removeFavorite = useCallback((path: string) => {
    setFavorites(prev => {
      const updated = prev.filter(e => e.path !== path);
      writeStorage(FAV_KEY, updated);
      return updated;
    });
  }, []);

  const seedLibraryRoot = useCallback((libraryPath: string) => {
    if (!libraryPath) return;
    setFavorites(prev => {
      if (prev.length > 0) return prev; // idempotent — don't re-seed
      const entry: FolderEntry = { path: libraryPath, lastUsedAt: new Date().toISOString() };
      writeStorage(FAV_KEY, [entry]);
      return [entry];
    });
  }, []);

  return {
    recents,
    favorites,
    addRecent,
    promoteToFavorite,
    demoteToRecent,
    removeRecent,
    removeFavorite,
    seedLibraryRoot,
  };
}
