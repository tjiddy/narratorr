import { useState, useCallback } from 'react';
import type { HeldReviewItem, ImportConfirmItem, ImportMode } from '@/lib/api';
import type { ImportRow } from '@/components/manual-import';
import { toConfirmItem } from './toConfirmItem.js';

interface UseHeldReviewParams {
  /** Current rows, used to carry edits into held-item retries. */
  rows: ImportRow[];
  /** Resubmits with the mode captured at the original attempt. */
  confirm: (items: ImportConfirmItem[], mode: ImportMode | undefined) => void;
}

// Snapshotting the mode prevents a later selector change from altering a held retry's
// Move/Copy semantics.
export function useHeldReview({ rows, confirm }: UseHeldReviewParams) {
  const [heldReview, setHeldReview] = useState<HeldReviewItem[]>([]);
  const [heldReviewMode, setHeldReviewMode] = useState<ImportMode | undefined>(undefined);

  const captureHeld = useCallback((items: HeldReviewItem[], mode: ImportMode | undefined) => {
    setHeldReview(items);
    setHeldReviewMode(mode);
  }, []);

  // Prevent stale titles from surviving success, back-out, or a rescan.
  const clearHeld = useCallback(() => {
    setHeldReview([]);
    setHeldReviewMode(undefined);
  }, []);

  // Rebuild from current rows to carry edits; use the captured mode, never the live selector.
  const handleReconfirmHeld = useCallback(() => {
    const heldPaths = new Set(heldReview.map(h => h.path));
    const items = rows.filter(r => heldPaths.has(r.book.path)).map(r => toConfirmItem(r, true));
    if (items.length > 0) confirm(items, heldReviewMode);
  }, [heldReview, heldReviewMode, rows, confirm]);

  return { heldReview, heldReviewMode, captureHeld, clearHeld, handleReconfirmHeld };
}
