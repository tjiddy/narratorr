import { describe, it, expect } from 'vitest';
import { EXPECTED_COUNT_MAX, MAX_SUBMISSION_BYTES, type StagedImportItem } from '../../../core/import-staging/schemas.js';
import { preflightSubmission, cumulativeStagedBytes, stagedItemBytes, PREFLIGHT_COPY } from './preflight.js';

const item = (path: string): StagedImportItem => ({ path, title: 'T' });
/** A staged item whose serialized bytes are approximately `bytes`. */
const itemOfBytes = (path: string, bytes: number): StagedImportItem => {
  const base = stagedItemBytes(item(path));
  return { path: path + 'x'.repeat(Math.max(0, bytes - base)), title: 'T' };
};

describe('stagedItemBytes / cumulativeStagedBytes', () => {
  it('measures UTF-8 bytes matching the server Buffer.byteLength', () => {
    const it0: StagedImportItem = { path: '/日本語', title: '📚' };
    expect(stagedItemBytes(it0)).toBe(Buffer.byteLength(JSON.stringify(it0), 'utf8'));
  });
  it('sums per-item canonical bytes', () => {
    const items = [item('/a'), item('/b')];
    expect(cumulativeStagedBytes(items)).toBe(stagedItemBytes(items[0]!) + stagedItemBytes(items[1]!));
  });
});

describe('preflightSubmission — individual gates', () => {
  it('returns ok for a small surviving set', () => {
    expect(preflightSubmission([item('/a'), item('/b')])).toEqual({ kind: 'ok' });
  });

  it('F39: zero survivors short-circuits', () => {
    expect(preflightSubmission([])).toEqual({ kind: 'zero-survivors' });
  });

  it('F31: exactly EXPECTED_COUNT_MAX survivors is allowed', () => {
    const items = Array.from({ length: EXPECTED_COUNT_MAX }, (_, i) => item(`/${i}`));
    expect(preflightSubmission(items).kind).toBe('ok');
  });

  it('F31: one over EXPECTED_COUNT_MAX is refused with the count copy', () => {
    const items = Array.from({ length: EXPECTED_COUNT_MAX + 1 }, (_, i) => item(`/${i}`));
    const gate = preflightSubmission(items);
    expect(gate).toEqual({ kind: 'row-count', count: EXPECTED_COUNT_MAX + 1 });
    expect(PREFLIGHT_COPY.rowCount).toBe('Too many books selected (max 10,000) — import in smaller batches');
  });

  it('F30: cumulative bytes over MAX_SUBMISSION_BYTES is refused with the too-large copy', () => {
    // ~70 items of ~1 MiB each ⇒ over 64 MiB, well under the 10,000-row bound.
    const perItem = 1024 * 1024;
    const count = Math.ceil(MAX_SUBMISSION_BYTES / perItem) + 2;
    const items = Array.from({ length: count }, (_, i) => itemOfBytes(`/${i}`, perItem));
    const gate = preflightSubmission(items);
    expect(gate.kind).toBe('byte-budget');
    expect(PREFLIGHT_COPY.byteBudget).toBe('Selection is too large to import at once — deselect some books');
  });

  it('F30: a byte sum at/just below the cap is allowed', () => {
    const perItem = 1024 * 1024;
    const count = Math.floor(MAX_SUBMISSION_BYTES / perItem) - 1; // safely below
    const items = Array.from({ length: count }, (_, i) => itemOfBytes(`/${i}`, perItem));
    expect(cumulativeStagedBytes(items)).toBeLessThanOrEqual(MAX_SUBMISSION_BYTES);
    expect(preflightSubmission(items).kind).toBe('ok');
  });
});

describe('preflightSubmission — precedence (F41)', () => {
  it('reports zero-survivors before any other gate', () => {
    expect(preflightSubmission([])).toEqual({ kind: 'zero-survivors' });
  });

  it('reports row-count before byte-budget when BOTH are exceeded', () => {
    // 10,001 items each ~7 KiB ⇒ over 10,000 rows AND over 64 MiB.
    const items = Array.from({ length: EXPECTED_COUNT_MAX + 1 }, (_, i) => itemOfBytes(`/${i}`, 7 * 1024));
    expect(cumulativeStagedBytes(items)).toBeGreaterThan(MAX_SUBMISSION_BYTES);
    expect(preflightSubmission(items)).toEqual({ kind: 'row-count', count: EXPECTED_COUNT_MAX + 1 });
  });
});
