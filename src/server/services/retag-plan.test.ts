import { describe, it, expect } from 'vitest';
import { SIMPLE_EXCLUDABLE_FIELDS, hasTagChanges, planFile } from './retag-plan.js';
import { RETAG_EXCLUDABLE_FIELDS } from '@shared/schemas.js';

describe('retag-plan SIMPLE_EXCLUDABLE_FIELDS', () => {
  // Numeric seriesPart/track are special-cased; every other field must match the shared set.
  it('plus the special-cased seriesPart/track covers exactly the shared RETAG_EXCLUDABLE_FIELDS set', () => {
    expect(new Set([...SIMPLE_EXCLUDABLE_FIELDS, 'seriesPart', 'track'])).toEqual(
      new Set(RETAG_EXCLUDABLE_FIELDS),
    );
  });
});

// Passing `existingTags` keeps these off the filesystem: no parseFile, and no cover means no readFile.
describe('planFile change detection', () => {
  const desired = { artist: 'A', album: 'B', track: 2, trackTotal: 5 };

  it('overwrite: a file already carrying every value plans as skip-unchanged', async () => {
    await expect(planFile('/b/ch02.mp3', desired, 'overwrite', undefined, { artist: 'A', album: 'B', track: 2, trackTotal: 5 }))
      .resolves.toEqual({ file: 'ch02.mp3', outcome: 'skip-unchanged' });
  });

  it('overwrite: one differing field is will-tag, with every row flagged individually', async () => {
    const plan = await planFile('/b/ch02.mp3', desired, 'overwrite', undefined, { artist: 'A', album: 'Old', track: 2, trackTotal: 5 });

    expect(plan).toEqual({
      file: 'ch02.mp3',
      outcome: 'will-tag',
      coverPending: false,
      diff: [
        { field: 'artist', current: 'A', next: 'A', changed: false },
        { field: 'album', current: 'Old', next: 'B', changed: true },
        { field: 'track', current: '2/5', next: '2/5', changed: false },
      ],
    });
  });

  it('the track row compares the full n/total pair, so a file missing the total is a change', async () => {
    const plan = await planFile('/b/ch02.mp3', { track: 2, trackTotal: 5 }, 'overwrite', undefined, { track: 2 });

    expect(plan.outcome).toBe('will-tag');
    expect(plan.diff).toEqual([{ field: 'track', current: '2', next: '2/5', changed: true }]);
  });

  it('seriesPart compares as text, so a numeric read of "3" matches position 3', async () => {
    await expect(planFile('/b/book.m4b', { seriesPart: 3 }, 'overwrite', undefined, { seriesPart: 3 }))
      .resolves.toEqual({ file: 'book.m4b', outcome: 'skip-unchanged' });
  });

  it('overwrite with nothing requested is skip-populated, not skip-unchanged', async () => {
    await expect(planFile('/b/x.mp3', {}, 'overwrite', undefined, { artist: 'A' }))
      .resolves.toEqual({ file: 'x.mp3', outcome: 'skip-populated' });
  });

  it('populate_missing rows are always changes: only absent fields are resolved', async () => {
    const plan = await planFile('/b/x.mp3', { artist: 'A', album: 'B' }, 'populate_missing', undefined, { album: 'B' });

    expect(plan.outcome).toBe('will-tag');
    expect(plan.diff).toEqual([{ field: 'artist', current: null, next: 'A', changed: true }]);
  });
});

describe('hasTagChanges', () => {
  it('is false when every requested field already matches, numeric fields included', () => {
    expect(hasTagChanges({ artist: 'A', seriesPart: 2, track: 1, trackTotal: 3 }, { artist: 'A', seriesPart: 2, track: 1, trackTotal: 3 })).toBe(false);
  });

  it('is true when a requested field is absent from the file or holds another value', () => {
    expect(hasTagChanges({ artist: 'A' }, {})).toBe(true);
    expect(hasTagChanges({ artist: 'A' }, { artist: 'B' })).toBe(true);
  });
});
