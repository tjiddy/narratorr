import { describe, it, expect } from 'vitest';
import { computeTrimmedChapterRuntime, type ChapterTrimEntry } from './chapter-trim.js';

function story(lengthMs: number, title = 'Chapter 1'): ChapterTrimEntry {
  return { title, lengthMs };
}

const HOUR_MS = 3_600_000;

describe('computeTrimmedChapterRuntime — the four measured field specimens', () => {
  // Each ordered fixture mismatches the full runtime but falls within the trimmed tolerance.
  it.each([
    {
      book: 'Addie LaRue',
      runtimeLengthMs: 86_400_000,
      chapters: [story(85_134_000), { title: 'End Credits', lengthMs: 1_266_000 }],
      scannedSeconds: 85_144,
      removed: 1,
      trimmedRuntimeMs: 85_134_000,
    },
    {
      book: 'Reckless',
      runtimeLengthMs: 74_000_000,
      chapters: [
        story(71_984_000),
        { title: 'End Credits', lengthMs: 48_000 },
        { title: 'Excerpt: Powerless (Full Cast Dramatized)', lengthMs: 1_050_000 },
        { title: 'Excerpt: Fearless: Book 3', lengthMs: 912_000 },
      ],
      scannedSeconds: 71_948,
      removed: 3,
      trimmedRuntimeMs: 71_990_000,
    },
    {
      book: 'Fearful',
      runtimeLengthMs: 55_000_000,
      chapters: [
        story(54_028_000),
        { title: 'End Credits', lengthMs: 60_000 },
        { title: 'Bonus Excerpt: Powerless (Dramatized)', lengthMs: 912_000 },
      ],
      scannedSeconds: 53_951,
      removed: 2,
      trimmedRuntimeMs: 54_028_000,
    },
    {
      book: 'Nightshade',
      runtimeLengthMs: 41_000_000,
      chapters: [
        story(40_424_000),
        { title: 'Ironwood: 1 (Preview)', lengthMs: 450_000 },
        { title: 'End Credits', lengthMs: 126_000 },
      ],
      scannedSeconds: 40_337,
      removed: 2,
      trimmedRuntimeMs: 40_424_000,
    },
  ])('$book — removes the trailing run and lands the scanned runtime back in band', (fixture) => {
    const result = computeTrimmedChapterRuntime(fixture.chapters, fixture.runtimeLengthMs);

    expect(result).toEqual({
      trimmedRuntimeMs: fixture.trimmedRuntimeMs,
      trimmedChapterCount: fixture.removed,
    });
    expect(Math.abs(fixture.scannedSeconds - fixture.runtimeLengthMs / 1000)).toBeGreaterThan(240);
    expect(Math.abs(fixture.scannedSeconds - fixture.trimmedRuntimeMs / 1000)).toBeLessThanOrEqual(240);
  });
});

describe('computeTrimmedChapterRuntime — the backward walk (pin 1)', () => {
  it('removes a single trailing match', () => {
    const result = computeTrimmedChapterRuntime(
      [story(HOUR_MS), { title: 'End Credits', lengthMs: 60_000 }],
      HOUR_MS + 60_000,
    );

    expect(result).toEqual({ trimmedRuntimeMs: HOUR_MS, trimmedChapterCount: 1 });
  });

  it('removes nothing when the LAST chapter does not match', () => {
    const result = computeTrimmedChapterRuntime(
      [story(HOUR_MS), { title: 'End Credits', lengthMs: 60_000 }, story(120_000, 'Epilogue')],
      HOUR_MS + 180_000,
    );

    expect(result).toEqual({ trimmedRuntimeMs: HOUR_MS + 180_000, trimmedChapterCount: 0 });
  });

  it('STOPS at the first non-match, leaving an earlier matching chapter untouched', () => {
    // A match-anywhere filter would incorrectly remove the earlier End Credits.
    const result = computeTrimmedChapterRuntime(
      [story(HOUR_MS), { title: 'End Credits', lengthMs: 60_000 }, story(300_000, 'Chapter 2')],
      HOUR_MS + 360_000,
    );

    expect(result.trimmedChapterCount).toBe(0);
    expect(result.trimmedRuntimeMs).toBe(HOUR_MS + 360_000);
  });

  it('no-trim invariant (AC6): entry lengths that do NOT sum to runtimeLengthMs still yield it exactly', () => {
    // Published intro/outro gaps make re-summing retained chapters incorrect.
    const result = computeTrimmedChapterRuntime([story(1_000), story(2_000)], 3_777);

    expect(result).toEqual({ trimmedRuntimeMs: 3_777, trimmedChapterCount: 0 });
  });

  it('zero-length trailing match: removed and COUNTED, with the runtime unchanged', () => {
    const result = computeTrimmedChapterRuntime(
      [story(HOUR_MS), { title: 'End Credits', lengthMs: 0 }],
      HOUR_MS,
    );

    expect(result).toEqual({ trimmedRuntimeMs: HOUR_MS, trimmedChapterCount: 1 });
  });

  it('an untrusted barrier reached AFTER removals does not roll them back', () => {
    const result = computeTrimmedChapterRuntime(
      [story(HOUR_MS), { title: 'End Credits' }, { title: 'Excerpt: Foo', lengthMs: 90_000 }],
      HOUR_MS + 150_000,
    );

    expect(result).toEqual({ trimmedRuntimeMs: HOUR_MS + 60_000, trimmedChapterCount: 1 });
  });
});

