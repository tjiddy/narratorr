import { describe, it, expect } from 'vitest';
import { resolveImportSeries } from './resolve-import-series.js';

// Single shared resolver (#1927 F7) — the authoritative item-first, two-state,
// pair-locked decision both server sites (buildBookCreatePayload + copyToLibrary)
// call. Table-driven over { present, absent, whitespace-only, padded-non-empty } ×
// { position present, absent, 0 } against a FIXED metadata primary, so a drift on
// any edge (whitespace, position-0, padded name, orphan position) is caught here.
describe('resolveImportSeries', () => {
  const META = { name: 'Provider Saga', position: 2 };

  const cases: Array<{
    name: string;
    item: { seriesName?: string | null | undefined; seriesPosition?: number | undefined };
    primary: { name?: string; position?: number } | undefined;
    expected: { name: string | undefined; position: number | undefined };
  }> = [
    // ── Present item name → item wins for BOTH fields (pair-lock) ──
    { name: 'present name + present position → item pair', item: { seriesName: 'Custom Saga', seriesPosition: 7 }, primary: META, expected: { name: 'Custom Saga', position: 7 } },
    { name: 'present name + absent position → item name, NO position (never grafts metadata position)', item: { seriesName: 'Custom Saga' }, primary: META, expected: { name: 'Custom Saga', position: undefined } },
    { name: 'present name + position 0 → item pair, 0 survives', item: { seriesName: 'Custom Saga', seriesPosition: 0 }, primary: META, expected: { name: 'Custom Saga', position: 0 } },
    // ── Padded-non-empty → classified present, name preserved VERBATIM (trim classifies, does not rewrite) ──
    { name: 'padded non-empty name → item wins, name kept verbatim (" Saga ", not "Saga")', item: { seriesName: ' Saga ', seriesPosition: 3 }, primary: META, expected: { name: ' Saga ', position: 3 } },
    // ── Absent item name (omit / empty / whitespace) → defer BOTH to metadata ──
    { name: 'absent (omitted) name → defer to metadata pair', item: {}, primary: META, expected: { name: 'Provider Saga', position: 2 } },
    { name: 'empty-string name → treated as absent, defer', item: { seriesName: '' }, primary: META, expected: { name: 'Provider Saga', position: 2 } },
    { name: 'whitespace-only name → treated as absent, defer', item: { seriesName: '   ' }, primary: META, expected: { name: 'Provider Saga', position: 2 } },
    { name: 'null name → treated as absent, defer', item: { seriesName: null }, primary: META, expected: { name: 'Provider Saga', position: 2 } },
    // Absent name + orphan item position → position dropped (pair-lock), metadata pair used.
    { name: 'absent name + orphan item position → defer, orphan position NOT borrowed onto metadata name', item: { seriesPosition: 9 }, primary: META, expected: { name: 'Provider Saga', position: 2 } },
    // Defer path preserves position-0 from metadata (?? semantics).
    { name: 'absent name + metadata position 0 → defer, 0 survives', item: {}, primary: { name: 'Prequels', position: 0 }, expected: { name: 'Prequels', position: 0 } },
    // Defer path with metadata name but no position → name only.
    { name: 'absent name + metadata name without position → name only', item: {}, primary: { name: 'Standalone' }, expected: { name: 'Standalone', position: undefined } },
    // Absent both sides → both undefined.
    { name: 'absent name + no metadata primary → both undefined', item: {}, primary: undefined, expected: { name: undefined, position: undefined } },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(resolveImportSeries(c.item, c.primary)).toEqual(c.expected);
    });
  }
});
