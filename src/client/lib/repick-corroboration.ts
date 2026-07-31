import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react';
import { api, type MatchResult, type BookMetadata } from '@/lib/api';
import type { ImportRow } from '@/components/manual-import/types.js';
import type { DurationCorroborationBody } from '@shared/schemas/library-scan.js';
import { upgradeMatchConfidence, promoteMatchToHigh } from './upgrade-match-confidence.js';

/**
 * Chapter-runtime corroboration for the import editor's re-pick path (#2055) — shared by
 * BOTH import surfaces (`useLibraryImport`, `useManualImport`) so the behaviour cannot
 * drift into two copies, the way the twin hooks have before (#1374).
 *
 * The problem: `upgradeMatchConfidence` judges a re-picked edition against the provider's
 * `runtimeLengthMin` SCALAR. For a small slice of the catalog that scalar understates the
 * edition's OWN chapter table by minutes (the live case: Fablehaven Book 1 / `B00CXXEX8W`,
 * scalar 539min vs a 553.66min chapter table that matches the scanned file to 0.02s), so a
 * user who re-picks the CORRECT edition still gets "Duration mismatch". The match job
 * already corroborates against the chapter table (#1942); this module gives the client path
 * the same quality of answer.
 *
 * Shape: the SYNC verdict renders immediately (optimistic), a request goes out only for the
 * one outcome it can change, and a corroborated answer patches the row when it arrives.
 * Suppress-only — the response can promote medium → high and nothing else.
 */

/**
 * The request body for one qualifying re-pick, as a domain-named alias of the canonical
 * Zod-inferred route contract — NOT a parallel declaration. The shared schema stays the one
 * source of truth, so a change to the route body is a compile error here rather than a
 * request the server rejects at runtime.
 *
 * `asin` is already TRIMMED by the time it lands in one of these — see
 * {@link needsChapterCorroboration}'s canonical-value rule.
 */
export type CorroborationRequest = DurationCorroborationBody;

/** A dispatched request plus everything the staleness guard re-checks on arrival. */
export interface CorroborationTarget {
  /** `row.book.path` — the established row key on both surfaces. */
  path: string;
  /** `ImportRow.matchGeneration` captured at dispatch time. */
  generation: number;
  request: CorroborationRequest;
}

/**
 * Decide whether a re-pick is worth a chapter-runtime second opinion, and return the
 * request payload when it is.
 *
 * Mirrors #1942's laziness rule exactly (`corroborateDurationVerdict` fires only for
 * `duration-mismatch` + a non-empty ASIN): a non-qualifying re-pick issues ZERO requests.
 * Only outcome (4) of the synchronous re-evaluation — still medium, still
 * `duration-mismatch` — can be changed by chapter data. The in-band clear, both
 * `missing-duration` cannot-verify outcomes, the `no-duration-data`/legacy clear,
 * `none → medium`, a `high` row, and the by-reference no-op all return `undefined`.
 *
 * **The canonical ASIN is the TRIMMED value.** `BookMetadata.asin` is a plain optional
 * string with no whitespace normalization, so the trimmed value returned here is the ONE
 * string that goes in the request body, gets captured on the target, and is compared
 * against `row.edited.metadata?.asin?.trim()` on arrival. A raw-vs-trimmed comparison
 * anywhere in this path would silently discard a successful corroboration for an ASIN this
 * predicate explicitly admits.
 */
export function needsChapterCorroboration(
  matchResult: MatchResult | undefined,
  newMetadata: BookMetadata | undefined,
  currentEditedMetadata: BookMetadata | undefined,
): CorroborationRequest | undefined {
  if (!matchResult || !newMetadata) return undefined;
  // By-reference no-op: the modal handed the pre-populated bestMatch straight back, which
  // is not a re-pick at all (#1929's by-reference contract).
  if (newMetadata === currentEditedMetadata) return undefined;
  // `none → medium` and `high` rows never re-evaluate duration evidence.
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
 * Staleness guard (B8) — the generation token AND every evidence field must still agree.
 *
 * The field checks alone do not identify a logical row generation: Restart clears only
 * `matchResult`, and `mergeMatchIntoRow` preserves `edited` for a `userEdited` row, so a
 * fresh match can reproduce the same path + ASIN + `scannedSeconds` + `duration-mismatch`.
 * Without the token a held response would promote a row the user did not just re-pick.
 * Both generations must be defined numbers; an undefined stamp on either side rejects.
 */
function isLiveTarget(row: ImportRow, target: CorroborationTarget): boolean {
  const match = row.matchResult;
  if (!match) return false;
  if (typeof row.matchGeneration !== 'number' || typeof target.generation !== 'number') return false;
  if (row.matchGeneration !== target.generation) return false;
  if (match.confidence !== 'medium') return false;
  if (match.reasonKind !== 'duration-mismatch') return false;
  // Both sides trim — the canonical-value rule from `needsChapterCorroboration`.
  if (row.edited.metadata?.asin?.trim() !== target.request.asin) return false;
  // Exact numeric equality on the RAW unrounded scanner value; it is never rounded or
  // re-derived anywhere in this path.
  if (match.scannedSeconds !== target.request.scannedSeconds) return false;
  return true;
}

/**
 * Apply a `corroborated: true` verdict to the one row that asked for it.
 *
 * Pure and suppress-only: it promotes exactly one medium `duration-mismatch` row to high
 * through the SAME {@link promoteMatchToHigh} the synchronous in-band clear uses, and
 * returns the original array untouched when nothing matches — so an unrelated row, a
 * demotion, and an `alternatives`/`bestMatch` change are all unrepresentable here.
 */
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

export interface RepickCorroboration {
  /** The next `ImportRow.matchGeneration` stamp. Monotonic for the hook's lifetime. */
  nextGeneration: () => number;
  /** Fire the request and patch the row if it is still the live target when it lands. */
  dispatchCorroboration: (target: CorroborationTarget) => void;
}

/**
 * Own the per-hook generation counter and the request → patch round trip.
 *
 * The counter is a `useRef` seeded at 0 that is ONLY ever incremented — it never resets, so
 * a re-scan that rebuilds a row for the same folder path cannot reuse a value a held
 * request already captured. Call `nextGeneration()` OUTSIDE a `setRows` updater and reuse
 * the one value inside it: React 19 StrictMode double-invokes updater functions, so
 * incrementing in there would stamp a different value than the dispatch captured.
 *
 * The response handler carries NO lifecycle-local side effect — no toast, no banner, no
 * navigation, no unrelated `setState`. The patch is a pure `setRows`, which is what makes a
 * settle after unmount harmless and why no separate mounted-ref guard is needed
 * (`react-query-mutation-callbacks-post-unmount`: a post-unmount callback must not assume a
 * live component). A `corroborated: false`, a non-2xx, and a network/parse failure are all
 * the same outcome — leave the row exactly as the synchronous verdict left it (B6).
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
        // Silent by contract: no toast, no banner, no thrown error. The scalar-rendered
        // Review reason the user already sees stays the truthful answer.
      });
  }, [setRows]);

  return { nextGeneration, dispatchCorroboration };
}