describe('computeTrimmedChapterRuntime — the trigger pattern', () => {
  it.each([
    'End Credits',
    'end credits',
    'END CREDITS',
    'Excerpt: Powerless (Full Cast Dramatized)',
    'Bonus Excerpt: Powerless (Dramatized)',
    'Ironwood: 1 (Preview)',
    'a sneak PREVIEW',
    'Also by Brandon Mull',
    'ALSO BY the same author',
    'Coming Soon from Audible',
    'coming soon',
    'bonus content',
  ])('matches %s as a case-insensitive substring', (title) => {
    const result = computeTrimmedChapterRuntime([story(HOUR_MS), { title, lengthMs: 1_000 }], HOUR_MS + 1_000);

    expect(result).toEqual({ trimmedRuntimeMs: HOUR_MS, trimmedChapterCount: 1 });
  });

  it('does NOT match "Opening Credits"', () => {
    const result = computeTrimmedChapterRuntime(
      [story(HOUR_MS), { title: 'Opening Credits', lengthMs: 21_000 }],
      HOUR_MS + 21_000,
    );

    expect(result).toEqual({ trimmedRuntimeMs: HOUR_MS + 21_000, trimmedChapterCount: 0 });
  });

  it('is not `g`-flagged — repeated calls on the same title are deterministic', () => {
    const chapters = [story(HOUR_MS), { title: 'End Credits', lengthMs: 60_000 }];

    const runs = [0, 1, 2, 3].map(() => computeTrimmedChapterRuntime(chapters, HOUR_MS + 60_000));

    expect(runs).toEqual(runs.map(() => ({ trimmedRuntimeMs: HOUR_MS, trimmedChapterCount: 1 })));
  });
});

describe('computeTrimmedChapterRuntime — untrusted trailing entries stop the walk', () => {
  it.each([
    ['lengthMs absent', { title: 'End Credits' }],
    ['lengthMs null', { title: 'End Credits', lengthMs: null }],
    ['lengthMs a string', { title: 'End Credits', lengthMs: '60000' }],
    ['lengthMs NaN', { title: 'End Credits', lengthMs: Number.NaN }],
    // JSON `1e999` can produce Infinity.
    ['lengthMs Infinity', { title: 'End Credits', lengthMs: Number.POSITIVE_INFINITY }],
    ['lengthMs negative', { title: 'End Credits', lengthMs: -1_000 }],
    ['title absent', { lengthMs: 60_000 }],
    ['title null', { title: null, lengthMs: 60_000 }],
    ['title non-string', { title: 42, lengthMs: 60_000 }],
    ['an entry that is not an object at all', 'End Credits' as unknown as ChapterTrimEntry],
  ])('%s → the walk STOPS rather than removing', (_label, trailing) => {
    const result = computeTrimmedChapterRuntime([story(HOUR_MS), trailing], HOUR_MS + 60_000);

    expect(result).toEqual({ trimmedRuntimeMs: HOUR_MS + 60_000, trimmedChapterCount: 0 });
  });
});

