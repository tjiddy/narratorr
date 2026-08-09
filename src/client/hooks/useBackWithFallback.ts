import { useCallback } from 'react';
import { useNavigate } from 'react-router';

// React Router's state.idx distinguishes in-app history from direct/external arrivals.
// Real back preserves page state; an initial entry uses the fallback instead.
export function useBackWithFallback(fallback: string): () => void {
  const navigate = useNavigate();
  return useCallback(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate(fallback);
  }, [navigate, fallback]);
}
