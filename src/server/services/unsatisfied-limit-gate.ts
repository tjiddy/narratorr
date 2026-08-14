/**
 * Removes at-limit MAM releases from an already-ranked candidate list, and decides whether the
 * limit is what actually stopped the grab.
 *
 * Causality is answered by running the production selector twice rather than by re-deriving its
 * eligibility rules: `selectRelaxedCandidate` applies a truthy-link test and, on a cut rung, the
 * segment floor, and any approximation of that population desynchronizes the moment it grows a
 * third test. The limit is the reason only when the selector would have taken an at-limit release
 * and cannot take anything without it. Pure: callers own the event and the grab.
 */
import type { SearchResult } from '@core/index.js';
import { isResultAtUnsatisfiedLimit, type UnsatisfiedStatus } from '@core/utils/mam-unsatisfied.js';
import { selectRelaxedCandidate, type RelaxedSelection, type Rung } from './search-query-ladder.js';

export type BlockedRelease = SearchResult & { unsatisfied: UnsatisfiedStatus };

export type UnsatisfiedLimitGate =
  | { kind: 'proceed'; selection: RelaxedSelection }
  /** The release the selector would have grabbed; the event names it and reads its counts. */
  | { kind: 'blocked'; result: BlockedRelease };

export function applyUnsatisfiedLimitGate(ranked: SearchResult[], rung: Rung): UnsatisfiedLimitGate {
  const before = selectRelaxedCandidate(ranked, rung);
  if (before.kind !== 'grab') return { kind: 'proceed', selection: before };

  const blocked = before.result;
  if (!isResultAtUnsatisfiedLimit(blocked)) return { kind: 'proceed', selection: before };

  const after = selectRelaxedCandidate(ranked.filter((r) => !isResultAtUnsatisfiedLimit(r)), rung);
  // A surviving grab means the limit cost a preference, not the grab — that is not worth an event.
  if (after.kind === 'grab') return { kind: 'proceed', selection: after };
  return { kind: 'blocked', result: blocked };
}