describe('computeTrimmedChapterRuntime — list shapes', () => {
  it('a single NON-matching story chapter removes nothing and yields runtimeLengthMs exactly', () => {
    expect(computeTrimmedChapterRuntime([story(HOUR_MS)], HOUR_MS + 5_000))
      .toEqual({ trimmedRuntimeMs: HOUR_MS + 5_000, trimmedChapterCount: 0 });
  });

  it('a single MATCHING promotional chapter consumes the whole list → NO trimmed reference', () => {
    expect(computeTrimmedChapterRuntime([{ title: 'End Credits', lengthMs: 60_000 }], HOUR_MS))
      .toEqual({ trimmedRuntimeMs: undefined, trimmedChapterCount: 1 });
  });

  it('a whole multi-chapter list that matches → NO trimmed reference, count is the full length', () => {
    const chapters = [
      { title: 'Also by Brandon Mull', lengthMs: 30_000 },
      { title: 'Excerpt: Something', lengthMs: 60_000 },
      { title: 'End Credits', lengthMs: 15_000 },
    ];

    expect(computeTrimmedChapterRuntime(chapters, HOUR_MS))
      .toEqual({ trimmedRuntimeMs: undefined, trimmedChapterCount: 3 });
  });

  it('an EMPTY chapter array removes nothing and yields runtimeLengthMs — NOT "no trimmed reference"', () => {
    expect(computeTrimmedChapterRuntime([], HOUR_MS))
      .toEqual({ trimmedRuntimeMs: HOUR_MS, trimmedChapterCount: 0 });
  });
});

describe('computeTrimmedChapterRuntime — the runtime is arithmetic, never a verdict', () => {
  it.each([
    ['absent', undefined],
    ['null', null],
  ])('runtimeLengthMs %s → no trimmed runtime, but the count still reports the walk', (_label, runtimeLengthMs) => {
    // The typeof guard prevents null coercion; the walk still reports its count.
    const result = computeTrimmedChapterRuntime(
      [story(HOUR_MS), { title: 'End Credits', lengthMs: 60_000 }],
      runtimeLengthMs,
    );

    expect(result).toEqual({ trimmedRuntimeMs: undefined, trimmedChapterCount: 1 });
  });

  it.each([
    ['zero', 0],
    ['negative', -5_000],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('a degenerate NUMERIC runtimeLengthMs (%s) rides through raw — the rule does NOT reject it', (_label, runtimeLengthMs) => {
    // Validity belongs to usableChapterSeconds, not this arithmetic rule.
    expect(computeTrimmedChapterRuntime([story(HOUR_MS)], runtimeLengthMs))
      .toEqual({ trimmedRuntimeMs: runtimeLengthMs, trimmedChapterCount: 0 });
  });

  it('a NaN runtimeLengthMs propagates as NaN (asserted with Number.isNaN, not ===)', () => {
    const result = computeTrimmedChapterRuntime([story(HOUR_MS)], Number.NaN);

    expect(Number.isNaN(result.trimmedRuntimeMs)).toBe(true);
    expect(result.trimmedChapterCount).toBe(0);
  });

  it('a valid positive runtime with no trim yields that value', () => {
    expect(computeTrimmedChapterRuntime([story(HOUR_MS)], 33_219_490))
      .toEqual({ trimmedRuntimeMs: 33_219_490, trimmedChapterCount: 0 });
  });

  it('a subtraction landing on exactly 0 is returned raw, not as "no trimmed reference"', () => {
    const result = computeTrimmedChapterRuntime(
      [story(HOUR_MS), { title: 'End Credits', lengthMs: 60_000 }],
      60_000,
    );

    expect(result).toEqual({ trimmedRuntimeMs: 0, trimmedChapterCount: 1 });
  });

  it('a subtraction landing NEGATIVE is returned raw', () => {
    const result = computeTrimmedChapterRuntime(
      [story(HOUR_MS), { title: 'End Credits', lengthMs: 60_000 }],
      10_000,
    );

    expect(result).toEqual({ trimmedRuntimeMs: -50_000, trimmedChapterCount: 1 });
  });

  it('a Σ that overflows to Infinity yields -Infinity — no finite-sum guarantee is claimed', () => {
    const result = computeTrimmedChapterRuntime(
      [
        story(HOUR_MS),
        { title: 'Excerpt: One', lengthMs: Number.MAX_VALUE },
        { title: 'Excerpt: Two', lengthMs: Number.MAX_VALUE },
      ],
      100,
    );

    expect(result).toEqual({ trimmedRuntimeMs: Number.NEGATIVE_INFINITY, trimmedChapterCount: 2 });
  });
});
