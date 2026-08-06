import { describe, it, expect } from 'vitest';
import { applyOpfOverlay, classifyNarratorSource } from './import-opf-overlay.js';
import type { OpfMetadata } from '../utils/opf-reader.js';
import type { ImportConfirmItem } from './library-scan.service.js';

/**
 * Unit coverage for the overlay's two pure decisions. The end-to-end consequences (which value
 * reaches the persisted row, which rung of the ladder wins) are pinned against real DBs in
 * `import-submission-runner.integration.test.ts` and `import-opf-ladder.integration.test.ts`; this
 * file exists for the edge cases those suites cannot express cheaply.
 */

const EMPTY_OPF: OpfMetadata = {
  title: null, subtitle: null, authors: [], narrators: [], description: null, publisher: null,
  publishedDate: null, asin: null, isbn: null, seriesName: null, seriesPosition: null, genres: [],
};

const opf = (overrides: Partial<OpfMetadata> = {}): OpfMetadata => ({ ...EMPTY_OPF, ...overrides });

describe('classifyNarratorSource (D8)', () => {
  const item = (overrides: Partial<ImportConfirmItem> = {}): ImportConfirmItem =>
    ({ path: '/p', title: 'T', ...overrides });

  it('an OPF narrator is curated regardless of what the wire carried', () => {
    expect(classifyNarratorSource(item({ narrators: ['Wire'] }), opf({ narrators: ['Opf'] }))).toBe('curated');
    expect(classifyNarratorSource(item(), opf({ narrators: ['Opf'] }))).toBe('curated');
  });

  it('wire narrators equal to the matched metadata are the provider proposal', () => {
    const withMeta = item({ narrators: ['A', 'B'], metadata: { title: 'T', authors: [{ name: 'X' }], narrators: ['A', 'B'] } });
    expect(classifyNarratorSource(withMeta, null)).toBe('provider');
  });

  it('equality is order-sensitive and length-sensitive', () => {
    const swapped = item({ narrators: ['B', 'A'], metadata: { title: 'T', authors: [{ name: 'X' }], narrators: ['A', 'B'] } });
    const shorter = item({ narrators: ['A'], metadata: { title: 'T', authors: [{ name: 'X' }], narrators: ['A', 'B'] } });
    expect(classifyNarratorSource(swapped, null)).toBe('curated');
    expect(classifyNarratorSource(shorter, null)).toBe('curated');
  });

  it('equality compares AFTER trim, so incidental padding is not a curation', () => {
    const padded = item({ narrators: [' A ', 'B'], metadata: { title: 'T', authors: [{ name: 'X' }], narrators: ['A', ' B'] } });
    expect(classifyNarratorSource(padded, null)).toBe('provider');
  });

  it('absent metadata makes any non-empty wire narrators differ', () => {
    expect(classifyNarratorSource(item({ narrators: ['A'] }), null)).toBe('curated');
  });

  it('metadata present with no narrators also differs', () => {
    const noProviderNarrators = item({ narrators: ['A'], metadata: { title: 'T', authors: [{ name: 'X' }] } });
    expect(classifyNarratorSource(noProviderNarrators, null)).toBe('curated');
  });

  it.each([
    ['omitted', undefined],
    ['empty', [] as string[]],
  ])('%s wire narrators are `none`', (_label, narrators) => {
    const cleared = item({ ...(narrators !== undefined && { narrators }), metadata: { title: 'T', authors: [{ name: 'X' }], narrators: ['Provider'] } });
    expect(classifyNarratorSource(cleared, null)).toBe('none');
  });
});

describe('applyOpfOverlay', () => {
  it('returns the item by reference when there is no usable sidecar', () => {
    const original: ImportConfirmItem = { path: '/p', title: 'T' };
    const result = applyOpfOverlay(original, null);
    expect(result.item).toBe(original);
    expect(result.item).not.toHaveProperty('metadata');
  });

  it('replaces top-level narrators rather than writing them into metadata', () => {
    const original: ImportConfirmItem = {
      path: '/p', title: 'T', narrators: ['Wire'],
      metadata: { title: 'T', authors: [{ name: 'X' }], narrators: ['Wire'] },
    };
    const { item } = applyOpfOverlay(original, opf({ narrators: ['Opf'] }));
    expect(item.narrators).toEqual(['Opf']);
    // `buildBookCreatePayload` reads item.narrators first, so this is the field that decides.
    expect(item.metadata?.narrators).toEqual(['Wire']);
  });

  it('leaves the ORIGINAL item unmutated', () => {
    const original: ImportConfirmItem = { path: '/p', title: 'T', narrators: ['Wire'] };
    applyOpfOverlay(original, opf({ narrators: ['Opf'], description: 'D' }));
    expect(original.narrators).toEqual(['Wire']);
    expect(original).not.toHaveProperty('metadata');
  });

  it('an OPF with only a title still produces metadata, but never overwrites item.title', () => {
    const { item } = applyOpfOverlay({ path: '/p', title: 'Folder Title' }, opf({ title: 'Opf Title' }));
    expect(item.title).toBe('Folder Title');
    expect(item.metadata).toMatchObject({ title: 'Folder Title', authors: [] });
  });

  it('omits seriesPrimary.position when the OPF carried no index, and keeps a position of 0', () => {
    const withoutPosition = applyOpfOverlay({ path: '/p', title: 'T' }, opf({ seriesName: 'S' }));
    const withZero = applyOpfOverlay({ path: '/p', title: 'T' }, opf({ seriesName: 'S', seriesPosition: 0 }));
    expect(withoutPosition.item.metadata?.seriesPrimary).toEqual({ name: 'S' });
    expect(withZero.item.metadata?.seriesPrimary).toEqual({ name: 'S', position: 0 });
  });
});
