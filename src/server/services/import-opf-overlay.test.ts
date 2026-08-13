import { describe, it, expect } from 'vitest';
import { applyOpfOverlay, classifyNarratorSource } from './import-opf-overlay.js';
import type { OpfMetadata } from '../utils/opf-reader.js';
import type { ImportConfirmItem } from './library-scan.service.js';
import type { BookMetadata } from '@core/metadata/index.js';

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

describe('applyOpfOverlay — series precedence (#2296)', () => {
  const OPF = opf({ seriesName: 'Opf Series', seriesPosition: 9 });

  const item = (overrides: Partial<ImportConfirmItem> = {}): ImportConfirmItem =>
    ({ path: '/p', title: 'T', ...overrides });

  const providerMeta = (seriesPrimary?: { name: string; position?: number }): BookMetadata =>
    ({ title: 'T', authors: [{ name: 'A' }], ...(seriesPrimary && { seriesPrimary }) });

  const PROVIDER = { name: 'Provider Series', position: 5 };

  it('row 1: no item series → the OPF pair replaces the provider primary in metadata', () => {
    const { item: next } = applyOpfOverlay(item({ metadata: providerMeta(PROVIDER) }), OPF);
    expect(next.metadata?.seriesPrimary).toStrictEqual({ name: 'Opf Series', position: 9 });
    expect(next).not.toHaveProperty('seriesName');
  });

  it('row 2a: an item pair with NO metadata at all is a genuine assertion and survives', () => {
    const { item: next } = applyOpfOverlay(item({ seriesName: 'Folder Series', seriesPosition: 2 }), OPF);
    expect(next.seriesName).toBe('Folder Series');
    expect(next.seriesPosition).toBe(2);
  });

  it('row 2b: metadata present but carrying NO primary leaves nothing to mirror, so the item pair survives', () => {
    const { item: next } = applyOpfOverlay(
      item({ seriesName: 'Folder Series', seriesPosition: 2, metadata: providerMeta() }),
      OPF,
    );
    expect(next.seriesName).toBe('Folder Series');
    expect(next.seriesPosition).toBe(2);
    // The metadata write still lands; resolveImportSeries simply prefers the item pair.
    expect(next.metadata?.seriesPrimary).toStrictEqual({ name: 'Opf Series', position: 9 });
  });

  it('row 3: an item series DIFFERING from the provider primary is a genuine assertion and survives', () => {
    const { item: next } = applyOpfOverlay(
      item({ seriesName: 'Folder Series', seriesPosition: 2, metadata: providerMeta(PROVIDER) }),
      OPF,
    );
    expect(next.seriesName).toBe('Folder Series');
    expect(next.seriesPosition).toBe(2);
  });

  it('row 4: an item pair mirroring the provider is replaced by the OPF pair', () => {
    const { item: next } = applyOpfOverlay(
      item({ seriesName: 'Provider Series', seriesPosition: 5, metadata: providerMeta(PROVIDER) }),
      OPF,
    );
    expect(next.seriesName).toBe('Opf Series');
    expect(next.seriesPosition).toBe(9);
  });

  it('row 5: the client hybrid (provider name + FOLDER position) is a mirror — identity is the name alone', () => {
    const { item: next } = applyOpfOverlay(
      item({ seriesName: 'Provider Series', seriesPosition: 2, metadata: providerMeta({ name: 'Provider Series' }) }),
      OPF,
    );
    expect(next.seriesName).toBe('Opf Series');
    expect(next.seriesPosition).toBe(9);
  });

  it('row 6: an OPF with no series touches neither the item pair nor the provider primary', () => {
    const { item: next } = applyOpfOverlay(
      item({ seriesName: 'Provider Series', seriesPosition: 5, metadata: providerMeta(PROVIDER) }),
      opf({ description: 'D' }),
    );
    expect(next.seriesName).toBe('Provider Series');
    expect(next.seriesPosition).toBe(5);
    expect(next.metadata?.seriesPrimary).toStrictEqual(PROVIDER);
  });

  it('the accepted ambiguity: a folder that genuinely agrees with the provider loses to the OPF', () => {
    // Indistinguishable from the client mirror on the wire; documented in the precedence contract.
    const { item: next } = applyOpfOverlay(
      item({ seriesName: 'Provider Series', seriesPosition: 5, metadata: providerMeta(PROVIDER) }),
      OPF,
    );
    expect(next.seriesName).toBe('Opf Series');
  });

  it('mirror equality compares AFTER trim, and is case-SENSITIVE', () => {
    const padded = applyOpfOverlay(
      item({ seriesName: ' Provider Series ', metadata: providerMeta(PROVIDER) }),
      OPF,
    );
    const recased = applyOpfOverlay(
      item({ seriesName: 'provider series', metadata: providerMeta(PROVIDER) }),
      OPF,
    );
    expect(padded.item.seriesName).toBe('Opf Series');
    expect(recased.item.seriesName).toBe('provider series');
  });

  it('a whitespace-only item series is absent, not a mirror — it is left for resolveImportSeries to ignore', () => {
    const { item: next } = applyOpfOverlay(
      item({ seriesName: '   ', metadata: providerMeta(PROVIDER) }),
      OPF,
    );
    expect(next.seriesName).toBe('   ');
    expect(next.metadata?.seriesPrimary).toStrictEqual({ name: 'Opf Series', position: 9 });
  });

  it('replaces the mirrored pair atomically: an OPF with no index DELETES the stale position', () => {
    const { item: next } = applyOpfOverlay(
      item({ seriesName: 'Provider Series', seriesPosition: 5, metadata: providerMeta(PROVIDER) }),
      opf({ seriesName: 'Opf Series' }),
    );
    expect(next.seriesName).toBe('Opf Series');
    expect(next).not.toHaveProperty('seriesPosition');
    expect(next.metadata?.seriesPrimary).toStrictEqual({ name: 'Opf Series' });
  });

  it.each([
    ['zero', 0],
    ['a decimal', 3.5],
  ])('%s is a valid OPF position and replaces the provider position at BOTH write sites', (_label, seriesPosition) => {
    const { item: next } = applyOpfOverlay(
      item({ seriesName: 'Provider Series', seriesPosition: 5, metadata: providerMeta(PROVIDER) }),
      opf({ seriesName: 'Opf Series', seriesPosition }),
    );
    expect(next.seriesPosition).toBe(seriesPosition);
    expect(next.metadata?.seriesPrimary).toStrictEqual({ name: 'Opf Series', position: seriesPosition });
  });

  it('leaves the ORIGINAL item unmutated when the series write touches the item', () => {
    const original = item({ seriesName: 'Provider Series', seriesPosition: 5, metadata: providerMeta(PROVIDER) });
    applyOpfOverlay(original, opf({ seriesName: 'Opf Series' }));
    expect(original.seriesName).toBe('Provider Series');
    expect(original.seriesPosition).toBe(5);
    expect(original.metadata?.seriesPrimary).toStrictEqual(PROVIDER);
  });

  it('classifies against the PRE-overlay primary: the overlaid metadata must not feed the comparison', () => {
    // Reading the post-overlay primary makes every mirror look non-mirrored and no-ops the fix.
    const { item: next } = applyOpfOverlay(
      item({ seriesName: 'Opf Series', seriesPosition: 1, metadata: providerMeta(PROVIDER) }),
      OPF,
    );
    // The item asserted the OPF's own name, which never equalled the provider's — a genuine assertion.
    expect(next.seriesPosition).toBe(1);
  });

  it('the author/asin/isbn fill-the-gap rules are untouched by the series change', () => {
    const { item: next } = applyOpfOverlay(
      item({ seriesName: 'Provider Series', metadata: { title: 'T', authors: [{ name: 'Provider Author' }], asin: 'B0PROV', isbn: '111' } }),
      opf({ seriesName: 'Opf Series', authors: ['Opf Author'], asin: 'B0OPF', isbn: '999' }),
    );
    expect(next.metadata?.authors).toStrictEqual([{ name: 'Provider Author' }]);
    expect(next.metadata?.asin).toBe('B0PROV');
    expect(next.metadata?.isbn).toBe('111');
  });
});
