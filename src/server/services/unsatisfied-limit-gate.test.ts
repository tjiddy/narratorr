import { describe, it, expect } from 'vitest';
import type { SearchResult } from '@core/index.js';
import { buildQueryLadder, type Rung } from './search-query-ladder.js';
import { applyUnsatisfiedLimitGate } from './unsatisfied-limit-gate.js';

// Real rungs, so the gate is judged against the production floor policy rather than a stand-in.
const LADDER = buildQueryLadder({ title: 'The Churn: An Expanse Novella', author: 'James S. A. Corey' });
const FULL_RUNG: Rung = LADDER[0]!;
const CUT_RUNG: Rung = LADDER.find((r) => r.floorSegments.length > 0)!;

const FLOOR_PASSING = 'The Churn: An Expanse Novella';
const FLOOR_FAILING = 'The Churn (Unabridged) [M4B]';

const AT_LIMIT = { count: 150, limit: 150 };
const BELOW_LIMIT = { count: 149, limit: 150 };

// Custom overrides type, not Partial<T>: under exactOptionalPropertyTypes a caller cannot pass
// an explicit `undefined` to strip a default (the in-repo standard, see MakeResultOverrides).
type ResultOverrides = { [K in keyof SearchResult]?: SearchResult[K] | undefined };

function result(overrides: ResultOverrides = {}): SearchResult {
  const built: SearchResult = {
    title: FLOOR_PASSING,
    protocol: 'torrent',
    indexer: 'MAM',
    downloadUrl: 'magnet:?xt=urn:btih:aaa',
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete (built as unknown as Record<string, unknown>)[key];
    else (built as unknown as Record<string, unknown>)[key] = value;
  }
  return built;
}

describe('applyUnsatisfiedLimitGate — AC7 causality table', () => {
  it('proceeds unchanged when the selector would grab a release that is not at the limit', () => {
    const best = result({ indexer: 'Prowlarr', title: 'Best' });
    const gate = applyUnsatisfiedLimitGate([best, result({ unsatisfied: AT_LIMIT })], FULL_RUNG);

    expect(gate).toEqual({ kind: 'proceed', selection: { kind: 'grab', result: best } });
  });

  it('falls through to the best remaining release when one survives removal', () => {
    const mam = result({ title: 'MAM Best', unsatisfied: AT_LIMIT });
    const other = result({ indexer: 'Prowlarr', title: 'Prowlarr Second' });

    const gate = applyUnsatisfiedLimitGate([mam, other], FULL_RUNG);

    expect(gate).toEqual({ kind: 'proceed', selection: { kind: 'grab', result: other } });
  });

  it('blocks when removal leaves nothing selectable', () => {
    const mam = result({ title: 'MAM Only', unsatisfied: AT_LIMIT });

    expect(applyUnsatisfiedLimitGate([mam], FULL_RUNG)).toEqual({ kind: 'blocked', result: mam });
  });

  it('blocks when removal leaves only releases the segment floor holds', () => {
    const mam = result({ title: FLOOR_PASSING, unsatisfied: AT_LIMIT });
    const remainder = result({ indexer: 'Prowlarr', title: FLOOR_FAILING });

    const gate = applyUnsatisfiedLimitGate([mam, remainder], CUT_RUNG);

    expect(gate).toEqual({ kind: 'blocked', result: mam });
  });

  it('reports the pre-existing hold when the floor, not the limit, stopped the grab', () => {
    const mam = result({ title: FLOOR_FAILING, unsatisfied: AT_LIMIT });

    const gate = applyUnsatisfiedLimitGate([mam], CUT_RUNG);

    expect(gate).toEqual({ kind: 'proceed', selection: { kind: 'hold', releaseTitle: FLOOR_FAILING } });
  });

  it('reports the pre-existing none when nothing was selectable to begin with', () => {
    const gate = applyUnsatisfiedLimitGate([result({ downloadUrl: undefined, unsatisfied: AT_LIMIT })], FULL_RUNG);

    expect(gate).toEqual({ kind: 'proceed', selection: { kind: 'none' } });
  });
});

