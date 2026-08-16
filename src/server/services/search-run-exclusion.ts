/**
 * Run-scoped indexer exclusion for the query ladder (#2375).
 *
 * A ladder run walks up to `MAX_SEARCH_RUNGS` relaxed queries. An indexer that failed for a
 * reason the query cannot change has nothing to gain from being asked again in that run, so it
 * is dropped from the eligible set for the remainder of it. The state lives in the executor
 * closure and dies with the run: cross-run suppression is the circuit breaker's job (#2376),
 * and the two decisions stay independent.
 */
import { classifyQueryDependence } from '@core/indexers/query-dependence.js';

/**
 * The operator-facing half of a leg that produced no results. Carried on the outcome so the
 * wording is derived once, at the branch that knows it, and both executors render the identical
 * sentence — the aggregate one has no other channel to learn it from.
 */
export interface LegReport {
  /** Already operator language; never a serialized throw. */
  reason: string;
  /** 0 marks a leg that cost no I/O at all. */
  elapsedMs: number;
}

/**
 * What a single indexer leg did, tagged where the branch already knows it. The kind is never
 * re-derived downstream from the error — three of these five reach the executor through the same
 * operator-facing string today, and message matching is exactly what this channel replaces.
 *
 * `report` is present on exactly the outcomes an operator should be told about. A cancellation
 * is not one: it has its own event, and it is the operator's own action or the search deadline.
 */
export type IndexerLegOutcome =
  | { kind: 'resolved' }
  | { kind: 'failed'; error: unknown; report: LegReport }
  | { kind: 'cancelled' }
  | { kind: 'breaker-suppressed'; report: LegReport }
  | { kind: 'policy-refused'; report: LegReport };

/** True for the outcomes carrying a `report`, narrowed so the executors can read it. */
export function reportableLeg(
  outcome: IndexerLegOutcome,
): outcome is Extract<IndexerLegOutcome, { report: LegReport }> {
  return 'report' in outcome;
}

/** The run-scoped half of a search call: both service entry points accept exactly this. */
export interface IndexerRunOptions {
  /** Filtered out before the fan-out, so an excluded indexer costs zero I/O on later rungs. */
  excludeIndexerIds?: ReadonlySet<number> | undefined;
  /** Called exactly once per leg, at the branch that already knows the outcome. */
  onOutcome?: ((indexerId: number, name: string, outcome: IndexerLegOutcome) => void) | undefined;
}

/**
 * Default-closed, and stated as a rule rather than an enumeration: a leg is excluded UNLESS it
 * resolved or falls in one of exactly three carve-outs.
 *
 * - **query-scoped failure** — the next rung's query may well succeed, which is the whole reason
 *   this is not a blanket skip.
 * - **cancelled** — the operator's own cancel, or the outer deadline; neither is the indexer's fault.
 * - **breaker-suppressed** — #2376 re-gates each rung on its own clock and may legitimately
 *   reopen mid-run; excluding it here would suppress that half-open probe.
 *
 * Any outcome added to the service later and not carved out lands on exclusion, for the same
 * reason the classifier's unknown arm does: a missed carve-out costs one indexer one run, a
 * missed exclusion reproduces the eight-fold amplification.
 */
export function excludesForRun(outcome: IndexerLegOutcome): boolean {
  switch (outcome.kind) {
    case 'resolved':
    case 'cancelled':
    case 'breaker-suppressed':
      return false;
    case 'failed':
      return classifyQueryDependence(outcome.error) === 'transport';
    default:
      return true;
  }
}

export interface RunExclusionPolicy {
  /** Pass verbatim to `searchAllWithStatus` / `searchAllStreaming`; the set is live. */
  readonly runOptions: IndexerRunOptions;
  /**
   * The accounting half of `runOptions.onOutcome`, exposed so an executor that wraps the callback
   * to add its own reporting cannot accidentally drop it.
   */
  observe(indexerId: number, name: string, outcome: IndexerLegOutcome): void;
  /**
   * AC10 — true only the first time this indexer's failure is reported in the run. The operator
   * should see "ABB failed" once, not once per rung, and that holds for a breaker skip too.
   */
  claimReport(indexerId: number): boolean;
}

export function createRunExclusionPolicy(): RunExclusionPolicy {
  const excluded = new Set<number>();
  const reported = new Set<number>();

  const observe = (indexerId: number, _name: string, outcome: IndexerLegOutcome): void => {
    if (excludesForRun(outcome)) excluded.add(indexerId);
  };

  return {
    runOptions: { excludeIndexerIds: excluded, onOutcome: observe },
    observe,
    claimReport(indexerId) {
      if (reported.has(indexerId)) return false;
      reported.add(indexerId);
      return true;
    },
  };
}
