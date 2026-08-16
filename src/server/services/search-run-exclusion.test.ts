/**
 * AC17's rule as a unit: default-closed accounting with exactly three carve-outs, plus the
 * report-once ledger AC10 needs. The executors compose these; nothing here touches I/O.
 */
import { describe, expect, it } from 'vitest';
import {
  createRunExclusionPolicy,
  excludesForRun,
  reportableLeg,
  type IndexerLegOutcome,
} from './search-run-exclusion.js';
import { IndexerError } from '@core/indexers/errors.js';
import { httpStatusError } from '@core/indexers/errors.js';

const TRANSPORT = Object.assign(new Error('Connection refused on port 443'), { code: 'ECONNREFUSED' });
const REFUSED_REPORT = { reason: 'Connection refused on port 443', elapsedMs: 12 };

/** Every failure the operator is told about carries its wording; the kind is what decides policy. */
function failed(error: unknown): IndexerLegOutcome {
  return { kind: 'failed', error, report: REFUSED_REPORT };
}

describe('#2375 AC17 — excludesForRun', () => {
  const ROWS: Array<{ name: string; outcome: IndexerLegOutcome; expected: boolean }> = [
    { name: 'resolved successfully', outcome: { kind: 'resolved' }, expected: false },
    { name: 'transport failure', outcome: failed(TRANSPORT), expected: true },
    { name: 'query-scoped failure (structural 400)', outcome: failed(httpStatusError(400, 'Bad Request')), expected: false },
    { name: 'query-scoped failure (response validation)', outcome: failed(new IndexerError('Torznab', 'bad JSON')), expected: false },
    { name: 'cancelled', outcome: { kind: 'cancelled' }, expected: false },
    { name: 'breaker-suppressed', outcome: { kind: 'breaker-suppressed', report: REFUSED_REPORT }, expected: false },
    { name: 'policy-refused', outcome: { kind: 'policy-refused', report: REFUSED_REPORT }, expected: true },
  ];

  it.each(ROWS)('excludes $name: $expected', ({ outcome, expected }) => {
    expect(excludesForRun(outcome)).toBe(expected);
  });

  /**
   * The rule is total by construction, not by the table happening to be complete. This is the
   * observation that would have caught the policy-refusal omission: a leg outcome the service
   * grows later and nobody carves out must land on exclusion, not on eligibility.
   */
  it('excludes a leg outcome that matches no carve-out at all', () => {
    const future = { kind: 'quota-exhausted' } as unknown as IndexerLegOutcome;

    expect(excludesForRun(future)).toBe(true);
  });
});

/** The executors render an operator event from exactly these, and from nothing else. */
describe('#2375 AC10 — reportableLeg', () => {
  const ROWS: Array<{ name: string; outcome: IndexerLegOutcome; expected: boolean }> = [
    { name: 'a genuine failure', outcome: failed(TRANSPORT), expected: true },
    { name: 'a breaker suppression', outcome: { kind: 'breaker-suppressed', report: REFUSED_REPORT }, expected: true },
    { name: 'a policy refusal', outcome: { kind: 'policy-refused', report: REFUSED_REPORT }, expected: true },
    { name: 'a success', outcome: { kind: 'resolved' }, expected: false },
    // Cancellation has its own event and is the operator's own doing; it is not an error.
    { name: 'a cancellation', outcome: { kind: 'cancelled' }, expected: false },
  ];

  it.each(ROWS)('reports $name: $expected', ({ outcome, expected }) => {
    expect(reportableLeg(outcome)).toBe(expected);
  });

  it('carries the wording and elapsed time the sink renders', () => {
    const outcome = failed(TRANSPORT);

    expect(reportableLeg(outcome) && outcome.report).toEqual({ reason: 'Connection refused on port 443', elapsedMs: 12 });
  });
});

describe('#2375 — the run policy', () => {
  it('starts with nothing excluded', () => {
    const policy = createRunExclusionPolicy();

    expect([...policy.runOptions.excludeIndexerIds!]).toEqual([]);
  });

  it('exposes a live set, so a rung reads exclusions recorded during the previous one', () => {
    const policy = createRunExclusionPolicy();
    const set = policy.runOptions.excludeIndexerIds!;

    policy.runOptions.onOutcome!(7, 'ABB', failed(TRANSPORT));

    expect([...set]).toEqual([7]);
  });

  it('keeps a query-scoped failure eligible while excluding a transport failure in the same rung', () => {
    const policy = createRunExclusionPolicy();

    policy.runOptions.onOutcome!(1, 'Torznab', failed(httpStatusError(400, 'Bad Request')));
    policy.runOptions.onOutcome!(2, 'ABB', failed(TRANSPORT));
    policy.runOptions.onOutcome!(3, 'Newznab', { kind: 'resolved' });

    expect([...policy.runOptions.excludeIndexerIds!]).toEqual([2]);
  });

  it('never re-admits an indexer excluded earlier in the run, whatever it reports later', () => {
    const policy = createRunExclusionPolicy();

    policy.runOptions.onOutcome!(2, 'ABB', failed(TRANSPORT));
    policy.runOptions.onOutcome!(2, 'ABB', { kind: 'resolved' });

    expect([...policy.runOptions.excludeIndexerIds!]).toEqual([2]);
  });

  it('claims the report slot once per indexer and refuses every repeat', () => {
    const policy = createRunExclusionPolicy();

    expect(policy.claimReport(1)).toBe(true);
    expect(policy.claimReport(1)).toBe(false);
    expect(policy.claimReport(1)).toBe(false);
  });

  it('tracks the report slot per indexer, not per run', () => {
    const policy = createRunExclusionPolicy();

    expect(policy.claimReport(1)).toBe(true);
    expect(policy.claimReport(2)).toBe(true);
    expect(policy.claimReport(1)).toBe(false);
  });

  it('exposes the accounting half separately, so a wrapping executor cannot drop it', () => {
    const policy = createRunExclusionPolicy();

    policy.observe(2, 'ABB', failed(TRANSPORT));

    expect([...policy.runOptions.excludeIndexerIds!]).toEqual([2]);
  });

  it('scopes both ledgers to the policy instance', () => {
    const first = createRunExclusionPolicy();
    first.runOptions.onOutcome!(2, 'ABB', failed(TRANSPORT));
    first.claimReport(2);

    const second = createRunExclusionPolicy();

    expect([...second.runOptions.excludeIndexerIds!]).toEqual([]);
    expect(second.claimReport(2)).toBe(true);
  });
});
