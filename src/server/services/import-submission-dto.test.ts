import { describe, expect, it } from 'vitest';
import { REPORT_ITEM_COLUMNS, reportRowToDto, type ReportItemRow } from './import-submission-dto.js';
import { stagedItemResultDtoSchema } from '@core/import-staging/schemas.js';

function skippedRow(overrides: Partial<ReportItemRow> = {}): ReportItemRow {
  return {
    disposition: 'skipped',
    ordinal: 0,
    path: '/library/Robin Hobb/Realms of the Elderlings/02 - Royal Assassin',
    title: 'Royal Assassin',
    reason: 'already-in-library',
    existingBookId: null,
    existingTitle: null,
    existingPath: null,
    bookId: null,
    ...overrides,
  };
}

describe('reportRowToDto — skip reason validation (#2091 AC16)', () => {
  it('preserves duplicate-copy-at-other-path instead of flattening it to already-in-library', () => {
    const dto = reportRowToDto(skippedRow({
      reason: 'duplicate-copy-at-other-path',
      existingBookId: 7,
      existingTitle: 'Royal Assassin',
      existingPath: '/library/Robin Hobb/Farseer Trilogy/02 - Royal Assassin',
    }));

    expect(dto).toEqual({
      disposition: 'skipped',
      ordinal: 0,
      path: '/library/Robin Hobb/Realms of the Elderlings/02 - Royal Assassin',
      title: 'Royal Assassin',
      reason: 'duplicate-copy-at-other-path',
      existingBookId: 7,
      existingTitle: 'Royal Assassin',
      existingPath: '/library/Robin Hobb/Farseer Trilogy/02 - Royal Assassin',
    });
    // The wire union is strict; a shape it rejects would 500 the report route.
    expect(stagedItemResultDtoSchema.safeParse(dto).success).toBe(true);
  });

  it('preserves already-importing', () => {
    expect(reportRowToDto(skippedRow({ reason: 'already-importing' }))).toMatchObject({ reason: 'already-importing' });
  });

  it.each([
    ['NULL', null],
    ['empty', ''],
    ['an unrecognized legacy spelling', 'duplicate'],
    ['a whitespace-padded reason', ' already-importing '],
  ])('falls back to already-in-library for %s', (_label, reason) => {
    const dto = reportRowToDto(skippedRow({ reason }));
    expect(dto).toMatchObject({ disposition: 'skipped', reason: 'already-in-library' });
    expect(stagedItemResultDtoSchema.safeParse(dto).success).toBe(true);
  });
});

describe('reportRowToDto — incumbent field matrix (#2091 AC18)', () => {
  // Each of the three incumbent facts is independently lost when the book is deleted or the row
  // predates the column, so the DTO must emit each key only when its own value survives.
  const present = { existingBookId: 7, existingTitle: 'Royal Assassin', existingPath: '/library/A/B' };
  const combinations = [0, 1, 2, 3, 4, 5, 6, 7].map((mask) => ({
    ...(mask & 1 ? { existingBookId: present.existingBookId } : { existingBookId: null }),
    ...(mask & 2 ? { existingTitle: present.existingTitle } : { existingTitle: null }),
    ...(mask & 4 ? { existingPath: present.existingPath } : { existingPath: null }),
  }));

  it.each(combinations)('renders %o without crashing and omits absent keys', (fields) => {
    const dto = reportRowToDto(skippedRow({ reason: 'duplicate-copy-at-other-path', ...fields }));

    for (const key of ['existingBookId', 'existingTitle', 'existingPath'] as const) {
      if (fields[key] == null) expect(dto).not.toHaveProperty(key);
      else expect(dto).toHaveProperty(key, fields[key]);
    }
    expect(stagedItemResultDtoSchema.safeParse(dto).success).toBe(true);
  });
});

describe('reportRowToDto — non-skipped dispositions reject the new column (#2091 AC17)', () => {
  it.each([
    ['accepted', { disposition: 'accepted' as const, bookId: 12 }],
    ['held', { disposition: 'held' as const, reason: 'recording-review-required' }],
    ['failed', { disposition: 'failed' as const, reason: 'boom' }],
    ['pending', { disposition: 'pending' as const, reason: null }],
  ])('never emits existingPath on a %s row', (_label, overrides) => {
    const dto = reportRowToDto(skippedRow({ existingPath: '/library/A/B', ...overrides }));

    expect(dto).not.toHaveProperty('existingPath');
    expect(stagedItemResultDtoSchema.safeParse(dto).success).toBe(true);
  });
});

describe('REPORT_ITEM_COLUMNS', () => {
  it('declares existing_path so the report projection actually reads it', () => {
    expect(REPORT_ITEM_COLUMNS).toContain('existingPath');
  });
});
