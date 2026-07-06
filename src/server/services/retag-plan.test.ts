import { describe, it, expect } from 'vitest';
import { SIMPLE_EXCLUDABLE_FIELDS } from './retag-plan.js';
import { RETAG_EXCLUDABLE_FIELDS } from '../../shared/schemas.js';

describe('retag-plan SIMPLE_EXCLUDABLE_FIELDS', () => {
  // Guard A — binds the server-side string-field diff list to the canonical shared set.
  // `SIMPLE_EXCLUDABLE_FIELDS` covers only the string fields handled uniformly by the
  // populate_missing gate / exclude filter / diff builder; the numeric `seriesPart` and
  // `track` are intentionally special-cased (`!= null` handling so a 0 survives), so they
  // are added back explicitly here rather than expected in the list. Without this guard a
  // new string field could land in the shared set (and the preview) but never get diffed
  // by the apply path — the preview would offer a field the server silently ignores.
  // Mirrors the client `FIELD_ORDER` guard (#1693) and the connector registry schema
  // alignment precedent (src/core/connectors/registry.test.ts).
  it('plus the special-cased seriesPart/track covers exactly the shared RETAG_EXCLUDABLE_FIELDS set', () => {
    expect(new Set([...SIMPLE_EXCLUDABLE_FIELDS, 'seriesPart', 'track'])).toEqual(
      new Set(RETAG_EXCLUDABLE_FIELDS),
    );
  });
});
