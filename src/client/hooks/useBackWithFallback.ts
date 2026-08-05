import { useCallback } from 'react';
import { useNavigate } from 'react-router';

/**
 * Browser-back when in-app history exists, a real navigation to `fallback` when it
 * doesn't. React Router stamps every history entry it creates with `state.idx`
 * (0 for the first entry in the tab, surviving reloads), so a deep link — or an
 * arrival from an external site — has nothing useful behind it and `navigate(-1)`
 * would dead-end or leave the app. In-app arrivals keep plain browser back, which
 * is what preserves the library page's filters and scroll.
 */
export function useBackWithFallback(fallback: string): () => void {
  const navigate = useNavigate();
  return useCallback(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate(fallback);
  }, [navigate, fallback]);
}