describe('applyUnsatisfiedLimitGate — link eligibility follows the selector', () => {
  it('never blocks on an at-limit release with no download link', () => {
    const unlinked = result({ title: 'Unlinked', downloadUrl: undefined, unsatisfied: AT_LIMIT });

    expect(applyUnsatisfiedLimitGate([unlinked], FULL_RUNG)).toEqual({ kind: 'proceed', selection: { kind: 'none' } });
  });

  it('never blocks on an at-limit release whose link is the empty string', () => {
    const unlinked = result({ title: 'Unlinked', downloadUrl: '', unsatisfied: AT_LIMIT });

    expect(applyUnsatisfiedLimitGate([unlinked], FULL_RUNG)).toEqual({ kind: 'proceed', selection: { kind: 'none' } });
  });

  it('grabs the lower-ranked non-MAM release when the top at-limit release is unlinked', () => {
    const unlinked = result({ title: 'Unlinked', downloadUrl: undefined, unsatisfied: AT_LIMIT });
    const other = result({ indexer: 'Prowlarr', title: 'Grabbable' });

    expect(applyUnsatisfiedLimitGate([unlinked, other], FULL_RUNG))
      .toEqual({ kind: 'proceed', selection: { kind: 'grab', result: other } });
  });

  it('names the linked at-limit release when a higher-ranked at-limit release is unlinked', () => {
    const unlinked = result({ title: 'Unlinked', downloadUrl: undefined, unsatisfied: AT_LIMIT });
    const linked = result({ title: 'Linked', unsatisfied: AT_LIMIT });

    expect(applyUnsatisfiedLimitGate([unlinked, linked], FULL_RUNG)).toEqual({ kind: 'blocked', result: linked });
  });
});

describe('applyUnsatisfiedLimitGate — attribution across MAM accounts (#2322 F6)', () => {
  it('names the release the selector would have grabbed, not merely the first blocked one', () => {
    const failsFloor = result({ title: FLOOR_FAILING, indexer: 'MAM A', unsatisfied: { count: 200, limit: 200 } });
    const passesFloor = result({ title: FLOOR_PASSING, indexer: 'MAM B', unsatisfied: AT_LIMIT });

    const gate = applyUnsatisfiedLimitGate([failsFloor, passesFloor], CUT_RUNG);

    expect(gate).toEqual({ kind: 'blocked', result: passesFloor });
  });

  it('names the top eligible release on a full rung when two accounts are both at the limit', () => {
    const first = result({ title: 'From MAM A', indexer: 'MAM A', unsatisfied: { count: 300, limit: 250 } });
    const second = result({ title: 'From MAM B', indexer: 'MAM B', unsatisfied: AT_LIMIT });

    expect(applyUnsatisfiedLimitGate([first, second], FULL_RUNG)).toEqual({ kind: 'blocked', result: first });
  });
});

describe('applyUnsatisfiedLimitGate — boundaries and fail-open', () => {
  const grabbing: Array<{ name: string; unsatisfied: SearchResult['unsatisfied'] }> = [
    { name: 'nothing observed', unsatisfied: undefined },
    { name: 'one below the limit', unsatisfied: BELOW_LIMIT },
    { name: 'a fresh account at zero', unsatisfied: { count: 0, limit: 150 } },
  ];

  for (const { name, unsatisfied } of grabbing) {
    it(`grabs normally with ${name}`, () => {
      const only = result({ ...(unsatisfied !== undefined && { unsatisfied }) });

      expect(applyUnsatisfiedLimitGate([only], FULL_RUNG))
        .toEqual({ kind: 'proceed', selection: { kind: 'grab', result: only } });
    });
  }

  it('blocks one past the limit', () => {
    const only = result({ unsatisfied: { count: 151, limit: 150 } });

    expect(applyUnsatisfiedLimitGate([only], FULL_RUNG)).toEqual({ kind: 'blocked', result: only });
  });

  it('leaves an empty ranked list to the pre-existing none outcome', () => {
    expect(applyUnsatisfiedLimitGate([], FULL_RUNG)).toEqual({ kind: 'proceed', selection: { kind: 'none' } });
  });

  it('is inert on a full rung, where the second selector call collapses to the link test', () => {
    const mam = result({ title: FLOOR_PASSING, unsatisfied: AT_LIMIT });
    const remainder = result({ indexer: 'Prowlarr', title: FLOOR_FAILING });

    // The floor is what turns this fixture into a block; without one the remainder is simply grabbed.
    expect(applyUnsatisfiedLimitGate([mam, remainder], FULL_RUNG))
      .toEqual({ kind: 'proceed', selection: { kind: 'grab', result: remainder } });
    expect(applyUnsatisfiedLimitGate([mam, remainder], CUT_RUNG)).toEqual({ kind: 'blocked', result: mam });
  });
});
