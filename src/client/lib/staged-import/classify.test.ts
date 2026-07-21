import { describe, it, expect } from 'vitest';
import type { ImportConfirmItem } from '@/lib/api';
import { MAX_SINGLE_ITEM_BYTES } from '@/lib/confirm-chunks.js';
import { classifySubmission } from './classify.js';

const valid = (path: string, title = 'T'): ImportConfirmItem => ({
  path,
  title,
  metadata: { title, authors: [{ name: 'Author' }] } as ImportConfirmItem['metadata'],
});

/** Attach an out-of-bound metadata field to a valid row to force a specific parse failure. */
const withMeta = (path: string, meta: Record<string, unknown>): ImportConfirmItem => ({
  path,
  title: 'T',
  metadata: { title: 'T', authors: [{ name: 'Author' }], ...meta } as ImportConfirmItem['metadata'],
});

describe('classifySubmission — oversize (purely too large)', () => {
  it('classifies a 513-char author name as oversize', () => {
    const r = classifySubmission([withMeta('/a', { authors: [{ name: 'a'.repeat(513) }] })]);
    expect(r.oversizeCount).toBe(1);
    expect(r.invalidCount).toBe(0);
    expect(r.survivors).toHaveLength(0);
  });
  it('classifies a string-array element length overflow (129-char genre) as oversize', () => {
    const r = classifySubmission([withMeta('/a', { genres: ['g'.repeat(129)] })]);
    expect(r.oversizeCount).toBe(1);
    expect(r.invalidCount).toBe(0);
  });
  it('classifies array-count overflow (65 authors) as oversize', () => {
    const r = classifySubmission([withMeta('/a', { authors: Array.from({ length: 65 }, () => ({ name: 'a' })) })]);
    expect(r.oversizeCount).toBe(1);
  });
  it('classifies array-count overflow (65 genres) as oversize', () => {
    const r = classifySubmission([withMeta('/a', { genres: Array.from({ length: 65 }, () => 'g') })]);
    expect(r.oversizeCount).toBe(1);
  });
  it('classifies a byte-oversize row (valid but > MAX_SINGLE_ITEM_BYTES via unbounded path) as oversize', () => {
    const huge = valid('/'.padEnd(MAX_SINGLE_ITEM_BYTES + 10, 'x'));
    const r = classifySubmission([huge]);
    expect(r.oversizeCount).toBe(1);
    expect(r.survivors).toHaveLength(0);
  });
});

describe('classifySubmission — invalid (structurally wrong)', () => {
  it('classifies an invalid URL as invalid', () => {
    const r = classifySubmission([withMeta('/a', { coverUrl: 'not a url' })]);
    expect(r.invalidCount).toBe(1);
    expect(r.oversizeCount).toBe(0);
  });
  it('classifies a non-finite number as invalid', () => {
    const r = classifySubmission([withMeta('/a', { duration: Infinity })]);
    expect(r.invalidCount).toBe(1);
  });
  it('classifies empty-after-trim title as invalid (too_small)', () => {
    const r = classifySubmission([{ path: '/a', title: '   ', metadata: { title: 'T', authors: [{ name: 'A' }] } as ImportConfirmItem['metadata'] }]);
    expect(r.invalidCount).toBe(1);
  });
  it('classifies an unknown metadata key as invalid (unrecognized_keys)', () => {
    const r = classifySubmission([withMeta('/a', { bogusKey: 1 })]);
    expect(r.invalidCount).toBe(1);
  });
  it('classifies a mixed too_big + unknown-key row as invalid (structurally wrong, not merely large)', () => {
    const r = classifySubmission([withMeta('/a', { bogusKey: 1, authors: [{ name: 'a'.repeat(513) }] })]);
    expect(r.invalidCount).toBe(1);
    expect(r.oversizeCount).toBe(0);
  });
});

describe('classifySubmission — survivors, compaction, normalization', () => {
  it('normalizes (trims) survivor fields to the parse output', () => {
    const r = classifySubmission([{
      path: '  /a  ',
      title: '  Title  ',
      metadata: { title: '  Title  ', authors: [{ name: '  Author  ' }] } as ImportConfirmItem['metadata'],
    }]);
    expect(r.survivors).toHaveLength(1);
    expect(r.survivors[0]!.path).toBe('/a');
    expect(r.survivors[0]!.title).toBe('Title');
    expect(r.survivors[0]!.metadata!.title).toBe('Title');
    expect(r.survivors[0]!.metadata!.authors[0]!.name).toBe('Author');
  });

  it('drops excluded rows BEFORE ordinal compaction — survivors keep no gap and map to source indexes', () => {
    const rows = [
      valid('/keep1'),
      withMeta('/bad', { coverUrl: 'nope' }), // invalid
      valid('/keep2'),
      withMeta('/big', { authors: [{ name: 'a'.repeat(513) }] }), // oversize
      valid('/keep3'),
    ];
    const r = classifySubmission(rows);
    expect(r.survivors.map((s) => s.path)).toEqual(['/keep1', '/keep2', '/keep3']);
    expect(r.survivorSourceIndexes).toEqual([0, 2, 4]);
    expect(r.invalidIndexes).toEqual([1]);
    expect(r.oversizeIndexes).toEqual([3]);
    expect(r.invalidCount).toBe(1);
    expect(r.oversizeCount).toBe(1);
  });

  it('freezes the survivor array (immutable single source)', () => {
    const r = classifySubmission([valid('/a')]);
    expect(Object.isFrozen(r.survivors)).toBe(true);
  });

  it('returns all-empty buckets for an empty selection', () => {
    const r = classifySubmission([]);
    expect(r.survivors).toHaveLength(0);
    expect(r.invalidCount).toBe(0);
    expect(r.oversizeCount).toBe(0);
  });
});
