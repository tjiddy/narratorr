import { describe, it, expect } from 'vitest';
import { resolveImportSeries } from './resolve-import-series.js';

// Cover item-first pair locking, whitespace classification, verbatim names, and zero positions.
describe('resolveImportSeries', () => {
  const META = { name: 'Provider Saga', position: 2 };

  const cases: Array<{
    name: string;
    item: { seriesName?: string | null | undefined; seriesPosition?: number | undefined };
    primary: { name?: string; position?: number } | undefined;
    expected: { name: string | undefined; position: number | undefined };
  }> = [
    { name: 'present name + present position → item pair', item: { seriesName: 'Custom Saga', seriesPosition: 7 }, primary: META, expected: { name: 'Custom Saga', position: 7 } },
    { name: 'present name + absent position → item name, NO position (never grafts metadata position)', item: { seriesName: 'Custom Saga' }, primary: META, expected: { name: 'Custom Saga', position: undefined } },
    { name: 'present name + position 0 → item pair, 0 survives', item: { seriesName: 'Custom Saga', seriesPosition: 0 }, primary: META, expected: { name: 'Custom Saga', position: 0 } },
    { name: 'padded non-empty name → item wins, name kept verbatim (" Saga ", not "Saga")', item: { seriesName: ' Saga ', seriesPosition: 3 }, primary: META, expected: { name: ' Saga ', position: 3 } },
    { name: 'absent (omitted) name → defer to metadata pair', item: {}, primary: META, expected: { name: 'Provider Saga', position: 2 } },
    { name: 'empty-string name → treated as absent, defer', item: { seriesName: '' }, primary: META, expected: { name: 'Provider Saga', position: 2 } },
    { name: 'whitespace-only name → treated as absent, defer', item: { seriesName: '   ' }, primary: META, expected: { name: 'Provider Saga', position: 2 } },
    { name: 'null name → treated as absent, defer', item: { seriesName: null }, primary: META, expected: { name: 'Provider Saga', position: 2 } },
    { name: 'absent name + orphan item position → defer, orphan position NOT borrowed onto metadata name', item: { seriesPosition: 9 }, primary: META, expected: { name: 'Provider Saga', position: 2 } },
    { name: 'absent name + metadata position 0 → defer, 0 survives', item: {}, primary: { name: 'Prequels', position: 0 }, expected: { name: 'Prequels', position: 0 } },
    { name: 'absent name + metadata name without position → name only', item: {}, primary: { name: 'Standalone' }, expected: { name: 'Standalone', position: undefined } },
    { name: 'absent name + no metadata primary → both undefined', item: {}, primary: undefined, expected: { name: undefined, position: undefined } },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(resolveImportSeries(c.item, c.primary)).toEqual(c.expected);
    });
  }
});
