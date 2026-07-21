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

  // F13: `itemOfBytes` is byte-exact for ASCII (each padded char adds exactly one UTF-8 byte),
  // so these fixtures let us probe the `> MAX_SUBMISSION_BYTES` comparison at the exact boundary.
  it('F30/F13: a cumulative sum EXACTLY at the cap is allowed (inclusive lower bound)', () => {
    const items = [itemOfBytes('/a', MAX_SUBMISSION_BYTES)];
    expect(cumulativeStagedBytes(items)).toBe(MAX_SUBMISSION_BYTES);
    expect(preflightSubmission(items).kind).toBe('ok');
  });

  it('F30/F13: exactly one byte below the cap is allowed', () => {
    const items = [itemOfBytes('/a', MAX_SUBMISSION_BYTES - 1)];
    expect(cumulativeStagedBytes(items)).toBe(MAX_SUBMISSION_BYTES - 1);
    expect(preflightSubmission(items).kind).toBe('ok');
  });

  it('F30/F13: exactly one byte over the cap is refused with the too-large copy', () => {
    const items = [itemOfBytes('/a', MAX_SUBMISSION_BYTES + 1)];
    expect(cumulativeStagedBytes(items)).toBe(MAX_SUBMISSION_BYTES + 1);
    expect(preflightSubmission(items)).toEqual({ kind: 'byte-budget', bytes: MAX_SUBMISSION_BYTES + 1 });
    expect(PREFLIGHT_COPY.byteBudget).toBe('Selection is too large to import at once — deselect some books');
  });

  it('F30/F13: the boundary is measured in UTF-8 BYTES, not JS chars (multibyte)', () => {
    // 'あ' = 3 UTF-8 bytes. Fill exactly to cap+1 bytes; the CHAR count is ~1/3 of the cap,
    // so a char-length regression would wrongly admit this batch.
    const base = stagedItemBytes({ path: '/m', title: '' });
    const need = MAX_SUBMISSION_BYTES + 1 - base;
    const triples = Math.floor(need / 3);
    const remainderAscii = need - triples * 3;
    const big: StagedImportItem = { path: '/m', title: 'あ'.repeat(triples) + 'x'.repeat(remainderAscii) };
    expect(cumulativeStagedBytes([big])).toBe(MAX_SUBMISSION_BYTES + 1);
    expect(big.title.length).toBeLessThan(MAX_SUBMISSION_BYTES); // char count well under the byte cap
    expect(preflightSubmission([big]).kind).toBe('byte-budget');
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
