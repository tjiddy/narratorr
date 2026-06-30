import { useState, useCallback } from 'react';
import type { HeldReviewItem, ImportConfirmItem, ImportMode } from '@/lib/api';
import type { ImportRow } from '@/components/manual-import';
import { toConfirmItem } from './toConfirmItem.js';

interface UseHeldReviewParams {
  /** Current review rows — held items are rebuilt from these by path so user edits carry through. */
  rows: ImportRow[];
  /**
   * Resubmit the held rows. `mode` is the snapshot captured at the original confirm
   * attempt (Manual Import passes its snapshot; Library Import passes `undefined`).
   */
  confirm: (items: ImportConfirmItem[], mode: ImportMode | undefined) => void;
}

/**
 * Shared held-review recovery state for the import surfaces (#1711 / #1732).
 *
 * When `confirmImport` returns `heldReview` items (a recording the server held
 * for review — not copied, not enqueued), the page keeps the user where they are
 * and surfaces them for re-confirm with `forceImport`. The import mode in effect
 * at the original confirm attempt is snapshotted (`heldReviewMode`) so a held Move
 * is never silently re-confirmed as Copy if the operator toggles the selector after
 * held rows appear.
 */
export function useHeldReview({ rows, confirm }: UseHeldReviewParams) {
  const [heldReview, setHeldReview] = useState<HeldReviewItem[]>([]);
  const [heldReviewMode, setHeldReviewMode] = useState<ImportMode | undefined>(undefined);

  // Record the held items plus the mode in effect at the confirm attempt.
  const captureHeld = useCallback((items: HeldReviewItem[], mode: ImportMode | undefined) => {
    setHeldReview(items);
    setHeldReviewMode(mode);
  }, []);

  // Drop stale held state (on full success, back-out, or a new scan) so a panel
  // rendered from `heldReview.length` can never show titles whose paths are gone.
  const clearHeld = useCallback(() => {
    setHeldReview([]);
    setHeldReviewMode(undefined);
  }, []);

  // Re-confirm every held-review item with forceImport, bypassing the server's
  // recording-identity safety-net. Rebuilds from the current rows by path so user
  // edits made before re-confirming are carried through, and passes the snapshot
  // mode — not any live selector value.
  const handleReconfirmHeld = useCallback(() => {
    const heldPaths = new Set(heldReview.map(h => h.path));
    const items = rows.filter(r => heldPaths.has(r.book.path)).map(r => toConfirmItem(r, true));
    if (items.length > 0) confirm(items, heldReviewMode);
  }, [heldReview, heldReviewMode, rows, confirm]);

  return { heldReview, heldReviewMode, captureHeld, clearHeld, handleReconfirmHeld };
}
