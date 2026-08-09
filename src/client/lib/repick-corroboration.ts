import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react';
import { api, type MatchResult, type BookMetadata } from '@/lib/api';
import type { ImportRow } from '@/components/manual-import/types.js';
import type { DurationCorroborationBody } from '@shared/schemas/library-scan.js';
import { upgradeMatchConfidence, promoteMatchToHigh } from './upgrade-match-confidence.js';

/**
 * Provider scalar runtimes can disagree with their chapter totals, so qualifying re-picks ask
 * for chapter evidence. Shared by both import flows; responses can only promote the same live row.
 */

/** Domain alias of the shared route contract; its ASIN is already trimmed. */
export type CorroborationRequest = DurationCorroborationBody;

/** A dispatched request plus everything the staleness guard rechecks on arrival. */
export interface CorroborationTarget {
  path: string;
  generation: number;
  request: CorroborationRequest;
}

/**
 * Requests chapter evidence only when re-evaluation remains a medium duration mismatch with
 * scan seconds and a trimmed ASIN. Other outcomes cannot benefit from a second opinion.
 */
export function needsChapterCorroboration(
  matchResult: MatchResult | undefined,
  newMetadata: BookMetadata | undefined,
  currentEditedMetadata: BookMetadata | undefined,
): CorroborationRequest | undefined {
  if (!matchResult || !newMetadata) return undefined;
  // Returning the pre-populated metadata object is not a re-pick.
  if (newMetadata === currentEditedMetadata) return undefined;
  if (matchResult.confidence !== 'medium') return undefined;

  const upgraded = upgradeMatchConfidence(matchResult, newMetadata, currentEditedMetadata);
  if (upgraded?.confidence !== 'medium' || upgraded.reasonKind !== 'duration-mismatch') return undefined;

  const scannedSeconds = upgraded.scannedSeconds;
  if (scannedSeconds == null || scannedSeconds <= 0) return undefined;

  const asin = newMetadata.asin?.trim();
  if (!asin) return undefined;

  return { asin, scannedSeconds };
}

/**
 * Requires generation and evidence to match: a restarted row can recreate identical fields
 * while an older request remains pending.
 */
function isLiveTarget(row: ImportRow, target: CorroborationTarget): boolean {
  const match = row.matchResult;
  if (!match) return false;
  if (typeof row.matchGeneration !== 'number' || typeof target.generation !== 'number') return false;
  if (row.matchGeneration !== target.generation) return false;
  if (match.confidence !== 'medium') return false;
  if (match.reasonKind !== 'duration-mismatch') return false;
  // Both sides use the trimmed canonical ASIN from `needsChapterCorroboration`.
  if (row.edited.metadata?.asin?.trim() !== target.request.asin) return false;
  // Compare exact raw scanner seconds; this path never rounds or re-derives them.
  if (match.scannedSeconds !== target.request.scannedSeconds) return false;
  return true;
}

/** Promotes only the matching live medium mismatch and preserves the original array on no-op. */
export function applyCorroboration(rows: ImportRow[], target: CorroborationTarget): ImportRow[] {
  let patched = false;
  const next = rows.map((row) => {
    if (row.book.path !== target.path) return row;
    if (!isLiveTarget(row, target)) return row;
    patched = true;
    return { ...row, matchResult: promoteMatchToHigh(row.matchResult!) };
  });
  return patched ? next : rows;
}

/**
 * Stamps rows after `matchResult` is installed, replaced, or cleared. A custom lint rule requires
 * constructed writes in both hooks to use this seam; terminal corroboration patches do not.
 */
export function stampRow(row: ImportRow, generation: number): ImportRow {
  return { ...row, matchGeneration: generation };
}

export interface RepickCorroboration {
  nextGeneration: () => number;
  dispatchCorroboration: (target: CorroborationTarget) => void;
}

/**
 * Owns a monotonic generation and silent request round trip. Call `nextGeneration()` outside
 * `setRows`, whose updater React StrictMode may invoke twice. Responses perform only a pure row
 * patch, so post-unmount settlement is harmless; failures preserve the synchronous verdict.
 */
export function useRepickCorroboration(setRows: Dispatch<SetStateAction<ImportRow[]>>): RepickCorroboration {
  const generationRef = useRef(0);

  const nextGeneration = useCallback(() => {
    generationRef.current += 1;
    return generationRef.current;
  }, []);

  const dispatchCorroboration = useCallback((target: CorroborationTarget) => {
    void api.corroborateImportDuration(target.request)
      .then((result) => {
        if (!result.corroborated) return;
        setRows((prev) => applyCorroboration(prev, target));
      })
      .catch(() => {
        // Silent: keep the synchronous scalar verdict.
      });
  }, [setRows]);

  return { nextGeneration, dispatchCorroboration };
}
